var fs = require('fs'),
    path = require('path'),
    Tile = require('./Tile.js').Tile,
    GeoUtils = require('./GeoUtils.js'),
    Utils = require('./Utils.js'),
    VectorBasedTile = require('./VectorBasedTile.js').Tile,
    MetatileBasedTile = require('./MetatileBasedTile.js').Tile,
    XRayTile = require('./XRayTile.js').Tile;
var TILEPREFIX = 'tile';

class ProjectServer {
    constructor(project, parent) {
        this.project = project;
        this.parent = parent;
        this._pollQueue = [];
        var self = this,
            onChange = function (type, filename) {
                if (filename) {
                    if (filename.indexOf('.') === 0) return;
                    self.project.config.log('File', filename, 'changed on disk');
                }
                self.addToPollQueue({isDirty: true});
            };
        this.project.when('loaded', function () {
            try {
                self.initMapPools();
            } catch (err) {
                console.log(err.message);
                self.addToPollQueue({error: err.message});
            }
            fs.watch(self.project.filepath, onChange);
            for (var style of self.project.mml.Stylesheet) {
                fs.watch(path.join(project.root, style.id), onChange);
            }
        });
        this.project.load();
    };

    serve(uri, req, res) {
        var urlpath = uri.pathname,
            els = urlpath.split('/'),
            self = this;
        if (!urlpath) this.parent.redirect(this.project.getUrl(), res);
        else if (urlpath === '/') this.main(res);
        else if (urlpath === '/config/') this.config(res);
        else if (urlpath === '/poll/') this.poll(res);
        else if (urlpath === '/export/') this.export(res, uri.query);
        else if (urlpath === '/reload/') this.reload(res);
        else if (urlpath === '/clear-vector-cache/') this.clearVectorCache(res);
        else if (this.parent.hasProjectRoute(urlpath)) this.parent.serveProjectRoute(urlpath, uri, req, res, this.project);
        else if (els[1] === TILEPREFIX && els.length === 5) this.project.when('loaded', function tile () {self.serveTile(els[2], els[3], els[4], res, uri.query);});
        else if (els[1] === 'query' && els.length >= 5) this.project.when('loaded', function query () {self.queryTile(els[2], els[3], els[4], res, uri.query);});
        else this.parent.notFound(urlpath, res);
    };

    serveTile(z, x, y, res, query) {
        y = y.split('.');
        var ext = y[1];
        y = y[0];
        var func;
        if (ext === 'json') func = this.jsontile;
        else if (ext === 'pbf') func = this.pbftile;
        else if (ext === 'xray') func = this.xraytile;
        else func = this.tile;
        try {
            func.call(this, z, x, y, res, query);
        } catch (err) {
            this.raise('Project not loaded properly.', res);
        }
    };

    tile(z, x, y, res, query) {
        query = query || {};
        var self = this,
            yels = y.split('@'),
            y = yels[0],
            scale = yels[1] ? parseInt(yels[1], 10) : 1,
            mapScale = scale * (this.project.mml.scale || 1),
            size = this.project.tileSize() * scale,  // retina?
            // Let the UI override the Mapnik buffer size per request; fall back
            // to the project default.
            buffer = (query.buffer !== undefined && query.buffer !== '') ? parseInt(query.buffer, 10) : this.project.bufferSize();
        if (isNaN(buffer)) buffer = self.project.bufferSize();
        // If the client pans or zooms away it aborts the <img> request and the
        // socket closes. Record that on a small object shared with the renderer so
        // a fast pan/zoom doesn't pile up stale renders ahead of the tiles that
        // are visible now (and so a stale render can be interrupted, see below).
        var label = z + '/' + x + '/' + y + (scale === 2 ? '@2x' : ''),
            t0 = Date.now(),
            request = {canceled: false, onCancel: null};
        res.on('close', function () {
            if (request.canceled) return;
            request.canceled = true;
            if (request.onCancel) request.onCancel();  // wake a lock wait, or let the pool preempt a stale render
        });

        // Vector-source projects render from a vector tile in-process (out of
        // scope for killable workers); keep the existing pooled-map path.
        if (this.project.mml.source) {
            return this.tileFromSource(z, x, y, scale, mapScale, size, buffer, request, label, t0, res);
        }

        // Raster path: render the metatile in a killable child process so a stale
        // render is reclaimed when the client navigates away (see RenderPool). A
        // worker is only used at the actual render point; cache hits and lock
        // waits never tie one up. The worker writes the metatile to disk and we
        // crop this tile's view here, in-process.
        var tile = new MetatileBasedTile(z, x, y, {
            size: size,
            metatile: self.project.metatile(),
            mapScale: mapScale,
            buffer_size: buffer,
            request: request,
            pool: self.renderPoolFor(scale)
        });
        tile.render(self.project, function (err, png) {
            if (request.canceled) {
                console.warn('[tile] canceled', label, '(' + (Date.now() - t0) + 'ms)');
                return;  // socket already closed; a finished render still warmed the cache
            }
            if (err) return self.raise(err.message, res);
            if (!png) return;  // nothing to send
            console.warn('[tile] ok', label, '(' + (Date.now() - t0) + 'ms)');
            res.writeHead(200, {'Content-Type': 'image/png', 'Content-Length': png.length});
            res.end(png);
        });
    };

