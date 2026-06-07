#!/usr/bin/env node

var Config = require('./src/Config.js').Config,
    Server = require('./src/back/PreviewServer.js').PreviewServer;

process.title = 'kosmtik';

var config = new Config(__dirname, process.env.KOSMTIK_CONFIGPATH);
var server = new Server(config, __dirname);
config.parseOptions();

// Render tiles run in child processes (see RenderPool); make sure they don't
// outlive us. On a signal, tear the pools down gracefully, then exit (which
// fires 'exit' below as a synchronous backstop SIGKILL).
function shutdown() {
    try { server.shutdown(); } catch (err) { /* ignore */ }
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', function () {
    try { server.killAllWorkers(); } catch (err) { /* ignore */ }
});
