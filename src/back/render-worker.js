// Child process that owns one Mapnik map and renders tiles on request, so the
// parent can SIGKILL it to truly interrupt an in-flight render (node-mapnik has
// no in-process cancellation: map.render() runs to completion on a libuv
// threadpool thread). See RenderPool.js for the parent side.
//
// Protocol (parent -> child over fork IPC):
//   {type:'init', xmlPath, base, fontsDir, size, bufferSize}
//   {type:'render', id, z, x, y, size, scale, mapScale, buffer_size, tmpPath}
// Replies (child -> parent):
//   {ready:true}                      after init
//   {id, ok:true}                     render written to tmpPath
//   {id, err:'<message>'}             render failed
// The PNG bytes never travel over IPC; the child writes them to tmpPath and the
// parent reads/renames the file.
var fs = require('fs'),
    mapnik = require('@mapnik/mapnik'),
    Tile = require('./Tile.js').Tile;

var map = null;

function init(msg) {
    // Mirror Project's Mapnik setup (Project.js constructor) so the worker map
    // matches a pooled in-process map exactly.
    mapnik.register_default_fonts();
    mapnik.register_system_fonts();
    mapnik.register_default_input_plugins();
    if (msg.fontsDir) {
        try {
            mapnik.register_fonts(msg.fontsDir, {recurse: true});
        } catch (err) {
            // Optional project fonts dir may not exist; mapnik already has its
            // defaults registered above.
        }
    }
    var xml = fs.readFileSync(msg.xmlPath, 'utf8');
    map = new mapnik.Map(msg.size, msg.size);
    map.fromString(xml, {base: msg.base}, function (err) {
        if (err) {
            process.send({fatal: err.message});
            return process.exit(1);
        }
        map.bufferSize = msg.bufferSize;
        process.send({ready: true});
    });
}

function render(msg) {
    var done = function (err) {
        process.send({id: msg.id, ok: !err, err: err ? (err.message || String(err)) : undefined});
    };
    try {
        // The datasource query buffer is per-request (the UI buffer slider), so
        // set it on every render — the map is reused across renders.
        map.bufferSize = msg.buffer_size;
        var tile = new Tile(msg.z, msg.x, msg.y, {
            size: msg.size,
            scale: msg.scale,
            mapScale: msg.mapScale,
            buffer_size: msg.buffer_size
        });
        // project arg is unused by Tile.render.
        tile.render(null, map, function (err, im) {
            if (err) return done(err);
            im.encode('png', function (err, buffer) {
                if (err) return done(err);
                fs.writeFile(msg.tmpPath, buffer, function (err) {
                    done(err);
                });
            });
        });
    } catch (err) {
        done(err);
    }
}

process.on('message', function (msg) {
    if (msg.type === 'init') return init(msg);
    if (msg.type === 'render') return render(msg);
});

// If the parent goes away without killing us (e.g. it crashed), don't linger
// holding Postgres connections.
process.on('disconnect', function () {
    process.exit(0);
});
