// A pool of killable child processes (render-worker.js), each holding one Mapnik
// map, plus a scheduler that can SIGKILL a worker to truly interrupt an in-flight
// render. node-mapnik has no in-process cancellation, so this is the only way to
// stop a render once it has started (and SIGKILL also drops the worker's Postgres
// connection, so a slow datasource query is aborted too).
//
// Kill policy (see plan): a worker is preempted only when ALL of:
//   1. its render's request is canceled (the HTTP socket closed), AND
//   2. it has been rendering longer than killAfterMs (don't churn quick renders),
//      AND
//   3. a visible (non-canceled) job is queued and no worker is idle (contention).
// Otherwise a canceled render is left to finish — it warms the .meta cache for
// free and the worker stays warm.
var path = require('path'),
    child_process = require('child_process');

var WORKER_PATH = path.join(__dirname, 'render-worker.js');
var nextJobId = 1;

// Worker slot states: 'starting' -> 'idle' -> 'busy' -> ('killing' ->) 'exited'.

class RenderPool {
    constructor(options) {
        this.label = options.label || 'render';
        this.targetSize = Math.max(1, options.targetSize || 1);
        this.killAfterMs = options.killAfterMs;
        // The init message every worker gets on spawn. Size is the Mapnik map
        // dimension (metatileSize * scale), matching Project.createMapPool.
        this.initMsg = {
            type: 'init',
            xmlPath: options.xmlPath,
            base: options.base,
            fontsDir: options.fontsDir,
            size: options.mapSize,
            bufferSize: options.bufferSize
        };
        // Bound how many workers cold-start at once: each load parses the XML and
        // opens its own Postgres connections, so a full pool warming up (or being
        // refilled) in one burst can spike the database. Ramp up in waves instead.
        this.maxStarting = Math.max(2, Math.ceil(this.targetSize / 2));
        this.workers = [];
        this.queue = [];
        this.destroyed = false;
        this.startupFailures = 0;
        this.replenish();
    }

    // --- public API -------------------------------------------------------

    // Submit a render. params = {z, x, y, size, scale, mapScale, buffer_size}.
    // The worker writes the PNG to tmpPath; cb(err) fires once — err is null on
    // success (tmpPath is ready), or an Error on failure / kill / cancel. The
    // caller should check request.canceled before responding to the client.
    render(params, tmpPath, request, cb) {
        var self = this;
        var job = {
            id: nextJobId++,
            params: params,
            tmpPath: tmpPath,
            request: request,
            cb: cb,
            settled: false,
            startedAt: 0,
            floorTimer: null
        };
        if (this.destroyed) return this._settle(job, new Error('render pool destroyed'));
        // Nudge the scheduler whenever this request is canceled, so a queued job
        // is dropped promptly and an in-flight one becomes preemptible.
        request.onCancel = function () { self._onCancel(job); };
        this.queue.push(job);
        this.schedule();
    }

    // SIGKILL every worker and fail outstanding work. Safe to call repeatedly.
    destroyAll() {
        this.destroyed = true;
        var jobs = this.queue.splice(0);
        for (var i = 0; i < this.workers.length; i++) {
            var w = this.workers[i];
            if (w.job) jobs.push(w.job);
        }
        for (var j = 0; j < jobs.length; j++) {
            this._settle(jobs[j], new Error('render pool destroyed'));
        }
        this.killChildren();
        this.workers = [];
    }

    // Synchronous, allocation-free SIGKILL of every child. Used from the
    // process 'exit' handler, which cannot await anything.
    killChildren() {
        for (var i = 0; i < this.workers.length; i++) {
            try { this.workers[i].child.kill('SIGKILL'); } catch (e) { /* already gone */ }
        }
    }

    // --- scheduling -------------------------------------------------------

    schedule() {
        if (this.destroyed) return;
        // 1. Drop canceled jobs that never started — nothing to render.
        this.queue = this.queue.filter(function (job) {
            if (!job.request.canceled) return true;
            this._settle(job, new Error('canceled'));
            return false;
        }, this);

        // 2. Hand idle workers to the most recent visible job first (the tile on
        //    screen now matters more than one from an earlier pan).
        var idle;
        while (this.queue.length && (idle = this._firstIdle())) {
            this._assign(idle, this.queue.pop());  // newest queued first
        }
        if (!this.queue.length) return;

        // 3. Contention: a visible job is still waiting and nothing is idle.
        //    Preempt one stale render past the floor — but only if no replacement
        //    is already on the way (one preemption in flight at a time avoids
        //    kill storms). The displaced job takes the first worker that frees up.
        if (this._anyStarting()) return;
        var victim = this._preemptCandidate();
        if (victim) this._preempt(victim);
    }

    _firstIdle() {
        for (var i = 0; i < this.workers.length; i++) {
            if (this.workers[i].state === 'idle') return this.workers[i];
        }
        return null;
    }

    _anyStarting() {
        for (var i = 0; i < this.workers.length; i++) {
            if (this.workers[i].state === 'starting') return true;
        }
        return false;
    }

