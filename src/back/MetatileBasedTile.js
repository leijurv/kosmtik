var fs = require('fs'),
    mapnik = require('@mapnik/mapnik'),
    Tile = require('./Tile.js').Tile,
    path = require('path');

class MetatileBasedTile {
    constructor(z, x, y, options) {
        this.z = z;
        this.x = x;
        this.y = y;
        this.metatile = options.metatile || 1;
        this.metaX = Math.floor(x / this.metatile);
        this.metaY = Math.floor(y / this.metatile);
        this.format = options.format || 'png';
        this.size = options.size || 256;
        this.mapScale = options.mapScale || 1;
        this.buffer_size = options.buffer_size || 0;
        // Shared cancellation flag (see ProjectServer.tile): lets us stop waiting
        // on another request's metatile lock once the client has navigated away.
        this.request = options.request || {canceled: false, onCancel: null};
        this.options = options;
    }

    render(project, map, cb) {
        // The buffer size is part of the cache key: a metatile rendered with a
        // different buffer is a different image, so changing the buffer must not
        // serve a stale cached metatile.
        var self = this, basePath = project.getMetaCacheDir(),
            baseName = this.z + '.' + this.metaX + '.' + this.metaY + 'x' + this.mapScale + 'b' + this.buffer_size,
            metaPath = path.join(basePath,  baseName + '.meta'),
            lockPath = path.join(basePath, baseName + '.lock');

        // Client already gave up before we got here: don't start.
        if (self.request.canceled) return cb(null, null);

        fs.readFile(metaPath, function (err, data) {
            if (err) {
                if (err.code !== 'ENOENT') return cb(err);
                fs.writeFile(lockPath, '', {flag: 'wx'}, function (err) {
                    if (err && err.code === 'EEXIST') {
                        // Someone else is already rendering this metatile. Wait for
                        // them — but if the client gives up while we wait, stop
                        // waiting and hand the pooled map back right away instead of
                        // holding it for the whole of the other render.
                        var watcher, finished = false;
                        var stop = function (retry) {
                            if (finished) return;
                            finished = true;
                            self.request.onCancel = null;
                            if (watcher) { try { watcher.close(); } catch (e) {} }
                            if (retry) self.render(project, map, cb);  // lock cleared -> now a cache hit
                            else cb(null, null);                       // canceled -> give up, free the map
                        };
                        try {
                            watcher = fs.watch(lockPath);
                            watcher.on('change', function (event) {  // Someone else is building the metatile, keep calm and wait.
                                if (event === 'rename') stop(true);  // lock has been deleted
                            });
                        } catch (err) {
                            if (err.code !== 'ENOENT') return cb(err);
                            return stop(true);  // lock vanished between writeFile and watch
                        }
                        self.request.onCancel = function () { stop(false); };
                        if (self.request.canceled) stop(false);  // already canceled before we registered
                    } else if (err) {
                        return cb(err);
                    } else  {
                        self.renderMetatile(metaPath, project, map, function (err, buffer) {
                            fs.unlink(lockPath, function (err2) {
                                if (err) return cb(err);
                                if (err2 && err2.code !== 'ENOENT') return cb(err2);
                                self.extractFromBytes(buffer, cb);
                            });
                        });
                    }
                });
            } else {
                self.extractFromBytes(data, cb);
            }
        });
    }

    extractFromBytes(buffer, cb) {
        var self = this;
        mapnik.Image.fromBytes(buffer, function (err, im) {
            if (err) return cb(err);
            var view = im.view(self.size * (self.x % self.metatile), self.size * (self.y % self.metatile), self.size, self.size);
            cb(null, view);
        });
    }

    renderMetatile(metaPath, project, map, cb) {
        var self = this;
        var tile = new Tile(self.z, self.metaX, self.metaY, {size: this.metatile * this.size, scale: this.metatile, mapScale: this.mapScale, buffer_size: this.buffer_size});
        tile.render(project, map, function (err, im) {
            if (err) return cb(err);
            im.encode(self.format, function (err, buffer) {
                if (err) return cb(err);
                fs.writeFile(metaPath, buffer, {flag: 'wx'}, function (err) {
                    if (err && err.code !== 'EEXIST') return cb(err);
                    cb(null, buffer);
                });
            });
        });
    };
}

exports = module.exports = { Tile: MetatileBasedTile };
