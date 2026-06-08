// Inject default Mapnik PostGIS datasource parameters into every postgis layer
// at project load time, so we don't have to patch them into each project's
// project.mml (e.g. openstreetmap-carto). Runs after local-config, so anything
// a project or localconfig sets explicitly wins over these defaults.
//
// Override or disable via `postgisDatasourceDefaults` in your kosmtik.yml:
//   postgisDatasourceDefaults:        # custom values replace the defaults below
//     asynchronous_request: true
//     max_async_connection: 12
//   postgisDatasourceDefaults: {}     # empty object => no-op (turns the plugin off)
var DEFAULTS = {
    asynchronous_request: true,
    max_async_connection: 12,
    max_size: 12
};

class PostgisDefaults {
    constructor(config) {
        config.beforeState('project:loaded', this.patchLayers);
    };

    patchLayers(e) {
        // `this` is the project here (see StateBase.changeState), so `this.config`
        // is the Config instance — same pattern as the local-config plugin.
        var defaults = this.config.getFromUserConfig('postgisDatasourceDefaults', DEFAULTS),
            layers = (e.project.mml && e.project.mml.Layer) || [],
            patched = 0;
        for (var i = 0; i < layers.length; i++) {
            var ds = layers[i].Datasource;
            if (!ds || ds.type !== 'postgis') continue;
            for (var key in defaults) {
                // Don't clobber a value the project set explicitly.
                if (!(key in ds)) ds[key] = defaults[key];
            }
            patched++;
        }
        if (patched) this.config.log('[PostGIS Defaults] Applied defaults to', patched, 'postgis layer(s)');
        e.continue();
    };
}

exports = module.exports = { Plugin: PostgisDefaults };