    tileFromSource(z, x, y, scale, mapScale, size, buffer, request, label, t0, res) {
        var self = this,
            mapPool = scale === 2 ? this.retinaPool : this.mapPool;
        mapPool.acquire(function (err, map) {
            var release = function () {mapPool.release(map);};
            if (err) return self.raise(err.message, res);
            if (request.canceled) {
                console.warn('[tile] canceled', label, '(skipped, ' + (Date.now() - t0) + 'ms queued)');
                return release();
            }
            // Apply on the pooled map (datasource query buffer) and pass it
            // through to the tile (raster render buffer). Maps are pooled and
            // reused, so set this explicitly on every request.
            map.bufferSize = buffer;
            var tile = new VectorBasedTile(z, x, y, {size: size, metatile: self.project.metatile(), mapScale: mapScale, buffer_size: buffer, request: request});
            return tile.render(self.project, map, function (err, im) {
                if (request.canceled) {
                    console.warn('[tile] canceled', label, '(dropped, held a map ' + (Date.now() - t0) + 'ms)');
                    return release();
                }
                if (err) return self.raise(err.message, res, release);
                im.encode('png', (function (err, buffer) {
                    if (err) return self.raise(err.message, res, release);
                    console.warn('[tile] ok', label, '(' + (Date.now() - t0) + 'ms)');
                    res.writeHead(200, {'Content-Type': 'image/png', 'Content-Length': buffer.length});
                    res.write(buffer);
                    res.end();
                    release();
                }).bind(im));
            });
        });
    };

    jsontile(z, x, y, res, query) {
        var self = this;
        this.vectorMapPool.acquire(function (err, map) {
            var release = function () {self.vectorMapPool.release(map);};
            if (err) return self.raise(err.message, res);
            var tileClass = self.project.mml.source ? VectorBasedTile : Tile;
            var tile = new tileClass(z, x, y, {metatile: 1});
            return tile.renderToVector(self.project, map, function (err, tile) {
                if (err) return self.raise(err.message, res, release);
                var content;
                try {
                    content = tile.toGeoJSON(query.layer || '__all__');
                } catch (err) {
                    // This layer is not visible in this tile,
                    // return an empty geojson;
                    content = '{"type": "FeatureCollection", "features": []}';
                }
                if (typeof content !== 'string') content = JSON.stringify(content);  // Mapnik 3.1.0 now returns a string
                res.writeHead(200, {'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*'});
                res.write(content);
                res.end();
                release();
            });
        });
    };

    pbftile(z, x, y, res) {
        var self = this;
        this.vectorMapPool.acquire(function (err, map) {
            var release = function () {self.vectorMapPool.release(map);};
            if (err) return self.raise(err.message, res);
            var tileClass = self.project.mml.source ? VectorBasedTile : Tile;
            try {
                var tile = new tileClass(z, x, y, {metatile: 1});
            } catch (err) {
                return self.raise(err.message, res, release);
            }
            return tile.renderToVector(self.project, map, function (err, tile) {
                if (err) return self.raise(err.message, res, release);
                var content = tile.getData();
                res.writeHead(200, {'Content-Type': 'application/x-protobuf', 'Access-Control-Allow-Origin': '*'});
                res.write(content);
                res.end();
                release();
            });
        });
    };

