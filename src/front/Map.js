// Numeric input for the Mapnik buffer size.
// The idea is to not re-render on every keystroke, since re-rendering each intermediate value (2, then 25, then 256…) is very slow.
L.Kosmtik.BufferInput = L.FormBuilder.BlurIntInput.extend({

    value: function () {
        var v = parseInt(this.input.value, 10);
        if (isNaN(v) || v < 0) v = 0;
        if (String(v) !== this.input.value) this.input.value = v;  // normalise the displayed text (e.g. '' -> '0')
        return v;
    },

    sync: function () {
        var v = this.value();
        if (this.initial !== v) {
            L.FormBuilder.Input.prototype.sync.call(this);  // presync -> set -> postsync (commit + redraw)
            this.initial = v;  // don't re-commit the same value on a subsequent blur
        }
    }

});

// TileLayer that lets the Retina (hidpi) state be controlled from the UI
// instead of being hard-wired to the browser's display. Leaflet fills the
// {r} placeholder ('@2x' or '') from L.Browser.retina inside getTileUrl, so we
// temporarily override that flag with L.K.Config.retina for the duration of the
// call rather than reimplementing Leaflet's URL building.
L.Kosmtik.TileLayer = L.TileLayer.extend({

    getTileUrl: function (coords) {
        var detected = L.Browser.retina;
        L.Browser.retina = !!L.K.Config.retina;
        try {
            return L.TileLayer.prototype.getTileUrl.call(this, coords);
        } finally {
            L.Browser.retina = detected;
        }
    }

});