    // Youngest busy worker whose render is canceled and past the kill floor, so a
    // preemption wastes the least already-done work.
    _preemptCandidate() {
        var now = Date.now(), best = null;
        for (var i = 0; i < this.workers.length; i++) {
            var w = this.workers[i];
            if (w.state !== 'busy' || !w.job.request.canceled) continue;
            if (now - w.job.startedAt < this.killAfterMs) continue;
            if (!best || w.job.startedAt > best.job.startedAt) best = w;
        }
        return best;
    }

    _assign(w, job) {
        w.state = 'busy';
        w.job = job;
        job.startedAt = Date.now();
        w.child.send({
            type: 'render',
            id: job.id,
            z: job.params.z,
            x: job.params.x,
            y: job.params.y,
            size: job.params.size,
            scale: job.params.scale,
            mapScale: job.params.mapScale,
            buffer_size: job.params.buffer_size,
            tmpPath: job.tmpPath
        });
    }

    _preempt(w) {
        // The render is stale (canceled); fail its job now (exactly once) and
        // SIGKILL. currentJob is cleared in the exit handler so a late IPC
        // message can't double-settle.
        console.warn('[' + this.label + '] kill', w.pid, '(stale render, held ' + (Date.now() - w.job.startedAt) + 'ms)');
        this._settle(w.job, new Error('canceled'));
        w.state = 'killing';
        try { w.child.kill('SIGKILL'); } catch (e) { /* already gone */ }
    }

    // --- worker lifecycle -------------------------------------------------

    spawn() {
        var self = this;
        // Not detached: children die with us on a clean exit; index.js also
        // SIGKILLs them on signals/exit for the abnormal cases.
        var child = child_process.fork(WORKER_PATH);
        var w = {child: child, pid: child.pid, state: 'starting', job: null, spawnedAt: Date.now()};
        this.workers.push(w);
        child.on('message', function (msg) { self._onMessage(w, msg); });
        child.on('exit', function (code, signal) { self._onExit(w, code, signal); });
        child.on('error', function () { /* an 'exit' follows; handled there */ });
        child.send(this.initMsg);
        return w;
    }

    replenish() {
        if (this.destroyed) return;
        var live = 0, starting = 0;
        for (var i = 0; i < this.workers.length; i++) {
            if (this.workers[i].state === 'exited') continue;
            live++;
            if (this.workers[i].state === 'starting') starting++;
        }
        // Spawn up to the target, but no more than maxStarting cold starts in
        // flight; the next wave spawns as each worker becomes ready (see ready
        // handler, which calls replenish again).
        while (live < this.targetSize && starting < this.maxStarting) {
            this.spawn();
            live++;
            starting++;
        }
    }

    _onMessage(w, msg) {
        if (msg.ready) {
            if (w.state === 'starting') {
                w.state = 'idle';
                this.startupFailures = 0;
                console.warn('[' + this.label + '] worker', w.pid, 'ready in', (Date.now() - w.spawnedAt) + 'ms');
                this.replenish();  // a starting slot freed up; warm the next wave
                this.schedule();
            }
            return;
        }
        if (msg.fatal) {
            console.warn('[' + this.label + '] worker', w.pid, 'failed to load map:', msg.fatal);
            return;  // worker exits itself; _onExit handles respawn/backoff
        }
        // A render result. Ignore if this worker was killed or already moved on
        // (a result that raced a SIGKILL) — settle-once is enforced anyway.
        if (w.state !== 'busy' || !w.job || w.job.id !== msg.id) return;
        var job = w.job;
        w.job = null;
        w.state = 'idle';
        this._settle(job, msg.ok ? null : new Error(msg.err || 'render failed'));
        this.schedule();
    }

    _onExit(w, code, signal) {
        var wasStarting = (w.state === 'starting');
        if (w.job && !w.job.settled) {
            // Crash (not our SIGKILL) with a job in flight: surface it.
            this._settle(w.job, new Error('render worker exited (' + (signal || code) + ')'));
        }
        w.job = null;
        w.state = 'exited';
        var idx = this.workers.indexOf(w);
        if (idx !== -1) this.workers.splice(idx, 1);
        if (this.destroyed) return;
        if (wasStarting) {
            // Never became ready — likely a bad XML / datasource. Back off so we
            // don't spin in a tight respawn loop.
            this.startupFailures++;
            var self = this, delay = Math.min(30000, 250 * Math.pow(2, Math.min(this.startupFailures, 7)));
            setTimeout(function () { self.replenish(); self.schedule(); }, delay);
            return;
        }
        this.replenish();
        this.schedule();
    }

    // --- cancellation -----------------------------------------------------

    _onCancel(job) {
        this.schedule();
        // If the canceled job is in flight but under the floor, re-check once it
        // crosses the floor (a waiting visible job may then preempt it) without
        // depending on another request arriving to nudge the scheduler.
        if (job.settled || job.floorTimer || !job.startedAt) return;
        var elapsed = Date.now() - job.startedAt;
        if (elapsed >= this.killAfterMs) return;
        var self = this;
        job.floorTimer = setTimeout(function () {
            job.floorTimer = null;
            self.schedule();
        }, this.killAfterMs - elapsed + 1);
    }

    _settle(job, err) {
        if (job.settled) return;
        job.settled = true;
        if (job.floorTimer) { clearTimeout(job.floorTimer); job.floorTimer = null; }
        if (job.request && job.request.onCancel) job.request.onCancel = null;
        job.cb(err);
    }
}

exports = module.exports = { RenderPool };