    xraytile(z, x, y, res, query) {
        var self = this;
        this.vectorMapPool.acquire(function (err, map) {
            var release = function () {self.vectorMapPool.release(map);};
            if (err) return self.raise(err.message, res, release);
            var tileClass = self.project.mml.source ? VectorBasedTile : Tile;
            var tile = new tileClass(z, x, y, {metatile: 1, buffer_size: 1});
            return tile.renderToVector(self.project, map, function (err, t) {
                if (err) return self.raise(err.message, res, release);
                if (t.getData().length == 0) {
                    res.writeHead(204, {'Content-Type': 'image/png', 'Content-Length': 0});
                    res.end();
                    release();
                    return;
                }
                var xtile = new XRayTile(z, x, y, t.getData(), {layer: query.layer, background: query.background});
                xtile.render(self.project, map, function (err, im) {
                    if (err) return self.raise(err.message, res, release);
                    im.encode('png', function (err, buffer) {
                        if (err) return self.raise(err.message, res, release);
                        res.writeHead(200, {'Content-Type': 'image/png', 'Content-Length': buffer.length});
                        res.write(buffer);
                        res.end();
                        release();
                    });
                });
            });
        });
    };

    queryTile(z, lat, lon, res, query) {
        var self = this;
        lat = parseFloat(lat);
        lon = parseFloat(lon);
        this.vectorMapPool.acquire(function (err, map) {
            var release = function () {self.vectorMapPool.release(map);};
            var xy = GeoUtils.zoomLatLngToXY(z, lat, lon),
                x = xy[0], y = xy[1];
            if (err) return self.raise(err.message, res, release);
            var tileClass = self.project.mml.source ? VectorBasedTile : Tile;
            var tile = new tileClass(z, x, y, {metatile: 1});
            return tile.renderToVector(self.project, map, function (err, t) {
                if (err) return self.raise(err.message, res, release);
                var options = {tolerance: parseInt(query.tolerance, 10) || 100};
                var results = [], layers = [];
                var doQuery = function (results, options) {
                    var features = t.query(lon, lat, options);
                    for (var i = 0; i < features.length; i++) {
                        results.push({
                            distance: features[i].distance,
                            layer: features[i].layer,
                            attributes: features[i].attributes()
                        });
                    }
                };
                if (query.layer && query.layer !== '__all__') layers = query.layer.split(',');
                if (!layers.length) {
                    doQuery(results, options);
                } else {
                    for (var i = 0; i < layers.length; i++) {
                        options.layer = layers[i];
                        doQuery(results, options);
                    }
                }
                res.writeHead(200, {'Content-Type': 'application/javascript'});
                res.write(JSON.stringify(results));
                res.end();
                release();
            });
        });
    };

    config(res) {
        res.writeHead(200, {
            'Content-Type': 'application/javascript'
        });
        var tpl = 'L.K.Config.project = %;';
        res.write(tpl.replace('%', JSON.stringify(this.project.toFront())));
        res.end();
    };

    clearVectorCache(res) {
        var self = this;
        Utils.cleardir(this.project.getVectorCacheDir(), function (err) {
            if (err) return self.raise(err.message, res);
            res.writeHead(204, {
                'Content-Length': 0,
                'Content-Type': 'text/html'  // Firefox complains without Content-Type, even if the body is empty.
            });
            res.end();
        });
    };

    export(res, options) {
        var self = this;
        this.project.export(options, function (err, buffer) {
            if (err) return self.raise(err.message, res);
            res.writeHead(200, {
                'Content-Disposition': 'attachment; filename: "xxxx"'
            });
            res.write(buffer);
            res.end();
        });
    };

    main(res) {
        var js = this.project.config._js.reduce(function(a, b) {
            return a + '<script src="' + b + '"></script>\n';
        }, '');
        var css = this.project.config._css.reduce(function(a, b) {
            return a + '<link rel="stylesheet" href="' + b + '" />\n';
        }, '');
        fs.readFile(path.join(kosmtik.src, 'front/project.html'), {encoding: 'utf8'}, function(err, data) {
            if(err) throw err;
            data = data.replace('%%JS%%', js);
            data = data.replace('%%CSS%%', css);
            res.writeHead(200, {
                'Content-Type': 'text/html',
                'Content-Length': data.length
            });
            res.end(data);
        });
    };