L.Kosmtik.Map = L.Map.extend({

    options: {
        attributionControl: false
    },

    initialize: function (options) {
        // Retina defaults to whatever the display reports (autodetect), but can
        // then be toggled from the Settings sidebar.
        if (L.K.Config.retina === undefined) L.K.Config.retina = L.Browser.retina;
        // Buffer size defaults to the project's configured value.
        if (L.K.Config.buffer === undefined) L.K.Config.buffer = L.K.Config.project.bufferSize || 256;
        this.sidebar = new L.Kosmtik.Sidebar().addTo(this);
        this.toolbar = new L.Kosmtik.Toolbar().addTo(this);
        this.commands = new L.Kosmtik.Command(this);
        this.settingsForm = new L.K.SettingsForm(this);
        this.settingsForm.addElement(['autoReload', {handler: L.K.Switch, label: 'Autoreload', helpText: 'Reload map as soon as a project file is changed on the server.'}]);
        this.settingsForm.addElement(['retina', {handler: L.K.Switch, label: 'Retina (hidpi)', helpText: 'Render high-resolution @2x tiles. Autodetected from your display by default.'}]);
        this.settingsForm.addElement(['buffer', {handler: L.K.BufferInput, label: 'Buffer size (px)', helpText: 'Mapnik render buffer in pixels. Larger values avoid labels/shields being clipped at tile edges, at the cost of render speed. Applied on blur or Enter.'}]);
        this.settingsForm.addElement(['backendPolling', {handler: L.K.Switch, label: '(Advanced) Poll backend for project updates'}]);
        this.createPollIndicator();
        this.createReloadButton();
        this.dataInspector = new L.K.DataInspector(this);
        L.Map.prototype.initialize.call(this, 'map', options);
        this.loader = L.DomUtil.create('div', 'map-loader', this._controlContainer);
        this.crosshairs = new L.K.Crosshairs(this);
        this.alert = new L.K.Alert(this);
        this.metatilesBounds = new L.K.MetatileBounds(this);
        // Same grid offset by half a metatile, in blue dashes: the offset-grid
        // aggregation-unit boundaries (see openstreetmap-carto road merging).
        this.metatilesBoundsOffset = new L.K.MetatileBounds(this, {
            field: 'showMetatilesOffset',
            label: 'Display aggregation unit bounds (ctrl-alt-A)',
            commandName: 'Aggregation unit bounds: toggle view',
            keyCode: L.K.Keys.A,
            offsetHalf: true,
            baseColor: '#002b5c',
            baseOpacity: 0.7,
            dashColor: '#2d8cff',
            dashOpacity: 0.9
        });
        var tilelayerOptions = {
            version: L.K.Config.project.loadTime,
            tileSize: L.K.Config.project.tileSize,
            buffer: L.K.Config.buffer,
            minZoom: this.options.minZoom,
            maxZoom: this.options.maxZoom
        };
        this.tilelayer = new L.Kosmtik.TileLayer('./tile/{z}/{x}/{y}{r}.png?t={version}&buffer={buffer}', tilelayerOptions).addTo(this);
        this.tilelayer.on('loading', function () {
            this.setState('loading');
        }, this);
        this.tilelayer.on('load', function () {
            this.unsetState('loading');
        }, this);
        L.control.scale().addTo(this);
        this.initPoller();
        this.on('dirty:on', function () {
            if (L.K.Config.autoReload) this.reload();
        });
        this.on('settings:synced', function (e) {
            if (e.helper.field === 'backendPolling') this.togglePoll();
            if (e.helper.field === 'retina') this.tilelayer.redraw();
            if (e.helper.field === 'buffer') {
                this.tilelayer.options.buffer = L.K.Config.buffer;
                this.tilelayer.redraw();
            }
        });
        this.help = new L.Kosmtik.Help(this);
        if(L.K.Config.project.name.length) document.title = L.K.Config.project.name + ' — Kosmtik';
        this.commands.add({
            keyCode: L.K.Keys.V,
            shiftKey: true,
            ctrlKey: true,
            altKey: true,
            callback: this.clearVectorCache,
            context: this,
            name: 'Core: empty vector cache'
        });
    },

    setState: function (state) {
        if (!L.DomUtil.hasClass(document.body, state)) {
            L.DomUtil.addClass(document.body, state);
            this.fire(state + ':on');
        }
    },

    unsetState: function (state) {
        if (L.DomUtil.hasClass(document.body, state)) {
            L.DomUtil.removeClass(document.body, state);
            this.fire(state + ':off');
        }
    },

    checkState: function (state) {
        return L.DomUtil.hasClass(document.body, state);
    },

    reload: function () {
        this.unsetState('dirty');
        this.setState('loading');
        this.fire('reload');
        L.K.Xhr.post('./reload/', {
            callback: function (status, data) {
                if (status === 200 && data) {
                    L.K.Config.project = JSON.parse(data);
                    this.tilelayer.options.version = L.K.Config.project.loadTime;
                    this.tilelayer.redraw();
                    this.fire('reloaded');
                }
                this.unsetState('loading');
            },
            context: this
        });
    },

    createReloadButton: function () {
        var reload = L.DomUtil.create('li', 'reload');
        reload.innerHTML = 'Reload';
        L.DomEvent.on(reload, 'click', function () {
            this.reload();
        }, this);
        this.toolbar.addTool(reload);
        this.commands.add({
            keyCode: L.K.Keys.R,
            shiftKey: true,
            ctrlKey: true,
            callback: this.reload,
            context: this,
            name: 'Map: reload'
        });
        this.commands.add({
            keyCode: L.K.Keys.A,
            shiftKey: true,
            ctrlKey: true,
            altKey: true,
            callback: function () { this.settingsForm.toggle('autoReload'); },
            context: this,
            name: 'Autoreload: toggle',
            description: 'Autoreload or not when project has changed'
        });
    },

    createPollIndicator: function () {
        var button = L.DomUtil.create('li', 'poll-indicator');
        button.innerHTML = '⇵';
        button.title = 'Sync status';
        this.toolbar.addTool(button);
    },

    initPoller: function () {
        this.poll = new L.K.Poll('./poll/');
        this.poll.on('message', function (e) {
            if (e.isDirty) this.setState('dirty');
            if (e.error) this.alert.show({content: e.error, level: 'error'});
        }, this);
        this.poll.on('error', function () {
            this.setState('polling-error');
        }, this);
        this.poll.on('polled', function () {
            this.unsetState('polling-error');
        }, this);
        this.poll.on('start', function () {
            this.setState('polling');
        }, this);
        this.poll.on('stop', function () {
            this.unsetState('polling');
        }, this);
        this.togglePoll();
        var commandCallback = function () {
            this.settingsForm.toggle('backendPolling');
            this.togglePoll();
        };
        this.commands.add({
            keyCode: L.K.Keys.P,
            shiftKey: true,
            ctrlKey: true,
            altKey: true,
            callback: commandCallback,
            context: this,
            name: 'Poller: toggle'
        });
    },

    togglePoll: function () {
        if (L.K.Config.backendPolling) this.poll.start();
        else this.poll.stop();
    },

    clearVectorCache: function () {
        L.K.Xhr.get('./clear-vector-cache/');
    }

});

L.Kosmtik.ZoomIndicator = L.Control.extend({

    options: {
        position: 'topleft'
    },

    onAdd: function (map) {
        this.map = map;
        this.container = L.DomUtil.create('div', 'zoom-indicator');
        map.on('zoomend', this.update, this);
        this.update();
        return this.container;
    },

    update: function () {
        this.container.textContent = this.map.getZoom();
    }

});


L.K.Map.addInitHook(function () {
    this.whenReady(function () {
        (new L.K.ZoomIndicator()).addTo(this);
    });
});
