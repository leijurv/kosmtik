var fs = require('fs'),
    mapnik = require('@mapnik/mapnik'),
    path = require('path');

// Counter to keep this process's in-flight temp files unique.
var tmpCounter = 0;

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
        // Pool of killable render workers (see RenderPool). The actual Mapnik
        // render runs in a child process so it can be SIGKILLed; all cache/lock
        // bookkeeping stays here in the parent so a killed worker can never strand
        // a .lock or leave a half-written .meta.
        this.pool = options.pool;
        this.options = options;
    }

    // cb(err, pngBuffer). pngBuffer is this tile's PNG on success; null when the
    // client gave up (request.canceled) — the caller checks request.canceled
    // before responding.
    render(project, cb) {
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
                        // waiting and return right away instead of blocking on the
                        // whole of the other render.
                        var watcher, finished = false;
                        var stop = function (retry) {
                            if (finished) return;
                            finished = true;
                            self.request.onCancel = null;
                            if (watcher) { try { watcher.close(); } catch (e) {} }
                            if (retry) self.render(project, cb);  // lock cleared -> now a cache hit
                            else cb(null, null);                  // canceled -> give up
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
                        // We hold the lock: render the metatile in a worker.
                        self.renderMetatile(metaPath, lockPath, cb);
                    }
                });
            } else {
                self.extractFromBytes(data, cb);
            }
        });
    }

    renderMetatile(metaPath, lockPath, cb) {
        var self = this;
        // Worker writes here; we publish atomically with rename() so a SIGKILL
        // mid-write can never leave a partial .meta. Absolute so the path is
        // unambiguous in the child.
        var tmpPath = path.resolve(metaPath + '.' + process.pid + '.' + (tmpCounter++) + '.tmp');
        var params = {
            z: self.z,
            x: self.metaX,
            y: self.metaY,
            size: self.metatile * self.size,
            scale: self.metatile,
            mapScale: self.mapScale,
            buffer_size: self.buffer_size
        };
        self.pool.render(params, tmpPath, self.request, function (err) {
            if (err) {
                // Failed, killed (preempted), or canceled before/while rendering.
                // Always release the lock so sibling tiles don't hang on fs.watch,
                // and drop any temp file the worker may have left.
                fs.unlink(lockPath, function () {});
                fs.unlink(tmpPath, function () {});
                if (self.request.canceled) return cb(null, null);  // navigated away
                return cb(err);
            }
            // Success — even if the client has since navigated away, publish to
            // the cache (warms it for free) before unlocking and extracting.
            fs.readFile(tmpPath, function (rerr, data) {
                if (rerr) {
                    fs.unlink(lockPath, function () {});
                    return cb(rerr);
                }
                fs.rename(tmpPath, metaPath, function () {
                    fs.unlink(lockPath, function () {
                        self.extractFromBytes(data, cb);
                    });
                });
            });
        });
    };

    extractFromBytes(buffer, cb) {
        var self = this;
        mapnik.Image.fromBytes(buffer, function (err, im) {
            if (err) return cb(err);
            var view = im.view(self.size * (self.x % self.metatile), self.size * (self.y % self.metatile), self.size, self.size);
            // Return encoded PNG bytes: unlike the old in-process path, the caller
            // (ProjectServer.tile) writes these straight to the response.
            view.encode(self.format, function (err, out) {
                if (err) return cb(err);
                cb(null, out);
            });
        });
    }
}

exports = module.exports = { Tile: MetatileBasedTile };