    addToPollQueue(message) {
        if (this._pollQueue.indexOf(message) === -1) this._pollQueue.push(message);
    };

    raise(message, res, cb) {
        console.trace();
        console.log(message);
        if (message) this.addToPollQueue({error: message});
        res.writeHead(500);
        res.end();
        if (cb) cb();
    };

    poll(res) {
        var data = '', len;
        if (this._pollQueue.length) {
            data = JSON.stringify(this._pollQueue);
            this._pollQueue = [];
        }
        len = Buffer.byteLength(data, 'utf8');
        res.writeHead(len ? 200 : 204, {
            'Content-Type': 'application/json',
            'Content-Length': len,
            'Cache-Control': 'private, no-cache, must-revalidate'
        });
        res.end(data);
    };

    reload(res) {
        var self = this;
        // A stylesheet save can fire several reloads in a row; serialize them so
        // we don't tear down and re-init the pools concurrently.
        if (this._reloading) {
            res.writeHead(200, {'Content-Type': 'application/json'});
            return res.end(JSON.stringify(this.project.toFront()));
        }
        this._reloading = true;
        try {
            this.project.reload();
        } catch (err) {
            this._reloading = false;
            return this.raise(err.message, res);
        }
        this.project.when('loaded', function () {
            // Kill all render workers and drain the in-process pools before
            // respawning against the freshly compiled XML.
            self.destroyPools();
            try {
                self.initMapPools();
            } catch (err) {
                self._reloading = false;
                return self.raise(err.message, res);
            }
            self._reloading = false;
            res.writeHead(200, {
                'Content-Type': 'application/json'
            });
            res.end(JSON.stringify(self.project.toFront()));
        });
    };

    initMapPools() {
        // Used by the vector paths (json/pbf/xray/query) for both source and
        // non-source projects.
        this.vectorMapPool = this.project.createMapPool({size: 256});
        if (this.project.mml.source) {
            // Vector-source raster tiles render in-process (out of scope for
            // killable workers).
            this.mapPool = this.project.createMapPool();
            this.retinaPool = this.project.createMapPool({scale: 2});
        } else {
            // Raster tiles render in killable child processes. The retina pool is
            // created lazily on the first @2x request — it's often unused and
            // each worker holds a full map + Postgres connections.
            this.renderPool = this.project.createRenderPool({targetSize: this.renderWorkers(), killAfterMs: this.renderKillAfter()});
        }
    };

    renderPoolFor(scale) {
        if (scale !== 2) return this.renderPool;
        if (!this.retinaRenderPool) {
            this.retinaRenderPool = this.project.createRenderPool({scale: 2, targetSize: this.renderWorkers(), killAfterMs: this.renderKillAfter()});
        }
        return this.retinaRenderPool;
    };

    destroyPools() {
        if (this.renderPool) this.renderPool.destroyAll();
        if (this.retinaRenderPool) this.retinaRenderPool.destroyAll();
        this.renderPool = null;
        this.retinaRenderPool = null;
        [this.mapPool, this.retinaPool, this.vectorMapPool].forEach(function (pool) {
            if (pool) pool.drain(function () { pool.destroyAllNow(); });
        });
        this.mapPool = null;
        this.retinaPool = null;
        this.vectorMapPool = null;
    };

    // Synchronous, best-effort SIGKILL of every render worker, for the process
    // 'exit' handler (which cannot await the graceful destroyPools path).
    killWorkers() {
        if (this.renderPool) this.renderPool.killChildren();
        if (this.retinaRenderPool) this.retinaRenderPool.killChildren();
    };

    // Resolve config: CLI option -> user config -> default. parseInt so a 0
    // (no-floor) value survives, unlike a truthiness check.
    renderWorkers() {
        var c = this.project.config,
            o = c.parsed_opts.render_workers,
            v = parseInt(o !== undefined ? o : c.getFromUserConfig('renderWorkers', 6), 10);
        return (isNaN(v) || v < 1) ? 6 : v;
    };

    renderKillAfter() {
        var c = this.project.config,
            o = c.parsed_opts.render_kill_after,
            v = parseInt(o !== undefined ? o : c.getFromUserConfig('renderKillAfter', 5000), 10);
        return isNaN(v) ? 5000 : v;  // 0 is valid: kill as soon as a visible tile needs the slot
    };
}

exports = module.exports = { ProjectServer };
