L.Kosmtik.MetatileBounds = L.GridLayer.extend({

    initialize: function (map) {
        this.map = map;
        this.map.settingsForm.addElement(['showMetatiles', {handler: L.K.Switch, label: 'Display metatiles bounds (ctrl-alt-M)'}]);
        this.map.on('settings:synced', function (e) {
            if (e.helper.field === 'showMetatiles') this.toggle();
        }, this);
        this.map.commands.add({
            keyCode: L.K.Keys.M,
            altKey: true,
            ctrlKey: true,
            callback: function () { this.map.settingsForm.toggle('showMetatiles'); },
            context: this,
            name: 'Metatiles bounds: toggle view'
        });
        L.GridLayer.prototype.initialize.call(this);
        this.setTileSize();
    },

    toggle: function () {
        if (L.K.Config.showMetatiles) this.map.addLayer(this);
        else this.map.removeLayer(this);
    },

    onAdd: function (map) {
        this._map = map;
        // Draw every metatile boundary onto a single shared <canvas> rather than
        // the default SVG renderer. SVG would create two <path> DOM nodes per
        // metatile, and the browser repaints that whole node tree on every pan
        // frame — which is what made panning crawl. A canvas is one bitmap the
        // browser simply composites/translates, so panning stays smooth no matter
        // how many lines are on screen.
        this.renderer = L.canvas({ padding: 0.5 });
        map.addLayer(this.renderer);
        this.vectorlayer = new L.FeatureGroup();
        map.addLayer(this.vectorlayer);
        map.on('reloaded', this.reset, this);
        // GridLayer fires tileunload when a tile is pruned (off-screen pan, zoom,
        // redraw). Remove that tile's lines then so they never accumulate.
        this.on('tileunload', this._onTileUnload, this);
        L.GridLayer.prototype.onAdd.call(this, map);
    },

    onRemove: function (map) {
        map.off('reloaded', this.reset, this);
        this.off('tileunload', this._onTileUnload, this);
        L.GridLayer.prototype.onRemove.call(this, map);
        map.removeLayer(this.vectorlayer);
        map.removeLayer(this.renderer);
        this.vectorlayer = null;
        this.renderer = null;
    },

    // Override createTile (not _addTile) so GridLayer keeps owning the tile
    // lifecycle: it records each tile in this._tiles, which is what lets it
    // skip tiles that already exist (no redrawing the same metatile on every
    // pan) and prune tiles that scroll out of view (firing tileunload below).
    // We return a throwaway element and hang the tile's lines off it.
    createTile: function (coords, done) {
        var tile = document.createElement('div');
        tile._metaLines = this.addData(coords);
        // Report the tile as ready so GridLayer can manage load/prune state.
        setTimeout(L.bind(done, this, null, tile), 0);
        return tile;
    },

    _onTileUnload: function (e) {
        var lines = e.tile._metaLines;
        if (!lines || !this.vectorlayer) return;
        for (var i = 0; i < lines.length; i++) this.vectorlayer.removeLayer(lines[i]);
        e.tile._metaLines = null;
    },

    addData: function (tilePoint) {
        // Project with the tile's OWN zoom, not the map's. GridLayer creates the
        // next zoom's tiles during the zoom animation, while map.getZoom() still
        // reports the old zoom; unproject() defaults to that old zoom and would
        // place the lines off-screen (and, since the tile is now tracked, they'd
        // never get redrawn). coords.z keeps the geometry correct regardless.
        var tileSize = this.options.tileSize,
            zoom = tilePoint.z !== undefined ? tilePoint.z : this._map.getZoom(),
            nwPoint = tilePoint.multiplyBy(tileSize),
            sw = this._map.unproject(nwPoint.add([0, tileSize]), zoom),
            se = this._map.unproject(nwPoint.add([tileSize, tileSize]), zoom),
            ne = this._map.unproject(nwPoint.add([tileSize, 0]), zoom);
        var options = {
            renderer: this.renderer,
            color: '#444',
            weight: 1,
            opacity: 0.7,
            fill: false,
            interactive: false,
            noClip: true
        };
        var grey = L.polyline([sw, se, ne], options);
        this.vectorlayer.addLayer(grey);
        options.color = '#fff';
        options.dashArray = '10,10';
        options.opacity = 0.8;
        var white = L.polyline([sw, se, ne], options);
        this.vectorlayer.addLayer(white);
        return [grey, white];
    },

    setTileSize: function () {
        this.options.tileSize = L.K.Config.project.metatile * L.K.Config.project.tileSize;
    },

    reset: function () {
        this.setTileSize();
        // GridLayer.redraw drops every tile (firing tileunload, which clears the
        // old lines) and reloads at the current tile size.
        this.redraw();
    }

});
