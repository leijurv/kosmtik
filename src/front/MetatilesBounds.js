L.Kosmtik.MetatileBounds = L.GridLayer.extend({

    // Defaults describe the plain metatile grid; the offset-by-half variant
    // (aggregation-unit boundaries) passes overrides through the constructor.
    options: {
        field: 'showMetatiles',
        label: 'Display metatiles bounds (ctrl-alt-M)',
        commandName: 'Metatiles bounds: toggle view',
        keyCode: L.K.Keys.M,
        // Shift every drawn box by half a metatile so the lines land on the
        // aggregation-unit grid (the metatile grid offset half a metatile to a
        // corner). See openstreetmap-carto's offset-grid road aggregation.
        offsetHalf: false,
        baseColor: '#444',
        baseOpacity: 0.7,
        dashColor: '#fff',
        dashOpacity: 0.8
    },

    initialize: function (map, options) {
        L.setOptions(this, options);
        this.map = map;
        this.map.settingsForm.addElement([this.options.field, {handler: L.K.Switch, label: this.options.label}]);
        this.map.on('settings:synced', function (e) {
            if (e.helper.field === this.options.field) this.toggle();
        }, this);
        this.map.commands.add({
            keyCode: this.options.keyCode,
            altKey: true,
            ctrlKey: true,
            callback: function () { this.map.settingsForm.toggle(this.options.field); },
            context: this,
            name: this.options.commandName
        });
        L.GridLayer.prototype.initialize.call(this);
        this.setTileSize();
    },

    toggle: function () {
        if (L.K.Config[this.options.field]) this.map.addLayer(this);
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
        var map = this._map,
            tileSize = this.options.tileSize,
            zoom = tilePoint.z !== undefined ? tilePoint.z : map.getZoom(),
            nwPoint = tilePoint.multiplyBy(tileSize),
            latlngs;
        if (this.options.offsetHalf) {
            // Aggregation-unit grid = the metatile grid shifted half a metatile,
            // so its lines fall at each metatile's CENTRE (the aggregation cells
            // are metatile-sized boxes centred on metatile corners, so their
            // boundaries sit at (n+0.5)*metatile). Draw that as a cross through
            // the tile centre, each arm spanning the tile's OWN footprint: arms
            // from adjacent tiles abut into continuous lines, and because every
            // segment stays inside the tile that draws it, the loaded-tile set
            // (which covers the viewport) covers the whole grid — no half-tile
            // gap along the south/east screen edges like a one-sided shift gives.
            var half = tileSize / 2,
                wMid = map.unproject(nwPoint.add([0, half]), zoom),
                eMid = map.unproject(nwPoint.add([tileSize, half]), zoom),
                nMid = map.unproject(nwPoint.add([half, 0]), zoom),
                sMid = map.unproject(nwPoint.add([half, tileSize]), zoom);
            latlngs = [[wMid, eMid], [nMid, sMid]];
        } else {
            // Each metatile draws its south + east edges; abutting tiles complete
            // the grid. The edges span the tile's full footprint, so loaded tiles
            // always cover the viewport.
            var sw = map.unproject(nwPoint.add([0, tileSize]), zoom),
                se = map.unproject(nwPoint.add([tileSize, tileSize]), zoom),
                ne = map.unproject(nwPoint.add([tileSize, 0]), zoom);
            latlngs = [sw, se, ne];
        }
        var options = {
            renderer: this.renderer,
            color: this.options.baseColor,
            weight: 1,
            opacity: this.options.baseOpacity,
            fill: false,
            interactive: false,
            noClip: true
        };
        var base = L.polyline(latlngs, options);
        this.vectorlayer.addLayer(base);
        options.color = this.options.dashColor;
        options.dashArray = '10,10';
        options.opacity = this.options.dashOpacity;
        var dash = L.polyline(latlngs, options);
        this.vectorlayer.addLayer(dash);
        return [base, dash];
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
