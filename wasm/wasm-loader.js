// wasm-loader.js — hash-switch bridge + deep profiling instrumentation.
// Every phase is marked on window.__prewarmTimings for test inspection.
(function() {
    'use strict';

    // Build fingerprint — injected by deploy.sh (md5 of online.wasm).
    // Used to invalidate stale snapshots when the WASM binary changes.
    var BUILD_FINGERPRINT = '__WASM_BUILD_FINGERPRINT__';

    var params = new URLSearchParams(window.location.search);
    var wopiSrc = params.get('WOPISrc') || '';
    // displayName is the plaintext filename the user sees in the title bar
    // and #document-name-input. For v2-encrypted opens the WOPISrc is an
    // opaque fileId; the parent viewer passes the decrypted filename as
    // a separate query param so the editor can display a human label.
    var displayName = params.get('displayName') || '';
    // Use displayName's extension (if given) for docType detection, since
    // v2 fileIds have no extension. Fall back to WOPISrc's extension.
    var typingSource = displayName || wopiSrc;
    var ext = typingSource.split('.').pop().toLowerCase().split('?')[0];
    var docType = 'writer';
    if (['xlsx','xls','ods','csv','tsv'].indexOf(ext) >= 0) docType = 'calc';
    else if (['pptx','ppt','odp','ppsx','pps'].indexOf(ext) >= 0) docType = 'impress';
    window.__wasmDocType = docType;

    // ───── PROFILING ─────
    // If loaded through the viewer, viewerT0 is the viewer page's navigation
    // start (when the user actually hit Enter). Without it, fall back to this
    // iframe's own navigation start. This gives the true total load time.
    var viewerT0Param = params.get('viewerT0');
    var t0Nav = viewerT0Param ? parseFloat(viewerT0Param)
              : (performance.timeOrigin || (performance.timing && performance.timing.navigationStart) || (Date.now() - performance.now()));
    var t0 = performance.now(); // kept for backward compat with test code
    window.__prewarmTimings = { t0Wall: Date.now(), t0Nav: t0Nav, events: [] };
    function msSinceNav() { return Date.now() - t0Nav; }
    // Pipeline stages forwarded to the parent viewer as WasmOpenStage
    // postMessages — the viewer's shield renders them as a live stage
    // checklist during file open (feature 2026-06-12). Keys are mark()
    // name PREFIXES; first mark matching each prefix fires one message.
    var STAGE_FORWARD = [
        'loader:start',
        'sw-bridge:ready',
        'net:fetch_start',
        'net:fetch_end',
        'emscripten:module_defined',
        'snapshot:signal',
        'emscripten:wasmExports_ready',
        'emscripten:FS_ready',
        'emscripten:calledRun',
        'dom:status_appeared',
        'dom:first_canvas',
        'doc:loaded',
    ];
    var _stageSent = {};
    function forwardStage(name, detail) {
        for (var i = 0; i < STAGE_FORWARD.length; i++) {
            var pfx = STAGE_FORWARD[i];
            if (!_stageSent[pfx] && name.indexOf(pfx) === 0) {
                _stageSent[pfx] = true;
                try {
                    parent.postMessage(JSON.stringify({
                        MessageId: 'WasmOpenStage',
                        Values: { stage: pfx, tMs: msSinceNav(), detail: detail || '' },
                    }), '*');
                } catch (e) {}
                return;
            }
        }
    }
    function mark(name, detail) {
        var dt = (performance.now() - t0).toFixed(1);
        var navMs = msSinceNav();
        window.__prewarmTimings.events.push({ t: +dt, tNav: navMs, name: name, detail: detail || '' });
        console.log('[profile +' + dt + 'ms] ' + name + (detail ? ' ' + detail : ''));
        forwardStage(name, detail);
    }
    window.__prewarmMark = mark;

    // Forward the kit's own document-import progress (`progress:` frames,
    // statusindicator id=setvalue value=0..100) to the parent shield. The
    // import filter is the dominant phase of a big-file open — without
    // this the shield sits at a fixed % for the whole parse. Wire-level
    // tap: wrap TheFakeWebSocket.onmessage once it exists; pure
    // observation, the original handler always runs.
    (function installImportProgressTap() {
        function wrap(fws) {
            var orig = fws.onmessage;
            var tap = function(ev) {
                try {
                    var txt = typeof ev.data === 'string' ? ev.data : '';
                    if (txt.indexOf('progress:') === 0) {
                        var info = JSON.parse(txt.substring(txt.indexOf('{')));
                        if (info && info.id === 'setvalue' && typeof info.value === 'number'
                            && info.type !== 'bg') {
                            parent.postMessage(JSON.stringify({
                                MessageId: 'WasmOpenStage',
                                Values: { stage: 'import', pct: info.value, tMs: msSinceNav() },
                            }), '*');
                        }
                    }
                } catch (e) {}
                return orig.apply(this, arguments);
            };
            tap.__isImportTap = true;
            fws.onmessage = tap;
        }
        var tries = 0;
        // Keep polling (cheap) for the whole boot window: the relay-
        // adapter and the switchdoc hook both REPLACE onmessage, which
        // would silently drop a one-shot tap. Re-wrap whenever the
        // current handler isn't ours.
        var iv = setInterval(function() {
            tries++;
            var fws = globalThis.TheFakeWebSocket;
            if (fws && fws.onmessage && !fws.onmessage.__isImportTap) wrap(fws);
            if (tries > 1200) clearInterval(iv);  // stop after ~2 min
        }, 100);
    })();

    // ── Human-readable timing (from navigation start, visible in console) ──
    var _timingMilestones = {};
    // Dedupe labels — logTiming is called from multiple signal paths
    // (docPoll, trySendSwitch's docReadyInterval, switchdoc's own
    // poll). Same label firing more than once just clutters the log.
    var _timingSeen = {};
    function logTiming(label) {
        if (_timingSeen[label]) return;
        _timingSeen[label] = true;
        var ms = msSinceNav();
        _timingMilestones[label] = ms;
        console.log('%c[TIMING] ' + label + ' @ ' + (ms / 1000).toFixed(2) + 's (from navigation)',
            'color: #1565c0; font-weight: bold; font-size: 13px');
    }
    window.__wasmLogTiming = logTiming;
    // Reset so a switchdoc into a different file can log "Document
    // ready" again for that file. Called by checkHashSwitch.
    window.__wasmLogTimingReset = function(label) { delete _timingSeen[label]; };
    logTiming('wasm-loader.js started');

    // Filter out emscripten's worker-mailbox noise. The infinite
    // Atomics.waitAsync().then(checkMailbox) chain pumps __emscripten_
    // check_mailbox which in turn can fire console.log/warn/error from
    // WASM-side code via _emscripten_console_* imports. The log text
    // itself doesn't mention "checkMailbox" — Chrome only shows the
    // names because the call stack walks through that chain. So we
    // filter by the CALL STACK of the wrapper, not the message text.
    // Wrap log/info/debug/warn/error at capture-time; drop any call
    // whose synchronous stack passes through checkMailbox /
    // __emscripten_thread_mailbox_await / the _mb wrapper.
    (function filterMailboxSpam() {
        var stackRe = /checkMailbox|__emscripten_thread_mailbox_await|\b_mb\b/;
        var textRe = /__emscripten_thread_mailbox_await|\bcheckMailbox\b/;
        function fromMailbox(args) {
            try {
                var s = new Error().stack || '';
                if (stackRe.test(s)) return true;
            } catch(e) {}
            for (var i = 0; i < args.length; i++) {
                var a = args[i];
                if (typeof a === 'string' && textRe.test(a)) return true;
            }
            return false;
        }
        ['log','info','debug','warn','error'].forEach(function(k) {
            var orig = console[k];
            if (!orig) return;
            console[k] = function() {
                if (fromMailbox(arguments)) return;
                orig.apply(console, arguments);
            };
        });
    })();

    mark('loader:start', 'doc=' + docType + ' ext=' + ext);

    // If the viewer supplied a plaintext displayName, override COOL's
    // default title (WOPISrc-based, which is the opaque fileId in v2)
    // persistently. COOL repopulates #document-name-input asynchronously
    // from wopi events that arrive long after load, and its own UI code
    // will clobber any one-off assignment. Use a MutationObserver on
    // the input and a long-running interval so we always win.
    //
    // Iter 89: hoisted out of the `if (displayName)` gate. On a deep-link
    // open (`/#file=secret` on viewer load), wasm-loader runs with the
    // PREWARM iframe URL — no displayName param. Then a hashchange
    // delivers `#switchdoc=<fileId>&displayName=...` which sets the
    // module-scope displayName variable (line ~671 in checkHashSwitch).
    // The previous code skipped installing the observer if displayName
    // was empty at init, so a late-arriving displayName never had its
    // observer to defend it against COOL's wopi: clobber. Net effect:
    // the title bar showed the opaque fileId on deep-link cold-load.
    // Now: always install the watcher, no-op while displayName is
    // empty, kicks in as soon as it lands.
    var applyName = function() {
        if (!displayName) return;
        try {
            if (window.app && window.app.map && window.app.map['wopi']) {
                // Only set BreadcrumbDocName — BaseFileName is the WOPISrc
                // identity used by save/rename/export and must stay = the
                // WOPISrc (iter 17 #4 carve-out).
                window.app.map['wopi'].BreadcrumbDocName = displayName;
            }
            var ni = document.querySelector('#document-name-input');
            if (ni && ni.value !== displayName) ni.value = displayName;
            try { document.title = displayName; } catch(e) {}
        } catch(e) {}
    };
    applyName();
    // Watch for late DOM insertion of the input; once it appears,
    // attach a MutationObserver so we re-apply if COOL ever resets
    // it back to the fileId. Watcher runs unconditionally; applyName
    // bails fast when displayName is empty.
    var observerInstalled = false;
    var watchStart = Date.now();
    var watchInt = setInterval(function() {
        var ni = document.querySelector('#document-name-input');
        if (ni && !observerInstalled) {
            observerInstalled = true;
            try {
                new MutationObserver(function() {
                    if (displayName && ni.value !== displayName) ni.value = displayName;
                }).observe(ni, { attributes: true, attributeFilter: ['value'] });
            } catch(e) {}
            // Also catch the case where COOL writes a NEW value programmatically
            // (input.value = '...' doesn't always emit attribute mutations).
            // Re-apply on focus / blur events as a final defence.
            ni.addEventListener('blur', applyName, true);
        }
        applyName();
        if (Date.now() - watchStart > 120000) clearInterval(watchInt);
    }, 500);

    // ───── SERVICE WORKER REGISTRATION ─────
    // ONE Service Worker at /sw-bridge.js with scope `/`. Handles both:
    //   (a) bridging Kit's /wasm/<id> + /api/* fetches to the viewer
    //       via postMessage (the editor origin is static FD; no
    //       dynamic endpoint to actually serve those URLs);
    //   (b) Cache Storage for heavy assets (online.wasm, soffice.data
    //       etc.) so HTTP-cache eviction doesn't trigger a 280 MB
    //       re-download on revisit.
    //
    // Why one and not two: when a per-deploy /<id>/browser/dist/sw.js
    // (scope /<id>/browser/dist/) ALSO got registered, the most-
    // specific scope won and the broader-scope bridge SW never fired.
    // Folding both responsibilities into /sw-bridge.js avoids that
    // class of bug entirely.
    window.__swBridgeReady = new Promise(function(resolve, reject) {
        if (!('serviceWorker' in navigator)) {
            mark('sw-bridge:unavailable', 'no navigator.serviceWorker');
            return reject(new Error('serviceWorker unavailable'));
        }
        navigator.serviceWorker.register('/sw-bridge.js', { scope: '/' })
            .then(function(reg) {
                mark('sw-bridge:registered', 'scope=' + reg.scope);
                function ready() {
                    mark('sw-bridge:ready', 'controller=' + !!navigator.serviceWorker.controller);
                    resolve(reg);
                }
                if (navigator.serviceWorker.controller) return ready();
                navigator.serviceWorker.addEventListener('controllerchange', ready, { once: true });
            })
            .catch(function(err) {
                mark('sw-bridge:register_failed', err.message);
                reject(err);
            });
    });

    // ───── PARENT ↔ SW BRIDGE RELAY ─────
    // The bridge SW (sw-bridge.js) catches a fetch and posts to this
    // page (we're its controlled client). We forward to window.parent
    // (the viewer). The viewer's reply lands on our `message` listener
    // and we forward it back to the SW.
    //
    // Origin checks: the viewer's origin is known via ?fileStorageUrl
    // (set by the viewer when it built the iframe URL) or document.
    // referrer. We trust postMessages only from that origin.
    var __viewerOrigin = (function() {
        var p = params.get('fileStorageUrl');
        if (p) { try { return new URL(p).origin; } catch (_) {} }
        if (document.referrer) { try { return new URL(document.referrer).origin; } catch (_) {} }
        try { return window.parent.location.origin; } catch (_) {}
        return null;
    })();
    mark('sw-bridge:viewerOrigin', __viewerOrigin || '(unknown)');

    if ('serviceWorker' in navigator) {
        // SW → page → parent
        navigator.serviceWorker.addEventListener('message', function(ev) {
            var msg = ev.data;
            if (!msg) return;
            if (msg.type === 'sw-bridge-request') {
                if (!__viewerOrigin || window.parent === window) {
                    // Standalone visit (no viewer parent): reply
                    // immediately with a "go to network" signal so the
                    // SW falls through without burning its 15s timeout.
                    if (navigator.serviceWorker.controller) {
                        navigator.serviceWorker.controller.postMessage({
                            type: 'sw-bridge-response',
                            id: msg.id,
                            status: 0,            // sentinel: "no bridge available"
                            headers: {},
                            body: null,
                        });
                    }
                    return;
                }
                var transfer = msg.body ? [msg.body] : [];
                window.parent.postMessage(msg, __viewerOrigin, transfer);
            } else if (msg.type === 'precache:done') {
                window.__swPrecacheDone = msg;
                mark('sw:precache_done',
                    'cached=' + msg.cached + ' fetched=' + msg.fetched +
                    ' failed=' + msg.failed);
            }
        });

        // parent → page → SW
        window.addEventListener('message', function(ev) {
            if (__viewerOrigin && ev.origin !== __viewerOrigin) return;
            var msg = ev.data;
            if (!msg || msg.type !== 'sw-bridge-response') return;
            if (!navigator.serviceWorker.controller) return;
            var transfer = msg.body ? [msg.body] : [];
            navigator.serviceWorker.controller.postMessage(msg, transfer);
        });
    }

    // ───── UNREGISTER LEGACY PER-DEPLOY SW ─────
    // Older builds registered /<APP_BUILD_ID>/browser/dist/sw.js.
    // It still shadowed sw-bridge.js for the iframe (more specific
    // scope) until we unregistered it. Sweep any stale registrations
    // whose scriptURL matches sw.js so the page's controller becomes
    // /sw-bridge.js on the next page load.
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(function(regs) {
            regs.forEach(function(r) {
                var s = (r.active && r.active.scriptURL) ||
                        (r.installing && r.installing.scriptURL) ||
                        (r.waiting && r.waiting.scriptURL) || '';
                if (s && /\/sw\.js(\?|$)/.test(s)) {
                    mark('sw:unregister_legacy', s);
                    r.unregister();
                }
            });
        }).catch(function(){});
    }

    // ───── EARLY SNAPSHOT CHECK ─────
    // Only check if a snapshot EXISTS (HEAD check, no body materialization).
    // The actual 73MB ArrayBuffer is loaded lazily in the deploy.sh injection
    // right before callMain — after the WASM module has fully instantiated.
    // Loading it eagerly caused memory pressure that broke __wasm_call_ctors.
    window.__wasmSnapshotData = undefined; // undefined = not yet checked
    window.__wasmSnapshotExists = false;
    // Promise variant of __wasmSnapshotData — set as soon as cache.match()
    // returns the heap Response. emscripten-module.js.m4's preRun awaits
    // THIS instead of re-opening Cache Storage to do its own redundant
    // 142 MB read (saved ~485 ms on every warm restore).
    window.__wasmSnapshotDataPromise = null;

    // Shared snapshot-read helper. Kicks off the 142 MB arrayBuffer()
    // read immediately and publishes the Promise so emscripten-module's
    // preRun can await it (avoiding a redundant second 142 MB read from
    // Cache Storage — that was the original win of this consolidation).
    //
    // Earlier version (2026-05-28) wrapped the arrayBuffer() call in
    // requestIdleCallback to defer the main-thread Promise resolution
    // past bundle.js eval (extra ~1.2 s win on warm-1). In practice
    // requestIdleCallback NEVER fires during the WASM compile + init
    // window (browser is too busy to enter idle), so the Promise stays
    // unresolved, preRun's run dependency never clears, and callMain
    // never runs — every doc cold-opens to a permanent loading state.
    // Caused 47 → 49 new test failures across the suite (cold-load
    // gate timeouts). Reverted to plain `arrayBuffer()` — keep the
    // ~485 ms saving from killing the second read; accept the ~1.2 s
    // warm-1 first-paint cost.
    function startSnapshotRead(heapResp) {
        var promise = heapResp.arrayBuffer().then(function (buf) {
            window.__wasmSnapshotData = buf;
            mark('snapshot:heap_loaded',
                 (buf.byteLength / 1048576).toFixed(0) + 'MB');
            return buf;
        }).catch(function (e) {
            mark('snapshot:heap_load_failed', e.message);
            window.__wasmSnapshotData = null;
            return null;
        });
        window.__wasmSnapshotDataPromise = promise;
        return promise;
    }
    // KILLSWITCH (2026-04-26): the addRunDependency dup-id assert is fixed
    // (emscripten-module.js now uses 'snapshot-load-emm'), and warm restore
    // reaches `emscripten:calledRun` + `snapshot:signal restored` at ~5.1 s
    // (vs ~8.6 s cold). BUT the user-facing doc-load on warm still hangs:
    // WasmDocReady postMessage never fires through the cold-protocol load.
    // Until that final piece is in: keep cold-only.
    // SNAPSHOT_DISABLED: hard-coded killswitch. Default FALSE (snapshot
    // enabled — warm path is the production behaviour). Opt-out via
    // ?planc=0 on the editor iframe URL for one-off cold-only testing.
    // Pre-2026-04-28-evening this was the other way around (default
    // true, opt-in via ?planc=1) while warm path was being stabilised.
    var SNAPSHOT_DISABLED = false;
    try {
        var __plancParam = new URLSearchParams(window.location.search).get('planc');
        if (__plancParam === '0' || __plancParam === 'off') {
            SNAPSHOT_DISABLED = true;
            window.__plancOptOut = true;
        } else {
            window.__plancOptIn = true;
        }
    } catch (e) { /* ignore */ }
    // When the snapshot is killed there's no value in preloading
    // Writer/Calc/Impress in Desktop::Main — and worse, doing so
    // emits notebookbar/sidebar JSDialog payloads for all three over
    // the fakesocket. dispose() releases the C++ Document but COOL JS
    // never gets a "remove these buttons" message, so a Writer doc
    // ends up rendered with leftover Calc tabs ("Formula") and a
    // duplicate floating-navigator. This flag is read by main.js's
    // onRuntimeInitialized hook which ccalls wasm_set_preload_disabled
    // before main() runs Desktop::Main.
    window.__wasmKillswitchPreloadDisabled = !!SNAPSHOT_DISABLED;
    window.__wasmSnapshotPromise = (function() {
        if (SNAPSHOT_DISABLED) {
            mark('snapshot:disabled_by_killswitch');
            window.__wasmSnapshotData = null;
            // Do NOT wipe Cache Storage here. ?planc=0 is set by two
            // distinct paths: (a) explicit URL opt-out for one-off
            // cold-only testing, and (b) the viewer's 60 s cross-type
            // canvas-paint watchdog after a sectionContainer leak.
            // Path (b) is a transient session-level recovery — wiping
            // the snapshot makes the next page-load cold too, and the
            // cycle repeats every time the user opens this heavy file
            // (see incident on 2026-05-06 with heavy-50slides.pptx
            // taking > 60 s to fire WasmPrewarmReady on Azure). The
            // fingerprint guard in the lookup already discards stale
            // snapshots from older builds, so leaving the cache
            // populated on planc=0 is safe.
            return Promise.resolve(null);
        }
        if (!('caches' in self)) {
            mark('snapshot:no_cache_api');
            window.__wasmSnapshotData = null;
            return Promise.resolve(null);
        }
        // Iter 29: removed iter 14's navigator.locks 'wasm-cold-init'
        // serialisation. Bisect against regression-mouse-select-copypaste
        // showed it broke A↔B input propagation under puppeteer's two
        // browser contexts (which share the lock space): with the lock,
        // typing in A never reaches B and vice versa. Without the lock
        // both directions work.
        //
        // What iter 14 protected against (parallel cold inits both
        // saving snapshots → QuotaExceededError on the second put) is
        // already covered by iter A9's cache.delete-before-put +
        // fingerprint-guard (a stale snapshot is rejected on read), so
        // dropping the lock doesn't reintroduce the original bug.
        return caches.open('wasm-snapshot').then(function(cache) {
            return Promise.all([
                cache.match('/snapshot/heap-v2'),
                cache.match('/snapshot/meta'),
            ]);
        }).then(function(results) {
            var heapResp = results[0];
            var metaResp = results[1];
            if (!heapResp) {
                mark('snapshot:not_found');
                logTiming('Snapshot: not found (cold start)');
                window.__wasmSnapshotData = null;
                return null;
            }
            // Check fingerprint: reject stale snapshots from older WASM binaries.
            // STRICT: require both (a) the build fingerprint was injected by
            // deploy.sh AND (b) the saved snapshot has a fingerprint field
            // matching the current one. Pre-fingerprint snapshots and
            // missing-meta snapshots are rejected — restoring an
            // incompatible heap into a different binary leads to UB
            // (typically a "memory access out of bounds" trap inside
            // libc++ ostream code as soon as main() runs).
            var fingerprintInjected = (BUILD_FINGERPRINT !== '__WASM_BUILD' + '_FINGERPRINT__');
            function discardStale(reason) {
                mark('snapshot:stale', reason);
                console.log('[snapshot] Discarding stale snapshot:', reason);
                return caches.open('wasm-snapshot').then(function(c) {
                    return Promise.all([c.delete('/snapshot/heap-v2'), c.delete('/snapshot/meta')]);
                }).then(function() {
                    window.__wasmSnapshotData = null;
                    return null;
                });
            }
            if (fingerprintInjected) {
                if (!metaResp) {
                    return discardStale('no-meta (legacy save format)');
                }
                return metaResp.clone().json().then(function(meta) {
                    if (!meta.fingerprint) {
                        return discardStale('meta-without-fingerprint (legacy save)');
                    }
                    if (meta.fingerprint !== BUILD_FINGERPRINT) {
                        return discardStale('stored=' + meta.fingerprint + ' current=' + BUILD_FINGERPRINT);
                    }
                    // Carry the saved doctype across to the warm-restore
                    // watchdog: when meta.docType is the legacy warmup-only
                    // (factories warmed but no user doc) and the URL is a
                    // calc / impress file, parsing the user file inside the
                    // restored heap takes 20-40 s on its own — the default
                    // 8 s watchdog would kill a perfectly healthy restore.
                    window.__wasmRestoredDocType = meta.docType || '';
                    // Fingerprint matches — snapshot is valid. Schedule the
                    // 142 MB ArrayBuffer materialisation via requestIdleCallback
                    // (or setTimeout 0 fallback) so it doesn't block bundle.js
                    // parse + WASM module instantiate during the warm-1 init
                    // window. emscripten-module.js.m4's preRun awaits
                    // __wasmSnapshotDataPromise instead of re-opening
                    // Cache Storage and re-reading the same 142 MB — that
                    // duplication was costing ~485 ms on every warm restore.
                    mark('snapshot:exists');
                    logTiming('Snapshot: found (warm start)');
                    window.__wasmSnapshotExists = true;
                    return startSnapshotRead(heapResp);
                }).catch(function(e) {
                    return discardStale('meta-parse-error: ' + (e.message || ''));
                });
            }
            // Dev mode: BUILD_FINGERPRINT not injected. Accept whatever's there.
            mark('snapshot:exists');
            window.__wasmSnapshotExists = true;
            return startSnapshotRead(heapResp);
        }).catch(function(e) {
            mark('snapshot:cache_error', e.message);
            window.__wasmSnapshotData = null;
            return null;
        });
    })();

    // Unique fingerprint for THIS WASM runtime instance. Survives only as
    // long as the iframe doesn't reload; if a test sees the same value
    // before AND after a switchdocument it knows the runtime was reused
    // (i.e. true hot-switch, not a hidden reload).
    window.__wasmRuntimeId = 'rt-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);
    mark('loader:runtimeId', window.__wasmRuntimeId);

    // ───── PROGRESS BAR ─────
    var BLANK_NAMES = ['__prewarm_blank.docx', '__prewarm_blank.txt', 'blank.docx', 'blank.txt'];
    function isBlank(name) { return BLANK_NAMES.indexOf((name||'').split('?')[0]) >= 0; }
    function prettyName(name) {
        if (!name) return '';
        return decodeURIComponent(name.split('?')[0].split('#')[0]);
    }
    function updateProgress(label, pct, detail) {
        var l = document.getElementById('wasm-progress-label');
        var f = document.getElementById('wasm-progress-bar-fill');
        var d = document.getElementById('wasm-progress-detail');
        if (l && label) l.textContent = label;
        if (f && pct != null) f.style.width = Math.max(0, Math.min(100, pct)) + '%';
        if (d && detail != null) d.textContent = detail;
        // Checklist step 1 ('dl' — Downloading editor assets) tracks the
        // page-wide download progress that this callback aggregates over
        // every fetched file. Once the download bar saturates the
        // download step is done and the next step (Initializing) starts.
        if (typeof setChecklistStep === 'function' && typeof pct === 'number') {
            if (pct > 0 && pct < 99) setChecklistStep('dl', 'in-progress');
            else if (pct >= 99) {
                setChecklistStep('dl', 'done');
                setChecklistStep('init', 'in-progress');
            }
        }
        // Forward to parent so the viewer's shield (which hides the iframe
        // during pre-warm) can show the same progress to the user.
        try {
            parent.postMessage(JSON.stringify({
                MessageId: 'WasmProgress',
                Values: { label: label, pct: pct, detail: detail }
            }), '*');
        } catch(e) {}
    }
    // Four-step checklist surfaced to the user during the cold-open wait.
    // Each step has a state icon (○ pending / ◔ in-progress / ✓ done /
    // ✗ failed). Drives off events that already fire — see setChecklistStep
    // callers below: download progress, WASM compile/runtime_initialized,
    // first kit message, and fireDocReady.
    var CHECKLIST_STEPS = [
        { id: 'dl',   label: 'Downloading editor assets' },
        { id: 'init', label: 'Initializing editor' },
        { id: 'conn', label: 'Connecting to document' },
        { id: 'doc',  label: 'Opening document' },
    ];
    function ensureOverlay(label, pct, detail) {
        var o = document.getElementById('wasm-loading-overlay');
        if (!o) {
            // Recreate overlay (was removed after prewarm).
            o = document.createElement('div');
            o.id = 'wasm-loading-overlay';
            var listHtml = '<ul id="wasm-progress-checklist">' +
                CHECKLIST_STEPS.map(function(s) {
                    return '<li data-step="' + s.id + '" data-state="pending">' +
                           '<span class="wpc-icon">○</span>' +
                           '<span class="wpc-label">' + s.label + '</span></li>';
                }).join('') + '</ul>';
            o.innerHTML =
                '<div id="wasm-spinner"></div>' +
                '<div id="wasm-progress-label"></div>' +
                '<div id="wasm-progress-bar"><div id="wasm-progress-bar-fill"></div></div>' +
                '<div id="wasm-progress-detail"></div>' +
                listHtml;
            // Inject the same styles if missing
            if (!document.getElementById('wasm-loading-style')) {
                var st = document.createElement('style');
                st.id = 'wasm-loading-style';
                st.textContent =
                    '#wasm-loading-overlay{position:fixed;inset:0;background:#f5f5f5;z-index:999999;' +
                    'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
                    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#333;}' +
                    '#wasm-spinner{width:64px;height:64px;border:6px solid #ddd;border-top-color:#4a90e2;' +
                    'border-radius:50%;animation:wasmspin 1s linear infinite;margin-bottom:16px;}' +
                    '@keyframes wasmspin{to{transform:rotate(360deg);}}' +
                    '#wasm-progress-label{font-size:15px;font-weight:500;margin-bottom:8px;}' +
                    '#wasm-progress-bar{width:300px;height:12px;background:#e0e0e0;border-radius:6px;overflow:hidden;margin-bottom:6px;}' +
                    '#wasm-progress-bar-fill{height:100%;background:linear-gradient(90deg,#4a90e2,#357abd);' +
                    'width:0%;transition:width 0.3s ease;}' +
                    '#wasm-progress-detail{font-size:12px;color:#666;}' +
                    '#wasm-progress-checklist{list-style:none;padding:0;margin:18px 0 0;' +
                    'font-size:13px;color:#555;min-width:300px;}' +
                    '#wasm-progress-checklist li{display:flex;align-items:center;gap:8px;' +
                    'padding:3px 0;line-height:1.4;}' +
                    '#wasm-progress-checklist .wpc-icon{display:inline-block;width:16px;' +
                    'text-align:center;font-weight:600;}' +
                    '#wasm-progress-checklist li[data-state="pending"] .wpc-icon{color:#bbb;}' +
                    '#wasm-progress-checklist li[data-state="in-progress"] .wpc-icon{color:#4a90e2;}' +
                    '#wasm-progress-checklist li[data-state="done"] .wpc-icon{color:#2e7d32;}' +
                    '#wasm-progress-checklist li[data-state="failed"] .wpc-icon{color:#c62828;}' +
                    '#wasm-progress-checklist li[data-state="pending"] .wpc-label{color:#999;}' +
                    '#wasm-progress-checklist li[data-state="done"] .wpc-label{color:#666;}';
                document.head.appendChild(st);
            }
            (document.body || document.documentElement).appendChild(o);
        }
        o.style.opacity = '1';
        o.style.transition = '';
        updateProgress(label, pct, detail);
    }
    var CHECKLIST_GLYPHS = {
        'pending':     '○', // ○
        'in-progress': '◔', // ◔
        'done':        '✓', // ✓
        'failed':      '✗', // ✗
    };
    function setChecklistStep(id, state) {
        var li = document.querySelector(
            '#wasm-progress-checklist li[data-step="' + id + '"]');
        if (!li) return;
        var prev = li.getAttribute('data-state');
        if (prev === state || prev === 'done' && state === 'in-progress') return;
        li.setAttribute('data-state', state);
        var icon = li.querySelector('.wpc-icon');
        if (icon) icon.textContent = CHECKLIST_GLYPHS[state] || icon.textContent;
        // Forward checklist state to the parent's pre-warm shield (mirrors
        // the existing WasmProgress postMessage pattern).
        try {
            var all = Array.prototype.map.call(
                document.querySelectorAll('#wasm-progress-checklist li'),
                function(el) {
                    return { id: el.getAttribute('data-step'),
                             state: el.getAttribute('data-state') };
                });
            parent.postMessage(JSON.stringify({
                MessageId: 'WasmProgress',
                Values: { checklist: all },
            }), '*');
        } catch (_) {}
    }
    window.__setChecklistStep = setChecklistStep;
    function hideOverlay() {
        var o = document.getElementById('wasm-loading-overlay');
        if (!o) return;
        o.style.transition = 'opacity 0.4s';
        o.style.opacity = '0';
        setTimeout(function() { if (o.parentNode) o.parentNode.removeChild(o); }, 500);
    }
    window.__updateProgress = updateProgress;
    window.__hideOverlay = hideOverlay;
    window.__ensureOverlay = ensureOverlay;

    // Initial label depends on whether we are pre-warming or actually loading
    var initialIsBlank = isBlank(wopiSrc);
    updateProgress(initialIsBlank ? 'Loading editor…' : ('Opening ' + prettyName(wopiSrc) + '…'), 2);

    // ───── HASH-SWITCH BRIDGE ─────
    window.__wasmPrewarmReady = false;
    var lastHash = '';
    // One-shot flag: set true once the initial document has loaded for the
    // first time. Stays true forever — distinct from __wasmPrewarmReady which
    // we reset on switch.
    window.__wasmInitialDocLoaded = false;
    // Track the canvas pixel hash before a switch so we can detect when the
    // user-visible content actually changes. A "blank-ish" canvas hash means
    // either the empty pre-warm doc or a still-loading doc — we only signal
    // shield-can-drop when pixels diverge from the recorded baseline AND the
    // canvas is non-trivial (has actual ink).
    var canvasBaseline = null;
    function snapshotCanvas() {
        var c = document.querySelector('canvas');
        if (!c) return null;
        try { return c.toDataURL('image/png').substring(0, 200); }
        catch(e) { return null; }
    }

    // ───── EVENT-DRIVEN DOC-READY (Phase 1) ─────
    // Kit emits a `docready: viewid=N type=text path=cold|switch|warm` text
    // frame from kit/ChildSession.cpp at three sites (cold load, hot-switch,
    // warm-restore re-attach). The historical mechanism — polling DOM
    // status text + canvas pixel-hash — is fragile (60 s timeouts on
    // Azure cold loads, doctype-specific quirks). The kit knows
    // authoritatively when the doc is loaded; we just route that signal
    // into the existing fan-out (`__wasmInitialDocLoaded`,
    // `__wasmPrewarmReady`, `WasmDocReady` postMessage, etc).
    //
    // Phase 1 (this commit) — the polling stays in place. Both paths
    // call `fireDocReady(opts)`; whoever wins records via
    // `recordReadyArrival(source)` and we log `[event-vs-poll]` per
    // load so we can verify the kit event consistently arrives first
    // before deleting the polling in Phase 4.
    //
    // Idempotency keyed on the loaded filename. Each switchdoc resets
    // `__docReadyFiredFor` to null so the next load re-fires.
    window.__docReadyFiredFor = null;
    window.__docReadyArrivals = {};
    function fireDocReady(opts) {
        opts = opts || {};
        var key = String(opts.filename || window.__wasmLoadedDocName ||
                         pendingSwitchFilename || 'cold');
        if (window.__docReadyFiredFor === key) return false;
        window.__docReadyFiredFor = key;
        mark('bridge:doc_ready', (opts.source || '?') + ' ' + key +
                                  (opts.type ? ' (' + opts.type + ')' : ''));
        // Fan out to existing signals so consumers don't need a code change.
        window.__wasmPrewarmReady = true;
        window.__wasmInitialDocLoaded = true;
        // Cascade the loading-screen checklist forward. Some of these
        // intermediate steps don't have their own emit hooks worth wiring
        // (initialize + connect happen too close together to surface
        // meaningfully); marking them done here on doc-ready captures the
        // end state without inventing fake transitions.
        if (typeof setChecklistStep === 'function') {
            setChecklistStep('dl',   'done');
            setChecklistStep('init', 'done');
            setChecklistStep('conn', 'done');
            setChecklistStep('doc',  'done');
        }
        // Hide the loading overlay. Pre-#116-phase-4 the docPoll branch
        // at line ~2005 set `__wasmPrewarmReady = true` AND fired
        // `setTimeout(hideOverlay, 150)`. Phase-4 moved fan-out to the
        // kit-driven event path here, which set `__wasmPrewarmReady`
        // first — making the docPoll branch short-circuit and never
        // fire its `hideOverlay`. The overlay then stayed up, covering
        // user UI (writer-navigator-flash test caught this: clicks on
        // the floating Navigator icon went to the overlay instead of
        // the button). Mirror the same 150 ms delay so the user sees
        // the "Ready" state briefly before the overlay fades.
        if (typeof updateProgress === 'function') updateProgress('Ready', 100);
        if (typeof hideOverlay === 'function') setTimeout(hideOverlay, 150);
        try {
            if (window.parent && window.parent !== window) {
                window.parent.postMessage(JSON.stringify({
                    MessageId: 'WasmDocReady',
                    Values: { filename: key, source: opts.source || 'kit' }
                }), '*');
            }
        } catch (_) {}
        return true;
    }
    // `overrideT` lets the kit-side dispatch fork capture the true
    // arrival timestamp at the moment the docready: frame lands, while
    // the actual slot write may be deferred (see __onDocReadyFrame
    // below — kit can fire before window.__wasmLoadedDocName is set,
    // so we wait for the name to reconcile under the same key the
    // poll path uses, but the timestamp we compare must still be the
    // real arrival time, not the deferred-write time).
    function recordReadyArrival(source, overrideT) {
        var key = String(window.__wasmLoadedDocName ||
                         pendingSwitchFilename || 'cold');
        var slot = window.__docReadyArrivals[key] = window.__docReadyArrivals[key] || {};
        if (slot[source] != null) return;   // first wins per source
        slot[source] = overrideT != null ? overrideT : performance.now();
        if (slot.kit != null && slot.poll != null) {
            var winner = slot.kit < slot.poll ? 'kit' : 'poll';
            var deltaMs = Math.abs(slot.kit - slot.poll).toFixed(0);
            mark('event-vs-poll', winner + '+' + deltaMs + 'ms key=' + key);
            // Phase 1 stays passive — don't act on the winner here, the
            // poll path already called fireDocReady (idempotent). The
            // mark feeds the gating decision for the Phase 4 cleanup.
            delete window.__docReadyArrivals[key];
        }
    }

    // task #116 phase 1: event-driven doc-ready, JS-side receiver for
    // wasmapp.cpp's send2JS fork. We capture the kit arrival time at
    // frame landing, then defer the slot write until the polling path
    // has set window.__wasmLoadedDocName so both sources record under
    // the same key (prior attempt — PR #102, reverted as PR #104 —
    // recorded under "cold" while poll recorded under the filename,
    // so [event-vs-poll] never reconciled).
    //
    // We DO NOT call fireDocReady from this path. PR #102 did, and it
    // fanned out (window.__wasmInitialDocLoaded, WasmDocReady, etc)
    // BEFORE canvas paint completed, regressing ~20 kit-paint tests
    // (2browser, 3browser, e2e-upload, latejoin, pptx, pptx-coedit,
    // checkpoint-cursor-delete, …). Fan-out stays driven by the
    // polling path, which already gates on canvas-paint via the
    // existing pixel-hash + status-text watchdog. The kit event is
    // purely telemetry here; in a future Phase 4 — after a week of
    // observed >99% kit-first arrivals — the polling code at lines
    // ~880 and ~1700 can be deleted and the kit event drives fan-out
    // directly. But ONLY once we trust the timing.
    //
    // Set __docReadyHookInstalled = true at module init so the
    // legacy TheFakeWebSocket.onmessage wrap-installer (installDocReadyHook
    // below) short-circuits — it's only a fallback for old WASM
    // binaries without the send2JS fork.
    window.__docReadyHookInstalled = true;
    globalThis.__onDocReadyFrame = function (frame) {
        try {
            if (typeof frame !== 'string') return;
            if (frame.indexOf('docready:') !== 0) return;
            var kitArrivalT = performance.now();
            var tries = 0;
            var commit = function () {
                // Phase 4 cleanup: kit event drives fan-out directly.
                // Polling removed (telemetry showed 24/24 sessions
                // kit-first, median 1.8s ahead). The polling used to
                // set __wasmLoadedDocName as a side-effect; do that
                // here from pendingSwitchFilename if not already set.
                if (!window.__wasmLoadedDocName && pendingSwitchFilename) {
                    window.__wasmLoadedDocName = pendingSwitchFilename;
                }
                recordReadyArrival('kit', kitArrivalT);
                fireDocReady({
                    source: 'kit',
                    filename: window.__wasmLoadedDocName ||
                              pendingSwitchFilename || undefined,
                });
            };
            var waitForName = function () {
                if (window.__wasmLoadedDocName || pendingSwitchFilename
                    || tries++ > 200) {
                    commit();
                } else {
                    setTimeout(waitForName, 25);
                }
            };
            waitForName();
        } catch (_) { /* never block the kit's main thread */ }
    };
    mark('docready-hook:send2js-installed');

    // Installer for the docready: text-frame parser. Runs idempotently;
    // can be called from multiple call sites (cold-load init below, the
    // switch-flow's existing __switchMsgHooked block) — first one to find
    // TheFakeWebSocket wins. Uses a polling installer (50 ms × 600) only
    // because the WS is wired late by the WASM runtime; the actual hook
    // is event-driven once installed.
    //
    // KNOWN LIMITATION (logged for the next iteration to address):
    // Plain wrap-then-assign loses the hook the moment COOL's
    // browser/src/app/Socket.ts:292 runs `this.socket.onmessage =
    // this._slurpMessage.bind(this)` after Socket connects. So this
    // hook only sees frames that arrive BEFORE Socket connects (rare
    // — kit emits docready: AFTER doc loads which is well after
    // Socket connects). A previous attempt to fix this with
    // Object.defineProperty(fws, 'onmessage', { get, set }) broke
    // COOL's normal message processing across 27+ test surfaces
    // (build local-2026-05-07-28: 31p/50f vs 77p/4f baseline) and
    // was reverted. The structural fix is to install the parser at a
    // different layer (e.g. patch send2JS in wasm/wasmapp.cpp to
    // dispatch a separate docready: handler before forwarding to
    // TheFakeWebSocket.onmessage). Tracked in the dev-iterate
    // backlog as "iter 2 redo: kit-side dispatch fork for docready:".
    window.__docReadyHookInstalled = window.__docReadyHookInstalled || false;
    function installDocReadyHook() {
        if (window.__docReadyHookInstalled) return;
        var tries = 0;
        var iv = setInterval(function () {
            var fws = globalThis.TheFakeWebSocket;
            if (!fws) {
                if (++tries > 600) clearInterval(iv);   // 30 s ceiling
                return;
            }
            clearInterval(iv);
            if (window.__docReadyHookInstalled) return;
            window.__docReadyHookInstalled = true;
            var origOnMsg = fws.onmessage;
            fws.onmessage = function (ev) {
                var txt = (typeof ev.data === 'string' ? ev.data : '');
                if (txt.indexOf('docready:') === 0) {
                    // Parse "docready: viewid=N type=X path=Y"
                    var m = /\btype=(\S+)/.exec(txt);
                    var p = /\bpath=(\S+)/.exec(txt);
                    var fired = fireDocReady({
                        source: 'kit-' + (p ? p[1] : '?'),
                        type: m ? m[1] : null,
                    });
                    if (fired) recordReadyArrival('kit');
                }
                if (typeof origOnMsg === 'function')
                    return origOnMsg.apply(this, arguments);
            };
            mark('docready-hook:installed');
        }, 50);
    }
    // Kick off the cold-load installer immediately. Switch-flow path
    // calls it again, but the idempotency guard makes that a no-op.
    installDocReadyHook();
    function isCanvasNonBlank(sample) {
        // Empty docs render as a near-uniform white canvas. Non-blank rendering
        // produces high pixel variance which compresses to very different PNG
        // base64 prefixes. We compare against the recorded baseline string.
        if (!sample || !canvasBaseline) return false;
        return sample !== canvasBaseline;
    }
    var pendingSwitchFilename = null;
    // Bug iter 17: cancel the previous switchdoc title-poll interval before
    // starting a new one. Without this each hot-switch leaks a 15 s @
    // 250 ms interval. After A→B→A we had two parallel writers each
    // pushing a different displayName at offset cadences — the user saw
    // the title flicker between names every ~150 ms for ~10 s.
    var __docNameSetInt = null;
    function trySendSwitch() {
        if (!pendingSwitchFilename) return;
        // Three things must be true before we can send a switchdocument:
        //  1. WASM libc init done (otherwise malloc aborts)
        //  2. postMobileMessage is wired
        //  3. The INITIAL document has at some point loaded — otherwise our
        //     message is the first on the fake socket and COOLWSD's accept
        //     loop will interpret "switchdocument" as a new docKey.
        if (typeof globalThis.postMobileMessage !== 'function'
            || !window.__wasmInitialDocLoaded) {
            return; // poll loop will retry
        }
        var filename = pendingSwitchFilename;
        pendingSwitchFilename = null;
        // Update __wasmDocType to reflect the new file's expected doc class
        // so anything else querying it gets the right value.
        var newExt = filename.split('.').pop().toLowerCase().split('?')[0];
        var newDocType = 'writer';
        if (['xlsx','xls','ods','csv','tsv'].indexOf(newExt) >= 0) newDocType = 'calc';
        else if (['pptx','ppt','odp','ppsx','pps'].indexOf(newExt) >= 0) newDocType = 'impress';
        window.__wasmDocType = newDocType;
        // Record canvas baseline so we can detect when the new doc actually
        // paints. Then start polling for a pixel change AND post an event to
        // the parent the moment we see one — this lets the viewer drop its
        // shield far earlier than waiting for #StateWordCount metadata.
        canvasBaseline = snapshotCanvas();
        try {
            var cmd = 'switchdocument url=' + window.location.origin + '/wasm/' + encodeURIComponent(filename);
            // Intercept incoming messages from the WASM/C++ side to log exact
            // arrival times of status:, loaded:, invalidatetiles, and tiles.
            // This tells us how long each phase of the C++ switchdocument takes.
            if (!window.__switchMsgHooked && globalThis.TheFakeWebSocket) {
                window.__switchMsgHooked = true;
                var origOnMsg = TheFakeWebSocket.onmessage;
                if (origOnMsg) {
                    TheFakeWebSocket.onmessage = function(ev) {
                        var txt = (typeof ev.data === 'string' ? ev.data : '').substring(0, 300);
                        var sw = window.__switchSendT;
                        if (sw && (txt.indexOf('status:') === 0 || txt.indexOf('loaded:') === 0 ||
                                   txt.indexOf('invalidatetiles') === 0 || txt.indexOf('tile ') === 0 ||
                                   txt.indexOf('editor:') === 0 || txt.indexOf('statusindicator') === 0)) {
                            var dt = (performance.now() - sw).toFixed(0);
                            mark('msg:' + txt.split(' ')[0].replace(':',''), dt + 'ms  ' + txt.substring(0, 80));
                        }
                        // Cross-type hot-switch detection used to live HERE,
                        // synchronously nulling map._docLayer before Socket._onStatusMsg
                        // had a chance to run. That introduced a window where
                        // every state-change message (.uno:PageStatus, etc.)
                        // arriving between this onmessage hook and Socket's
                        // _onStatusMsg lookup-and-swap was routed to a null
                        // docLayer and silently dropped — which is why
                        // #SlideStatus stayed empty when switching to Impress.
                        //
                        // Socket._onStatusMsg already detects type mismatch
                        // and does an ATOMIC swap (remove old layer, create
                        // new layer of correct type, call initializeSpecializedUI,
                        // initializeNotebookbarInCore, initializeSidebar) all
                        // within the same synchronous call. So we just let
                        // status: flow through to Socket and stop fighting it
                        // here. wasm-loader.js retains the timing-mark hooks
                        // above but no longer manipulates the doc layer.
                        if (txt.indexOf('status:') === 0 && window.__bridgeSwitchSent) {
                            mark('msg:status_post_switch');
                        }
                        return origOnMsg.apply(this, arguments);
                    };
                }
            }
            window.__switchSendT = performance.now();
            globalThis.postMobileMessage(cmd);
            window.__bridgeSwitchSent = true;
            mark('bridge:switchdoc_sent', filename);
            // Update the COOL title bar / WOPI metadata to reflect the
            // new filename. COOL reads the title from wopi.BaseFileName
            // and renders it in #document-name-input. Without this the
            // title stays on the prewarm blank or the first doc opened.
            // Retry briefly because in the prewarm-then-click flow the
            // input element or wopi map can be reset by a late onWopiProps
            // fire; a short poll keeps our value wins.
            // Prefer the plaintext displayName when the viewer supplied
            // one (v2 opens). filename is the WOPISrc — an opaque 64-hex
            // fileId in the v2 case, which would be ugly in the title bar.
            var titleText = displayName || filename;
            try { document.title = titleText; } catch(e) {}
            // Bug iter 17: cancel any prior switch's title-poll interval
            // BEFORE arming a new one — otherwise A→B→A leaves two
            // intervals alive, each writing a different name at 250 ms,
            // and the input flickers A↔B every ~150 ms for 10 s+.
            if (__docNameSetInt) {
                clearInterval(__docNameSetInt);
                __docNameSetInt = null;
            }
            var docNameSetStart = Date.now();
            __docNameSetInt = setInterval(function() {
                try {
                    if (window.app && window.app.map && window.app.map['wopi']) {
                        // Bug iter 17 #4: only set BreadcrumbDocName, not
                        // BaseFileName. The Document-name input reads
                        // BreadcrumbDocName ?? BaseFileName, so updating
                        // BreadcrumbDocName alone is sufficient for the
                        // visible label. BaseFileName is the WOPISrc
                        // identity field used by save/rename/export and
                        // should stay = the WOPISrc. Writing displayName
                        // to it confused those paths and contributed to
                        // the v2-fileId blip when COOL re-fired wopi:.
                        window.app.map['wopi'].BreadcrumbDocName = titleText;
                    }
                    var nameInput = document.querySelector('#document-name-input');
                    if (nameInput && nameInput.value !== titleText) {
                        nameInput.value = titleText;
                    }
                } catch(e) {}
                // Bug iter 17 #3: 3 s is plenty — the wopi: from kit
                // arrives within ~1-2 s of switchdocument. 15 s was
                // belt-and-braces left over from a different race.
                if (Date.now() - docNameSetStart > 3000) {
                    clearInterval(__docNameSetInt);
                    __docNameSetInt = null;
                }
            }, 250);
        } catch(e) {
            mark('bridge:switchdoc_error', e.message);
        }
        // Poll for visible content (canvas pixels differ from baseline).
        // After the canvas changes — i.e. the new doc has actually rendered
        // — start a second poll for "interactive" (status bar populated)
        // and post WasmDocReady to the parent. Gating on canvas-change is
        // important: it ensures we don't fire WasmDocReady on the
        // PREVIOUS doc's still-displayed status text right after a
        // switchdocument cmd is sent but before the new doc has painted.
        //
        // Iter 195: hot-switch watchdog. After 3+ consecutive in-iframe
        // switchdoc operations the kit can get progressively slower (or
        // stuck); the canvas never repaints and visiblePollInterval
        // polls forever. Tell the parent so it can fall back to a cold
        // iframe reload, the same way snapshot:warm_restore does. The
        // viewer-side handler must receive a HotSwitchFailed message.
        var watchStart = performance.now();
        var hotSwitchWatchdog = setTimeout(function() {
            mark('bridge:hot_switch_watchdog', filename);
            try {
                parent.postMessage(JSON.stringify({
                    MessageId: 'HotSwitchFailed',
                    Values: { filename: filename, reason: 'no_canvas_change' }
                }), '*');
            } catch(e) {}
            clearInterval(visiblePollInterval);
        }, 25000);
        var visiblePollInterval = setInterval(function() {
            var sample = snapshotCanvas();
            if (sample && sample !== canvasBaseline) {
                var dt = (performance.now() - watchStart).toFixed(0);
                mark('bridge:canvas_visible', dt + 'ms');
                clearTimeout(hotSwitchWatchdog);
                clearInterval(visiblePollInterval);
                try {
                    parent.postMessage(JSON.stringify({
                        MessageId: 'WasmSwitchVisible',
                        Values: { filename: filename, ms: +dt }
                    }), '*');
                } catch(e) {}
                if (typeof hideOverlay === 'function') hideOverlay();
                // Phase 4 cleanup (#116): the kit's
                // LOK_CALLBACK_DOCUMENT_READY emit (handled by
                // __onDocReadyFrame) drives fan-out directly. Telemetry
                // over 24/24 sessions confirmed kit arrives 1.8s
                // before the polling-gated fan-out would have.
                //
                // Safety net: if the kit event somehow doesn't fire
                // within 8s of canvas-visible (e.g. an LO core
                // regression strips the emit, or the docready: frame
                // gets dropped by send2JS), the canvas-paint +
                // status-bar poll below kicks in as a fallback. This
                // preserves the historical behavior and the
                // canvas-paint gating that kit-paint cluster tests
                // depend on. The fallback no-ops if the kit event
                // arrived first (fireDocReady is idempotent on
                // filename).
                var fallbackStart = performance.now();
                var fallbackInterval = setInterval(function() {
                    // Kit event arrived → fan-out already done; stop polling.
                    if (window.__docReadyFiredFor === String(filename)) {
                        clearInterval(fallbackInterval);
                        return;
                    }
                    // Don't engage the polling fallback until 8s have
                    // passed without a kit event — the kit nearly always
                    // wins, no point doing canvas work in parallel.
                    if (performance.now() - fallbackStart < 8000) return;
                    var wc = document.querySelector('#StateWordCount');
                    var dp = document.querySelector('#StatusDocPos');
                    var wcReady = wc && wc.textContent && /character|word|cell|slide/i.test(wc.textContent);
                    var dpReady = dp && dp.textContent && /Sheet|Slide/i.test(dp.textContent);
                    var statusReady = wcReady || dpReady;
                    if (statusReady) {
                        clearInterval(fallbackInterval);
                        window.__wasmLoadedDocName = filename;
                        var fired = fireDocReady({
                            source: 'poll-switch-fallback', filename: filename,
                        });
                        recordReadyArrival('poll');
                        if (fired) {
                            mark('bridge:doc_ready_fallback',
                                 'kit_missed=' + (performance.now() - fallbackStart).toFixed(0) + 'ms');
                            try {
                                parent.postMessage(JSON.stringify({
                                    MessageId: 'WasmDocReady',
                                    Values: { filename: filename, ms: -1, fallback: true }
                                }), '*');
                            } catch(e) {}
                        }
                    }
                    // Hard timeout after 60s — emit timeout signal.
                    if (performance.now() - fallbackStart > 60000) {
                        clearInterval(fallbackInterval);
                        if (window.__docReadyFiredFor !== String(filename)) {
                            try {
                                parent.postMessage(JSON.stringify({
                                    MessageId: 'WasmDocReady',
                                    Values: { filename: filename, ms: -1, timeout: true }
                                }), '*');
                            } catch(e) {}
                        }
                    }
                }, 200);
            }
            if (performance.now() - watchStart > 30000) clearInterval(visiblePollInterval);
        }, 50);
    }
    function checkHashSwitch() {
        var h = window.location.hash;
        if (h === lastHash || !h) {
            trySendSwitch(); // retry pending in case runtime just became ready
            return;
        }
        lastHash = h;
        var m = h.match(/^#switchdoc=(.+)$/);
        if (!m) return;
        // switchdoc fragment is either `#switchdoc=<filename>` (legacy) or
        // `#switchdoc=<fileId>&displayName=<encoded>` (v2). Parse both.
        var raw = m[1];
        var amp = raw.indexOf('&');
        var filename = decodeURIComponent(amp >= 0 ? raw.substring(0, amp) : raw);
        if (amp >= 0) {
            var tail = new URLSearchParams(raw.substring(amp + 1));
            var dn = tail.get('displayName');
            if (dn) displayName = dn; // hoisted var from the init block
        }
        window.__bridgeLastSwitch = filename;
        pendingSwitchFilename = filename;
        mark('bridge:switchdoc_seen', filename);
        // DO NOT show the iframe's full-screen overlay during a hot-switch.
        // Earlier this called `ensureOverlay(...)` which painted a gray
        // background with z-index:999999 on top of the entire iframe — so
        // the toolbar / sidebar / stale doc all vanished, and to the user it
        // looked like the editor was reloading from scratch. Hot-switches
        // happen when the parent (viewer) is already showing its own shield
        // over the iframe, so the iframe's redundant overlay only made the
        // perceived "whole editor reload" worse. We just announce progress
        // (parent uses it) and let the parent's shield communicate "busy".
        updateProgress('Opening ' + prettyName(filename) + '…', 30, 'Switching document…');
        // Reset pre-warm flag so docPollInterval re-arms and signals 'ready'
        // again when the new doc is actually visible.
        window.__wasmPrewarmReady = false;
        // Clear the "Document ready" dedupe so the new target can log it.
        if (typeof window.__wasmLogTimingReset === 'function') {
            window.__wasmLogTimingReset('Document ready');
        }
        // Also re-arm the docPoll so it sees the new word count change.
        if (typeof startDocPoll === 'function') startDocPoll();
        trySendSwitch();
    }
    setInterval(checkHashSwitch, 300);
    window.addEventListener('hashchange', checkHashSwitch);

    // ───── INSTRUMENT NETWORK (fetch + XHR) + PROGRESS BAR ─────
    function niceName(url) {
        var u = url || '';
        var q = u.indexOf('?');
        if (q >= 0) u = u.substring(0, q);
        return u.substring(u.lastIndexOf('/')+1);
    }
    function fmtMB(bytes) { return (bytes/1048576).toFixed(1) + ' MB'; }

    // Weights for the big files (roughly based on compressed size), used to
    // convert per-file progress into a 0..90% page-wide number. Remaining 10%
    // is reserved for WASM compile + doc render.
    var PROGRESS_WEIGHTS = {
        'online.wasm':  50,  // ~66 MB brotli → heaviest
        'soffice.data': 25,  // ~20 MB
        'bundle.js':     8,
        'online.js':     3,
        'bundle.css':    2,
    };
    var progressState = { fileDone: {}, fileBytes: {} };
    function aggregateProgress() {
        var total = 0;
        for (var k in PROGRESS_WEIGHTS) {
            var w = PROGRESS_WEIGHTS[k];
            var done = progressState.fileDone[k] || 0;
            total += w * done;
        }
        return total / 100;  // result in %, capped at sum of weights (~88)
    }
    function fmtMB(bytes) {
        if (!bytes || bytes < 0) return '?';
        var mb = bytes / (1024 * 1024);
        return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB';
    }
    // Friendly per-file labels — the bare filename ("online.wasm") doesn't
    // mean anything to a non-dev user. Pair it with what the file is FOR so
    // the progress detail reads as "Editor code (online.wasm) 12.3 / 35.6 MB
    // · Fonts & data (soffice.data) 8.0 / 20 MB" — visible MB plus the
    // why-this-is-downloading context.
    var FRIENDLY_NAMES = {
        'online.wasm':  'Editor code',
        'soffice.data': 'Fonts & data',
        'bundle.js':    'UI bundle',
        'online.js':    'Loader',
        'bundle.css':   'UI styles',
    };
    // Render the detail line as `Editor code (online.wasm)  <loaded> / <total> MB  ·  …`.
    // User asked for MB-based progress (2026-05-28) — % alone hides whether
    // 67% of a 1 MB file or 67% of a 66 MB file is left. Friendly labels
    // added (2026-05-28 follow-up) so the user knows what's being loaded.
    function renderDetail() {
        var parts = Object.keys(progressState.fileBytes)
            .filter(k => progressState.fileBytes[k].total > 0)
            .map(function (k) {
                var b = progressState.fileBytes[k];
                var label = FRIENDLY_NAMES[k] ? FRIENDLY_NAMES[k] + ' (' + k + ')' : k;
                return label + ' ' + fmtMB(b.loaded) + ' / ' + fmtMB(b.total);
            });
        return parts.join('  ·  ');
    }
    function fileProgress(name, loaded, total) {
        var key = Object.keys(PROGRESS_WEIGHTS).find(k => name === k);
        if (!key) return;
        progressState.fileBytes[key] = { loaded: loaded, total: total };
        progressState.fileDone[key] = total > 0 ? Math.min(1, loaded / total) : 0;
        var pct = aggregateProgress();
        updateProgress('Downloading editor assets…', pct, renderDetail());
    }

    // Look up the perf entry written for `url` after the fetch completed.
    // transferSize === 0 (with decodedBodySize > 0) is Chrome's signal for
    // "served from disk cache, no bytes left the server". We log this so
    // a developer with the console open can confirm at a glance whether
    // a particular load was a cache hit or a real download.
    function logCacheState(url, name, fetchDurationMs) {
        // The perf entry is appended asynchronously after the response
        // is consumed; one tick later is enough.
        setTimeout(function() {
            try {
                var entries = performance.getEntriesByName(url);
                if (!entries.length) return;
                var e = entries[entries.length - 1];
                var fromCache = e.transferSize === 0 && e.decodedBodySize > 0;
                var label = fromCache ? '[cache] CACHE HIT  ' : '[cache] from network';
                console.log(label + ' ' + name +
                    ' (transfer=' + (e.transferSize/1024).toFixed(0) + 'KB,' +
                    ' decoded=' + (e.decodedBodySize/1048576).toFixed(1) + 'MB,' +
                    ' fetchTook=' + fetchDurationMs.toFixed(0) + 'ms)');
                mark(fromCache ? 'cache:hit' : 'cache:miss',
                    name + ' transfer=' + e.transferSize + ' decoded=' + e.decodedBodySize);
            } catch(err) {}
        }, 0);
    }

    var origFetch = window.fetch;
    window.fetch = function(url, opts) {
        var key = (typeof url === 'string' ? url : url.url) || '';
        var name = niceName(key);
        if (PROGRESS_WEIGHTS[name] !== undefined) {
            var tStart = performance.now();
            mark('net:fetch_start', name);

            // online.wasm: return the ORIGINAL Response untouched so
            // WebAssembly.instantiateStreaming gets a "real" response.
            // V8 caches the compiled WASM module keyed on the response
            // identity; wrapping it in new Response() breaks the cache
            // and forces a 21s recompile on every page load.
            //
            // The body bytes are consumed downstream by the WASM compiler,
            // so we can't read them for actual progress. Instead, surface
            // the Content-Length immediately (so the user sees total MB)
            // and run a time-based estimator until the perf entry confirms
            // the body fully arrived. Snaps to 100% on real completion.
            if (name === 'online.wasm') {
                return origFetch.apply(this, arguments).then(function(r) {
                    var total = parseInt(r.headers.get('content-length') || '0');
                    // Initialize the file in progressState so renderDetail()
                    // shows it from headers-arrive onward, with loaded=0.
                    progressState.fileBytes[name] = { loaded: 0, total: total };
                    progressState.fileDone[name] = 0;
                    fileProgress(name, 0, total);

                    // Estimator — assumes ~6 MB/s sustained throughput on
                    // a typical residential link. Caps at 95% so the bar
                    // doesn't claim "done" before the body actually is.
                    var ASSUMED_BPS = 6 * 1024 * 1024;
                    var estStart = performance.now();
                    var estTimer = setInterval(function () {
                        if (progressState.fileDone[name] >= 1) {
                            clearInterval(estTimer);
                            return;
                        }
                        var elapsed = (performance.now() - estStart) / 1000;
                        var estLoaded = Math.min(total * 0.95,
                            Math.round(elapsed * ASSUMED_BPS));
                        if (total > 0 && estLoaded > progressState.fileBytes[name].loaded) {
                            fileProgress(name, estLoaded, total);
                        }
                    }, 250);

                    // Watch the Resource Timing API for response completion.
                    // PerformanceResourceTiming.responseEnd marks when the
                    // FULL body has arrived (not just headers). When that
                    // entry appears, the download is genuinely done and we
                    // snap to 100% — the estimator was just visual filler.
                    var pollDone = setInterval(function () {
                        var entries = performance.getEntriesByName(key);
                        for (var i = 0; i < entries.length; i++) {
                            var e = entries[i];
                            if (e.responseEnd && e.responseEnd >= e.startTime) {
                                clearInterval(pollDone);
                                clearInterval(estTimer);
                                fileProgress(name, total || 1, total || 1);
                                progressState.fileDone[name] = 1;
                                var dur = performance.now() - tStart;
                                mark('net:fetch_end', name + ' ' + dur.toFixed(0) +
                                    'ms (unwrapped for V8 code cache)');
                                logCacheState(key, name, dur);
                                return;
                            }
                        }
                    }, 250);
                    // Safety: never leave timers running forever.
                    setTimeout(function () {
                        clearInterval(estTimer);
                        clearInterval(pollDone);
                    }, 300000);

                    return r;  // original response — V8 can cache compiled module
                });
            }

            return origFetch.apply(this, arguments).then(function(r) {
                // Stream the body so we can report progress
                if (!r.body || !r.body.getReader) {
                    progressState.fileDone[name] = 1;
                    mark('net:fetch_end', name + ' ' + (performance.now()-tStart).toFixed(0) + 'ms status=' + r.status);
                    logCacheState(key, name, performance.now() - tStart);
                    return r;
                }
                var cl = parseInt(r.headers.get('content-length') || '0');
                var reader = r.body.getReader();
                var loaded = 0;
                return new Response(new ReadableStream({
                    start: function(controller) {
                        function pump() {
                            reader.read().then(function(res) {
                                if (res.done) {
                                    progressState.fileDone[name] = 1;
                                    var dur = performance.now() - tStart;
                                    mark('net:fetch_end', name + ' ' + dur.toFixed(0) + 'ms loaded=' + loaded);
                                    logCacheState(key, name, dur);
                                    controller.close();
                                    return;
                                }
                                loaded += res.value.byteLength;
                                fileProgress(name, loaded, cl);
                                controller.enqueue(res.value);
                                pump();
                            }).catch(function(e) { controller.error(e); });
                        }
                        pump();
                    }
                }), {
                    status: r.status, statusText: r.statusText, headers: r.headers,
                });
            });
        }
        // ── Clipboard POST stub ──────────────────────────────────
        // Our document.onpaste override handles all paste logic now.
        // COOL's code should never reach this endpoint, but if some
        // code path does POST to /cool/clipboard, return a fake 200
        // so it doesn't error out.
        if (typeof key === 'string' && key.includes('/cool/clipboard') && opts && opts.method === 'POST') {
            mark('clipboard:post_stub');
            console.log('[wasm-loader] Clipboard POST stub — returning 200 (paste handled by onpaste)');
            return Promise.resolve(new Response('{"ok":true}', {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }));
        }
        // ── Clipboard GET stub ───────────────────────────────────
        // Clipboard.js `_asyncAttemptNavigatorClipboardWrite` (the
        // right-click → Copy and async-clipboard path) fetches
        // `<webserver>/cool/clipboard?WOPISrc=…&Tag=…&MimeType=text/html,
        // text/plain;charset=utf-8` to retrieve the kit's most recent
        // selection contents for `navigator.clipboard.write`. In WASM
        // there's no webserver so the request 404s and the external
        // clipboard write silently fails — cross-app paste from a
        // right-click Copy is broken.
        //
        // The kit DID already push the selection via the
        // `textselectioncontent:` message. We cache it directly off
        // TheFakeWebSocket (see installClipboardSelectionHook below) —
        // reading `app.map._clip._selectionContent` instead races: kit
        // sends `unocommandresult: .uno:Copy` AND `textselectioncontent:`
        // close together, and the fetch fires from `_onCommandResult`
        // before CanvasTileLayer has finished dispatching the text
        // message. The dedicated hook captures the bytes the moment
        // the WS frame lands.
        if (typeof key === 'string' && key.includes('/cool/clipboard') &&
            (!opts || !opts.method || opts.method === 'GET')) {
            mark('clipboard:get_stub');
            return new Promise(function(resolve) {
                // Step 1 — explicitly ask the kit for the current text
                // selection. The kit's `.uno:Copy` populates its
                // INTERNAL clipboard but does not auto-emit
                // `textselectioncontent:`; the server-side webserver
                // (which we don't have in WASM) would normally fire
                // `gettextselection` to retrieve it. Replicate that
                // call so the kit responds with `textselectioncontent:`,
                // which CanvasTileLayer routes into
                // `app.map._clip._selectionContent`. The existing
                // `document.oncopy` handler (Ctrl+C path) does the
                // same dance at lines 2027-2064.
                try {
                    if (globalThis.TheFakeWebSocket) {
                        globalThis.TheFakeWebSocket.send(
                            'gettextselection mimetype=text/html,text/plain;charset=utf-8');
                    }
                } catch (_) {}

                // Step 2 — poll for `_selectionContent` to populate.
                // textselectioncontent: typically lands within 50–
                // 200 ms of the gettextselection request; wait up to
                // 1.5 s for in-flight WS jitter.
                //
                // (Wrapping `TheFakeWebSocket.onmessage` for direct
                // capture was tried but breaks: COOL's
                // browser/src/app/Socket.ts:292 reassigns onmessage
                // after Socket connects, dropping any earlier wrapper.
                // See the comment at the docready hook above.)
                //
                // If the wait times out empty, return 404 — that way
                // `_asyncAttemptNavigatorClipboardWrite`'s
                // `clipboardItem` promise rejects, navigator.clipboard
                // is left untouched, and any prior clipboard content
                // (e.g. set by Ctrl+C earlier) stands.
                var t0 = performance.now();
                var iv = setInterval(function() {
                    var clip = null;
                    try { clip = window.app && window.app.map && window.app.map._clip; }
                    catch (_) {}
                    var html  = (clip && clip._selectionContent)          || '';
                    var plain = (clip && clip._selectionPlainTextContent) || '';
                    var elapsed = performance.now() - t0;
                    if (html || plain || elapsed > 1500) {
                        clearInterval(iv);
                        if (!html && !plain) {
                            console.log('[wasm-loader] Clipboard GET stub — ' +
                                'empty after ' + elapsed.toFixed(0) +
                                'ms, returning 404');
                            return resolve(new Response('', { status: 404 }));
                        }
                        var body = JSON.stringify({
                            'text/html': html,
                            'text/plain;charset=utf-8': plain,
                        });
                        // Seed the paste-fingerprint so a subsequent Ctrl+V
                        // from the same tab classifies as same-tab (uno:Paste),
                        // not cross-tab (HTML-bytes forward — which destroys
                        // current doc content when source==destination kit).
                        // The Ctrl+C path sets this from document.oncopy; the
                        // right-click → Copy path goes through this fetch
                        // stub and must do the same.
                        globalThis._lastCopiedPlain = plain || null;
                        console.log('[wasm-loader] Clipboard GET stub — html=' +
                                    html.length + 'b plain=' + plain.length +
                                    'b waited=' + elapsed.toFixed(0) + 'ms');
                        resolve(new Response(body, {
                            status: 200,
                            headers: { 'Content-Type': 'application/json' },
                        }));
                    }
                }, 25);
            });
        }

        return origFetch.apply(this, arguments);
    };

    // ── XHR clipboard POST stub ──────────────────────────────────
    // Same as fetch stub above — safety net for XHR-based clipboard
    // POSTs that shouldn't happen now that onpaste is overridden.
    var _origXHROpen = XMLHttpRequest.prototype.open;
    var _origXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
        this._coolUrl = url;
        this._coolMethod = method;
        return _origXHROpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(body) {
        if (this._coolMethod === 'POST' && this._coolUrl &&
            this._coolUrl.indexOf('/cool/clipboard') >= 0) {
            mark('clipboard:xhr_post_stub');
            console.log('[wasm-loader] XHR clipboard POST stub — faking 200');
            var xhr = this;
            Object.defineProperty(xhr, 'status', { get: function() { return 200; } });
            Object.defineProperty(xhr, 'readyState', { get: function() { return 4; } });
            Object.defineProperty(xhr, 'response', { get: function() { return new Blob(['OK']); } });
            setTimeout(function() {
                if (xhr.onreadystatechange) xhr.onreadystatechange();
                if (xhr.onload) xhr.onload();
            }, 50);
            return;
        }
        return _origXHRSend.apply(this, arguments);
    };

    // ── Clipboard fingerprint ──────────────────────────────────────
    // Saved by document.oncopy (set later, in docPoll). Compared by
    // the paste handler below.
    globalThis._lastCopiedPlain = null;

    // ── Ctrl+V keydown: always suppress Map.Keyboard's uno:Paste ──
    // Map.Keyboard (line 864) sends `uno .uno:Paste` on Ctrl+V keydown
    // in the mobile/Emscripten path. This fires BEFORE the paste event.
    // We always suppress it because our paste event handler decides the
    // correct action (internal vs external).
    document.addEventListener('keydown', function(ev) {
        if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey &&
            (ev.key === 'v' || ev.key === 'V')) {
            globalThis._suppressNextPaste = true;
            setTimeout(function() { globalThis._suppressNextPaste = false; }, 3000);
        }
    }, true);

    // ── PASTE handler (capture phase, registered EARLY) ──────────
    // This MUST be registered before COOL's Clipboard.js loads so it
    // fires first. stopImmediatePropagation prevents COOL's broken
    // paste path (which tries to POST to cool:/... and fails).
    //
    // Rule: always paste from the real system clipboard, UNLESS it
    // still holds what we last copied from the document.
    document.addEventListener('paste', function(ev) {
        // Guard: TheFakeWebSocket not ready yet (doc still loading)
        if (!globalThis.TheFakeWebSocket) return;

        ev.preventDefault();
        ev.stopImmediatePropagation();

        var html = ev.clipboardData ? ev.clipboardData.getData('text/html') || '' : '';
        var plain = ev.clipboardData ? ev.clipboardData.getData('text/plain') || '' : '';

        // Detect internal paste: either fingerprint matches OR the
        // HTML contains COOL's origin marker (set by our oncopy handler).
        // - fingerprintMatch implies SAME tab/kit: the kit's internal
        //   clipboard has the content, so .uno:Paste preserves richer
        //   formatting (embedded objects, shapes, charts) than the HTML
        //   round-trip would.
        // - hasCoolMarker WITHOUT fingerprintMatch implies a DIFFERENT
        //   COOL tab put it there. The destination kit is a separate
        //   process — its internal clipboard is empty — so .uno:Paste
        //   would no-op silently. Forward the HTML bytes the source
        //   wrote so the destination kit's HTML import filter produces
        //   equivalent content.
        var hasCoolMarker = html && (html.indexOf('data-coolorigin') >= 0 ||
                                     html.indexOf('meta-origin') >= 0);
        var fingerprintMatch = globalThis._lastCopiedPlain &&
                               plain === globalThis._lastCopiedPlain;
        var isInternal = hasCoolMarker || fingerprintMatch;

        if (isInternal && fingerprintMatch) {
            // Same-tab paste — uno-paste preserves richer formatting.
            console.log('[wasm-loader] Internal paste same-tab (fingerprint, ' +
                plain.length + ' chars)');
            globalThis.TheFakeWebSocket.send('uno .uno:Paste');
        } else if (isInternal && html) {
            // Cross-tab COOL→COOL paste — destination kit's internal
            // clipboard is empty, so forward HTML bytes explicitly.
            console.log('[wasm-loader] Internal paste cross-tab (COOL marker, html ' +
                html.length + ' chars)');
            globalThis.TheFakeWebSocket.send(
                new Blob(['paste mimetype=text/html\n', html]));
        } else if (html) {
            // External HTML content (from browser, Word, etc.)
            console.log('[wasm-loader] External paste (html, ' + html.length + ' chars)');
            globalThis.TheFakeWebSocket.send(
                new Blob(['paste mimetype=text/html\n', html]));
        } else if (plain) {
            // External plain text (terminal, Notepad, etc.)
            console.log('[wasm-loader] External paste (plain, ' + plain.length + ' chars)');
            globalThis.TheFakeWebSocket.send(
                new Blob(['paste mimetype=text/plain\n', plain]));
        } else {
            // Check for image in clipboardData.items (images aren't
            // available via getData(), only via items[].getAsFile())
            var imageFile = null;
            if (ev.clipboardData && ev.clipboardData.items) {
                for (var i = 0; i < ev.clipboardData.items.length; i++) {
                    var item = ev.clipboardData.items[i];
                    if (item.type && item.type.startsWith('image/')) {
                        imageFile = item.getAsFile();
                        break;
                    }
                }
            }
            if (imageFile) {
                console.log('[wasm-loader] External paste (image, ' + imageFile.type + ', ' + imageFile.size + 'B)');
                // Read the image file and send as paste blob
                var reader = new FileReader();
                reader.onload = function() {
                    var bytes = new Uint8Array(reader.result);
                    var ext = imageFile.type.split('/')[1] || 'png';
                    // Convert to base64 for insertfile command
                    var b64 = '';
                    var CHUNK = 32768;
                    for (var ci = 0; ci < bytes.length; ci += CHUNK) {
                        b64 += String.fromCharCode.apply(null, bytes.slice(ci, Math.min(ci + CHUNK, bytes.length)));
                    }
                    b64 = btoa(b64);
                    var msg = 'insertfile name=clipboard-paste.' + ext + ' type=graphic data=' + b64;
                    console.log('[wasm-loader] Image paste → insertfile (' + msg.length + ' chars)');
                    globalThis.TheFakeWebSocket.send(msg);
                };
                reader.readAsArrayBuffer(imageFile);
            } else {
                console.log('[wasm-loader] Paste: empty clipboard — ignored');
            }
        }
    }, true);

    var OrigXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function() {
        var x = new OrigXHR();
        var origOpen = x.open;
        x.open = function(method, url) {
            this.__profUrl = url;
            this.__profStart = performance.now();
            var name = niceName(url);
            if (PROGRESS_WEIGHTS[name] !== undefined || /metadata/.test(name)) {
                mark('net:xhr_open', method + ' ' + name);
                if (PROGRESS_WEIGHTS[name] !== undefined) {
                    x.addEventListener('progress', function(e) {
                        if (e.lengthComputable) fileProgress(name, e.loaded, e.total);
                    });
                    x.addEventListener('loadend', function() {
                        progressState.fileDone[name] = 1;
                        mark('net:xhr_loadend', name + ' ' + (performance.now()-x.__profStart).toFixed(0) + 'ms status=' + x.status);
                        fileProgress(name, 1, 1);
                    });
                }
            }
            return origOpen.apply(this, arguments);
        };
        return x;
    };

    // ───── POLL FOR EMSCRIPTEN MILESTONES ─────
    var seenModule = false, seenCalledRun = false, seenExports = false, seenFS = false;
    var pollInterval = setInterval(function() {
        if (!seenModule && typeof Module !== 'undefined') {
            seenModule = true; mark('emscripten:module_defined');
            updateProgress('Compiling WebAssembly…', 90);
        }
        // Expose Module.FS as window.__wasmFS for font injection and tests
        if (!seenFS && typeof Module !== 'undefined' && Module.FS) {
            window.__wasmFS = Module.FS;
            seenFS = true; mark('emscripten:FS_ready');
        }
        if (!seenExports && window.__wasmExports) {
            seenExports = true; mark('emscripten:wasmExports_ready');
            updateProgress('Initializing runtime…', 93);
        }
        if (!seenCalledRun && typeof Module !== 'undefined' && Module.calledRun) {
            seenCalledRun = true; mark('emscripten:calledRun');
            updateProgress('Opening document…', 95);

            // ── Snapshot signal + save ────────────────────────
            // On restore visits, HEAPU8 was restored before callMain by
            // the deploy.sh injection. LO Core takes SECOND_INIT (fast).
            // On first visits: Desktop::Main fires Module.__snapshotReady
            // after preloading Writer/Calc/Impress; we save HEAPU8 to
            // Cache API and then call wasm_snapshot_complete() to wake
            // the LO-side condition variable so Execute() can begin.
            (function() {
                var wasRestored = !!window.__wasmSnapshotRestored;
                mark('snapshot:signal', wasRestored ? 'restored' : 'first-visit');
                logTiming(wasRestored ? 'WASM runtime restored from snapshot' : 'WASM runtime initialized (first visit)');
                window.__wasmJsReady = true;

                // ───── PHASE-2 PIECE #3: warm-restore wire protocol ─────
                //
                // PRE-PHASE-2 BEHAVIOR (removed): on wasRestored we set
                // __wasmInitialDocLoaded=true synchronously and immediately
                // queued a switchdocument for the user's WOPISrc. That
                // shortcut races the WS upgrade — the dispatched
                // 'switchdocument url=...' arrived as the first message on
                // the new server's accept-loop and was misparsed by
                // wsd/ClientRequestDispatcher.cpp:889 as "<URL> <appDocId>",
                // logging `Bad document ID "url=https://..."` and routing
                // the connection through a half-set-up state from which
                // ChildSession::loadDocument never completed (the
                // "nodocloaded" modal alert that blocked warm restore).
                //
                // PHASE-2 BEHAVIOR: on warm restore we follow the SAME
                // wire protocol as cold start — JS goes through Socket's
                // normal _onSocketOpen path which sends coolclient +
                // load url=<wopiSrc>. The new COOLWSD's accept-loop sees
                // the load URL as its first message (correctly parsed),
                // does the WS upgrade, and ChildSession loads the user's
                // doc. The snapshot's value comes from heap-warming
                // (malloc pages, JIT'd code, fontconfig, factory init),
                // not from "doc already loaded" — that optimization is
                // future work (detecting "same URL already in heap" and
                // short-circuiting loadDocument). Keeping this code path
                // identical to cold means: zero new failure modes on
                // warm, just a smaller wall-clock time because the heap
                // pages are pre-touched.
                //
                // No-op block here intentionally — kept as documentation
                // of what the previous code did and why we removed it.
                if (wasRestored) {
                    mark('snapshot:warm_restore_using_cold_protocol');
                    // ───── WARM-RESTORE WATCHDOG ─────
                    // Hot-switch capture race (~30 % of calc/impress cold
                    // sessions) produces a snapshot that hangs on warm:
                    // worker reports cmd=loaded, COOLWSD pthread never
                    // dispatches its start_routine, doc:loaded never fires.
                    // Without this, the user stares at a spinner forever.
                    // Detect the hang at 20 s, drop the bad snapshot from
                    // Cache Storage, reload the iframe — the reload finds
                    // no snapshot and runs the cold path. Net UX: ~27 s
                    // worst-case warm vs. infinite hang. Watchdog cleared
                    // by the doc:loaded mark below, so successful warms
                    // pay nothing. window.__wasmWarmWatchdogTriggered is
                    // set so the cold reload doesn't immediately re-arm.
                    if (!window.__wasmWarmWatchdogTriggered) {
                        // The 8 s budget below assumes "snapshot doctype
                        // matches what the user is opening" — i.e. factories
                        // and module already in heap, so doc:loaded fires
                        // within a few seconds of restore. For the
                        // warmup-only snapshot opening a calc / impress
                        // file the heap has the factories but no doctype-
                        // specific module, so file parse + render takes
                        // 20-90 s on its own (worst case: heavy 50-slide
                        // pptx on Azure B1). Two distinct watchdogs cover
                        // this codepath: this one (doc:loaded) and the
                        // parent viewer's cross-type canvas-paint watchdog
                        // (180 s, sees actual paint). For the cross-doctype-
                        // warmup-only case the parent's watchdog is the
                        // better signal — it gates on rendered output
                        // rather than on Module callback timing — so we
                        // skip the inner watchdog entirely there. Long-
                        // term fix: per-fileId / per-doctype snapshot
                        // capture in C++ so the heap already has the
                        // doctype module loaded — see #170.
                        var watchdogMs = 8000;
                        var skipWatchdog = false;
                        try {
                            var mp = new URLSearchParams(window.location.search);
                            var nm = mp.get('WOPISrc') || mp.get('displayName') || '';
                            if (!nm.includes('.')) nm = mp.get('displayName') || nm;
                            var ex = nm.split('.').pop().toLowerCase().split('?')[0];
                            var crossType =
                                ['xlsx','xls','ods','csv','tsv','pptx','ppt','odp','ppsx','pps']
                                    .indexOf(ex) >= 0;
                            var savedType = window.__wasmRestoredDocType || '';
                            var generic = !savedType || savedType === 'text' ||
                                          savedType === 'warmup-only';
                            if (crossType && generic) skipWatchdog = true;
                        } catch (_) { /* keep default */ }
                        if (skipWatchdog) {
                            mark('snapshot:warm_watchdog_skipped',
                                 'cross-type-warmup-only — parent shield handles');
                        } else
                        window.__wasmWarmWatchdogTimer = setTimeout(function() {
                            try {
                                console.warn('[snapshot] Warm-restore watchdog: '
                                    + 'doc:loaded missing 8s after restore — '
                                    + 'dropping snapshot and reloading as cold');
                                window.__wasmWarmWatchdogTriggered = true;
                                // Iter A8: tell the parent viewer so subsequent
                                // iframe creations skip warm-restore entirely.
                                // Once warm-restore fails in a session, it's
                                // ~100 % reproducible on the same captured
                                // snapshot, so paying the 12 s watchdog wait
                                // every cross-type is pure overhead. Parent
                                // appends ?planc=0 to the next iframe URL.
                                try {
                                    window.parent.postMessage(JSON.stringify({
                                        MessageId: 'WarmRestoreFailed',
                                        Values: {}
                                    }), '*');
                                } catch (e) { /* ignore */ }
                                if (typeof caches !== 'undefined') {
                                    caches.open('wasm-snapshot').then(function(c) {
                                        return c.keys().then(function(keys) {
                                            return Promise.all(keys.map(function(k) {
                                                return c.delete(k);
                                            }));
                                        });
                                    }).then(function() {
                                        location.reload();
                                    }).catch(function(e) {
                                        console.error('[snapshot] Cache clear failed:', e);
                                        location.reload();
                                    });
                                } else {
                                    location.reload();
                                }
                            } catch (e) {
                                console.error('[snapshot] Watchdog handler threw:', e);
                            }
                        }, watchdogMs);  // Default 8 s — happy-path warm is
                                   // 3-5 s. Cross-doctype warmup-only
                                   // restore skips this watchdog above
                                   // (parent's cross-type canvas-paint
                                   // watchdog at 180 s is the better
                                   // signal). Bails fast so the in-iframe
                                   // cold-fallback (location.reload after
                                   // caches.delete)
                                   // finishes within typical test budgets.
                                   // Previously 30 s for both, which on
                                   // Azure (where warm-restore reliably
                                   // hangs after lok_init_2 SECOND_INIT)
                                   // ate the entire 60 s warm budget before
                                   // the fallback even started. The 8 s
                                   // watchdog + ~25 s Azure cold-with-cache
                                   // = ~33 s total wall, well under budget.
                    }
                }

                if (!wasRestored) {
                    // ───── PHASE-2 SNAPSHOT TRIGGER ─────
                    // Module.__firstDocLoaded fires from kit/ChildSession.cpp
                    // (via wasmshim::firstDocPainted) when the very first user
                    // doc finishes loading on this LOK runtime. C++ blocks on
                    // a condvar until JS captures HEAPU8 and calls
                    // wasm_first_doc_snapshot_resume.
                    //
                    // One-shot. C++ side guards via atomic CAS so subsequent
                    // doc loads (cross-module switchdoc, second user file)
                    // don't fire again.
                    //
                    // FAILURE REPORTING: any JS exception or missing capability
                    // calls wasm_snapshot_failed(reason) which both wakes the
                    // C++ wait and records a structured reason for telemetry.
                    var SNAPSHOT_FAIL = {
                        JS_EXCEPTION: 1,
                        NO_HEAPU8: 2,
                        CACHE_PUT_FAILED: 3,
                        TIMEOUT: 4,
                        KILLED: 5,
                    };
                    function reportFailureAndResume(reason, msg) {
                        mark('snapshot:fail', 'reason=' + reason + ' ' + (msg || ''));
                        try { Module.ccall('wasm_snapshot_failed', null, ['number'], [reason]); }
                        catch(e) { mark('snapshot:fail_ccall_error', e.message); }
                    }
                    function resumeLO() {
                        try { Module.ccall('wasm_first_doc_snapshot_resume', null, [], []); }
                        catch(e) { mark('snapshot:resume_error', e.message); }
                    }

                    Module.__firstDocLoaded = function(docTypeHint) {
                        console.log('PLAN_C_DBG: Module.__firstDocLoaded ENTERED docType=' + docTypeHint);
                        // Preserve legacy global for tests/observers.
                        window.__loInitDone = true;
                        window.__wasmFirstDocType = docTypeHint || 'text';
                        mark('snapshot:phase2_trigger', 'docType=' + window.__wasmFirstDocType);

                        if (SNAPSHOT_DISABLED) {
                            reportFailureAndResume(SNAPSHOT_FAIL.KILLED, 'killswitch');
                            return;
                        }
                        if (!Module || !Module.HEAPU8) {
                            reportFailureAndResume(SNAPSHOT_FAIL.NO_HEAPU8);
                            return;
                        }
                        // Find last non-zero 4-byte word — capture only the
                        // used portion (~200MB) instead of full 1GB heap.
                        var u32 = Module.HEAPU32;
                        var lastUsed = 0;
                        for (var i = u32.length - 1; i >= 0; i--) {
                            if (u32[i] !== 0) { lastUsed = (i + 1) * 4; break; }
                        }
                        var heapSize = Math.min(((lastUsed + 65535) & ~65535), Module.HEAPU8.byteLength);
                        var heapBase = 16 * 1024 * 1024;
                        try { heapBase = Module.ccall('get_heap_base', 'number', [], []); }
                        catch(e) { mark('snapshot:heap_base_fallback', e.message); }

                        mark('snapshot:capturing', (heapSize / 1048576).toFixed(0) + 'MB');
                        var t0 = performance.now();
                        var memCopy;
                        try {
                            memCopy = new ArrayBuffer(heapSize);
                            new Uint8Array(memCopy).set(Module.HEAPU8.subarray(0, heapSize));
                        } catch(ex) {
                            reportFailureAndResume(SNAPSHOT_FAIL.JS_EXCEPTION, 'capture: ' + ex.message);
                            return;
                        }
                        var captureMs = (performance.now() - t0).toFixed(0);
                        mark('snapshot:captured', captureMs + 'ms');
                        console.log('PLAN_C_DBG: heap captured ' + captureMs + 'ms, calling resumeLO');

                        // Resume Kit IMMEDIATELY after capture — before the
                        // (slow) Cache.put. Kit gets the user's input back
                        // within ~100-500ms; Cache.put runs in background.
                        resumeLO();
                        console.log('PLAN_C_DBG: resumeLO returned');

                        // PLAN C BRING-UP: skip the persistent Cache.put while
                        // warm-restore is still being stabilized. We've proven
                        // the cold-side dance (kit park, COOLWSD park, JS
                        // capture, resume) here. Persisting the snapshot would
                        // make the *next* iframe in the same browser session
                        // try to warm-restore — which is currently broken and
                        // hangs the test. Once warm-restore is stable, replace
                        // this block with the original cache.put.
                        var BRINGUP_PERSIST = true;
                        if (BRINGUP_PERSIST) {
                            var meta = JSON.stringify({
                                heapBase: heapBase,
                                size: heapSize,
                                ts: Date.now(),
                                fingerprint: BUILD_FINGERPRINT,
                                docType: window.__wasmFirstDocType,
                            });
                            // Fire the cache.put IMMEDIATELY (truly async,
                            // off-thread). When this was deferred until
                            // prewarmReady the puppeteer session would close
                            // the browser before the put finished and the
                            // warm visit saw an empty cache.
                            mark('snapshot:save_starting', '');
                            caches.open('wasm-snapshot').then(function(cache) {
                                // Iter A9: delete the old snapshot BEFORE
                                // putting the new one. Cache Storage holds
                                // both during the put-with-overwrite, so a
                                // 143 MB snapshot that overwrites itself
                                // peaks at 286 MB+. After several iframes
                                // (each capturing their own) we hit
                                // QuotaExceededError and the put fails
                                // silently — leaving stale or no snapshot
                                // for the NEXT iframe, which then warm-
                                // restore-hangs and watchdogs to cold.
                                // Delete first → put second → peak 143 MB.
                                return Promise.all([
                                    cache.delete('/snapshot/heap-v2'),
                                    cache.delete('/snapshot/meta'),
                                ]).then(function() {
                                    return cache.put('/snapshot/meta', new Response(meta, {
                                        headers: { 'Content-Type': 'application/json' }
                                    }));
                                }).then(function() {
                                    var blob = new Blob([memCopy], { type: 'application/octet-stream' });
                                    return cache.put('/snapshot/heap-v2', new Response(blob));
                                });
                            }).then(function() {
                                mark('snapshot:saved', (heapSize / 1048576).toFixed(0) + 'MB');
                            }).catch(function(err) {
                                mark('snapshot:cache_put_failed', err.message);
                            });
                        } else {
                            mark('snapshot:bringup_skipped_persist', (heapSize / 1048576).toFixed(0) + 'MB');
                            // Also wipe any stale cache so subsequent iframes
                            // in this session see "no snapshot" and run cold.
                            try { caches.open('wasm-snapshot').then(function(c) {
                                c.delete('/snapshot/meta'); c.delete('/snapshot/heap-v2');
                            }); } catch (e) { /* ok */ }
                        }
                    };
                }
            })();
        }
    }, 50);

    // ───── POLL DOC LOAD MILESTONES ─────
    // Capture the wordcount we observed when prewarm-ready fired, so a
    // subsequent switch waits for the count to actually CHANGE.
    var docPollInterval = null;
    var prewarmWordCountAtReady = '';
    function startDocPoll() {
        if (docPollInterval) clearInterval(docPollInterval);
        var seenCanvas = false, seenStatus = false, seenContent = false;
        var startTextWordCount = (document.querySelector('#StateWordCount')||{}).textContent || '';
        var startTextDocPos = (document.querySelector('#StatusDocPos')||{}).textContent || '';
        // Iter 202: derive expected doctype from the iframe's URL so
        // docPoll only fires "ready" on a STATUS MATCH for that doctype.
        // Previously it accepted any doctype, which caused false positives
        // after a snapshot warm-restore: the snapshot's writer status
        // was still in #StateWordCount when a calc URL loaded, so
        // writerLoaded=true → prewarm:ready → WasmPrewarmReady → the
        // viewer's cross-type watchdog cleared even though the actual
        // calc canvas never painted.
        // V2 (encrypted) opens have an opaque fileId in WOPISrc — fall
        // back to the displayName URL param the viewer passes for that
        // exact reason.
        var expectedDocType = '';
        try {
            var pollParams = new URLSearchParams(window.location.search);
            var pollName = pollParams.get('WOPISrc') || pollParams.get('displayName') || '';
            // If WOPISrc looks like a hex blob (no dot), try displayName.
            if (!pollName.includes('.')) pollName = pollParams.get('displayName') || pollName;
            var ext = pollName.split('.').pop().toLowerCase().split('?')[0];
            if (['xlsx','xls','ods','csv','tsv'].indexOf(ext) >= 0) expectedDocType = 'calc';
            else if (['pptx','ppt','odp','ppsx','pps'].indexOf(ext) >= 0) expectedDocType = 'impress';
            else if (['docx','doc','odt','rtf','txt'].indexOf(ext) >= 0) expectedDocType = 'writer';
            mark('docpoll:expectedDocType', expectedDocType + ' (from ' + pollName + ')');
        } catch(e) {}
        docPollInterval = setInterval(function() {
            var canvases = document.querySelectorAll('canvas').length;
            if (!seenCanvas && canvases > 0) {
                seenCanvas = true; mark('dom:first_canvas', 'count=' + canvases);
            }
            var wc = document.querySelector('#StateWordCount');
            var dp = document.querySelector('#StatusDocPos');
            var nav = document.querySelector('nav.main-nav');
            if (!seenStatus && ((wc && wc.textContent) || (dp && dp.textContent))) {
                seenStatus = true;
                mark('dom:status_appeared', wc ? 'wc=[' + wc.textContent.trim() + ']' : 'dp=[' + dp.textContent.trim() + ']');
            }
            var writerLoaded = wc && /\d/.test(wc.textContent || '') &&
                               (wc.textContent.includes('word') || wc.textContent.includes('character'));
            var calcLoaded = dp && /\d/.test(dp.textContent || '') && dp.textContent.includes('Sheet');
            var slideStatus = document.querySelector('#SlideStatus');
            // COOL UI slide-indicator: legacy `#SlideStatus` was renamed/merged
            // into the generic StatusBar items at some point. Sweep any
            // element containing "Slide N of M" as a fallback.
            var impressSlideMatch = false;
            if (!impressSlideMatch) {
                var statusEls = document.querySelectorAll('[id*="lide"],[id*="age"],[id*="tatusbarItem"],[id*="tatus"],[class*="tatusbar"]');
                for (var i = 0; i < statusEls.length; i++) {
                    if (/Slide\s+\d+\s+of\s+\d+/i.test(statusEls[i].textContent || '')) {
                        impressSlideMatch = true;
                        break;
                    }
                }
            }
            var impressLoaded = (nav && nav.textContent && nav.textContent.includes('Slide Show')) ||
                                (slideStatus && /Slide \d/i.test(slideStatus.textContent || '')) ||
                                impressSlideMatch;
            // Iter 202: only accept the EXPECTED doctype's status as
            // "loaded". Without this, warm-restore's leftover writer
            // status from the snapshot satisfies writerLoaded=true on a
            // calc/impress URL and we falsely fire prewarm:ready before
            // the actual doc paints.
            var loaded;
            if (expectedDocType === 'calc') loaded = calcLoaded;
            else if (expectedDocType === 'impress') loaded = impressLoaded;
            else if (expectedDocType === 'writer') loaded = writerLoaded;
            else loaded = writerLoaded || calcLoaded || impressLoaded;
            // For switches, require the displayed text to have CHANGED from
            // when we re-armed (otherwise the old blank-doc count satisfies
            // the loaded check immediately).
            var textChanged = !startTextWordCount || (wc && wc.textContent !== startTextWordCount) ||
                              (dp && dp.textContent !== startTextDocPos);
            // Two similar docs of the same type can produce IDENTICAL status
            // text (e.g. two 1-sheet xlsx files both showing "Sheet 1 of 1"
            // or two 1-slide pptx files both showing "Slide 1 of 1"). In
            // that case textChanged stays false forever even though the
            // switch succeeded. Once trySendSwitch has dispatched the
            // switchdocument command and a few hundred ms have passed, we
            // trust that the switch did happen and accept the current
            // status as "new doc ready" regardless of whether the text
            // literally differs.
            var switchDispatchedAgo = window.__switchSendT
                ? (performance.now() - window.__switchSendT)
                : -1;
            var postSwitchAccept = switchDispatchedAgo > 500 && switchDispatchedAgo < 60000;
            var changed = textChanged || postSwitchAccept;
            if (loaded && changed && !seenContent) {
                seenContent = true;
                mark('doc:loaded', wc ? wc.textContent.trim() : (dp ? dp.textContent.trim() : ''));
                // Clear warm-restore watchdog — doc loaded successfully.
                if (window.__wasmWarmWatchdogTimer) {
                    clearTimeout(window.__wasmWarmWatchdogTimer);
                    window.__wasmWarmWatchdogTimer = null;
                }
            }
            var runtimeReady = (typeof Module !== 'undefined') &&
                               (window.__wasmExports || (Module && Module.calledRun));

            if (runtimeReady && canvases > 0 && loaded && changed && !window.__wasmPrewarmReady) {
                window.__wasmPrewarmReady = true;
                // Authoritative "LO is painting this doc" flag for the
                // initial-load path (cold-reload iframe opens with the
                // target's WOPISrc and no switchdoc). Tests should read
                // window.__wasmLoadedDocName to know which doc is
                // actually rendered (vs prewarm). Phase 4 cleanup moved
                // __wasmInitialDocLoaded fan-out to __onDocReadyFrame —
                // the kit's LOK_CALLBACK_DOCUMENT_READY emit fires it
                // ~1.8s before this canvas-paint poll would.
                try {
                    var initParams = new URLSearchParams(window.location.search);
                    var initWopi = initParams.get('WOPISrc') || '';
                    if (initWopi) window.__wasmLoadedDocName = initWopi;
                } catch(e) {}
                // Safety net (Phase 4): if the kit event somehow
                // hasn't fired by the time the canvas-paint poll
                // satisfies, fire fallback fan-out. fireDocReady is
                // idempotent on filename so this is a no-op when kit
                // arrived first (the common case per telemetry).
                var coldFallback = window.__wasmLoadedDocName || 'cold';
                if (window.__docReadyFiredFor !== String(coldFallback)) {
                    var fired = fireDocReady({
                        source: 'poll-cold-fallback',
                        filename: window.__wasmLoadedDocName,
                    });
                    if (fired) {
                        recordReadyArrival('poll');
                        mark('bridge:doc_ready_fallback_cold');
                    }
                }
                prewarmWordCountAtReady = wc ? wc.textContent : '';
                mark('prewarm:ready');
                logTiming('Document ready');
                clearInterval(docPollInterval);
                docPollInterval = null;
                updateProgress('Ready', 100);
                setTimeout(hideOverlay, 150);

                // Iter 41: postMessage SW to background-precache the heavy
                // assets. After prewarm:ready they're already loaded into
                // memory, but if the SW lazy-cache was bypassed (e.g. user
                // had a stale cool.html with old hashed URLs), this nudges
                // the SW to populate Cache Storage with the CURRENT URLs
                // so the next visit hits cache. No-op if already cached.
                //
                // Iter 192: on the very FIRST visit `navigator.serviceWorker.
                // controller` is null until the new SW finishes installing
                // and clients.claim() runs. Skipping silently here meant
                // session 1 of test-regression-wasm-cache-pressure left
                // Cache Storage empty, so session 2 fell through to a 47 MB
                // network re-download. Try the immediate post when a
                // controller already exists; otherwise wait for one via
                // controllerchange so the precache still fires on cold
                // first visits.
                try {
                    if ('serviceWorker' in navigator) {
                        var assetMap = window.__assetMap || {};
                        var heavyUrls = ['online.wasm', 'soffice.data',
                                         'soffice.data.js.metadata', 'bundle.js',
                                         'online.js', 'global.js']
                            .map(function(name) {
                                return new URL((assetMap[name] || name),
                                    document.baseURI).href;
                            });
                        var sentPrecache = false;
                        function sendPrecache(reason) {
                            if (sentPrecache) return;
                            var ctrl = navigator.serviceWorker.controller;
                            if (!ctrl) return;
                            ctrl.postMessage({ type: 'precache', urls: heavyUrls });
                            mark('sw:precache_msg', heavyUrls.length + ' urls (' + reason + ')');
                            sentPrecache = true;
                        }
                        sendPrecache('immediate');
                        if (!sentPrecache) {
                            navigator.serviceWorker.addEventListener('controllerchange',
                                function() { sendPrecache('controllerchange'); });
                            navigator.serviceWorker.ready.then(function() {
                                sendPrecache('ready');
                            }).catch(function() {});
                        }
                    }
                } catch (e) { /* SW unavailable / messaging failed */ }

                // Read C++ timing log from WASM VFS
                try {
                    if (typeof Module !== 'undefined' && Module.FS) {
                        var timingData = Module.FS.readFile('/timing.log', { encoding: 'utf8' });
                        if (timingData) {
                            console.log('[C++ TIMING]\n' + timingData);
                            mark('cpp_timing', timingData.replace(/\n/g, ' | '));
                        }
                    }
                } catch(e) { /* timing.log not created */ }

                // Note: WASM memory snapshot/restore was investigated but is
                // not feasible with the current Emscripten build. The WASM
                // module instantiation overwrites memory, and Emscripten's
                // _start/main runs automatically. Skipping init requires
                // changes to the C++ startup code. The V8 code cache fix
                // already reduced compile time from 21s to ~1.7s. The
                // remaining 22s is LibreOffice C++ initialization which
                // can only be improved by modifying the LO source.
                // Diagnostic counter for the init block (see proposal
                // ai/proposals/proposed/wasm-init-block-fires-twice-per-iframe).
                // Within a single iframe lifetime this block re-fires
                // during snapshot-restore (and possibly during other
                // late-init paths). Logging the entry count gives the
                // next investigator ground truth: if `__wasmInitBlockCount`
                // reaches 2 with `__wasmPrewarmReadySent === true` at the
                // second entry, the idempotency guard works correctly
                // (the duplicate App_LoadingStatus is the only residual);
                // if `__wasmPrewarmReadySent === undefined` at the second
                // entry, something IS clearing the JS window between
                // calls and the guard needs a different storage backend.
                window.__wasmInitBlockCount = (window.__wasmInitBlockCount || 0) + 1;
                console.log('[wasm-loader] init block entry #' +
                    window.__wasmInitBlockCount +
                    ' prewarmReadySent=' + !!window.__wasmPrewarmReadySent);
                try {
                    parent.postMessage(JSON.stringify({
                        MessageId: 'App_LoadingStatus',
                        Values: { Status: 'Initialized' }
                    }), '*');
                } catch(e) {}
                // Dedicated "iframe is now ready to receive switchdocument"
                // signal. Map.js fires App_LoadingStatus=Initialized when the
                // COOL framework boots — far earlier than __wasmInitialDocLoaded.
                // The viewer used to key prewarmReady on that early message and
                // would dispatch a hot-switch before trySendSwitch could deliver
                // it, so the user saw a 30 s wait while the polled retry waited
                // for the prewarm doc to actually paint.
                //
                // Idempotency guard: the surrounding init block fires twice on
                // cold-then-snapshot-restore (see project_warm_pthread_flake
                // memory — stale coolwsd_server_socket_fd causes an is_preinit_done
                // re-fire). The viewer keys hot-switch routing on the FIRST
                // WasmPrewarmReady; a duplicate fires after the viewer has
                // already moved on, which the regression test catches but
                // production silently tolerates. Gate on a one-shot global so
                // we emit exactly once per page lifetime.
                if (!window.__wasmPrewarmReadySent) {
                    window.__wasmPrewarmReadySent = true;
                    try {
                        var pwWopi = new URLSearchParams(window.location.search).get('WOPISrc') || '';
                        parent.postMessage(JSON.stringify({
                            MessageId: 'WasmPrewarmReady',
                            Values: { filename: pwWopi }
                        }), '*');
                    } catch(e) {}
                }
                // ── COPY override ─────────────────────────────────────
                // Write the selection to the SYSTEM clipboard so external
                // apps can receive it.  Also save a plain-text fingerprint
                // so the paste handler knows whether the clipboard still
                // holds "our" content or something the user copied elsewhere.
                try {
                    if (window.app && window.app.map && window.app.map._clip) {
                        var clip = window.app.map._clip;
                        document.oncopy = function(ev) {
                            ev.preventDefault();
                            // Map.Keyboard already sends uno:Copy on Ctrl+C
                            // keydown (line 860 of Map.Keyboard.js, mobile path).
                            // We do NOT send it again — just populate the system
                            // clipboard below.
                            // Ask Kit for the selection HTML
                            if (globalThis.postMobileMessage) {
                                globalThis.postMobileMessage('gettextselection mimetype=text/html');
                            }
                            setTimeout(function() {
                                var html = clip._selectionContent || '';
                                var plain = clip._selectionPlainTextContent || '';
                                if (!plain && html) {
                                    var d = document.createElement('div');
                                    d.innerHTML = html;
                                    var kill = d.querySelectorAll('style, head, script, meta, link, title');
                                    for (var ki = 0; ki < kill.length; ki++) kill[ki].remove();
                                    plain = (d.textContent || '').trim();
                                }
                                // Save fingerprint BEFORE writing to clipboard
                                globalThis._lastCopiedPlain = plain || null;
                                if (navigator.clipboard && navigator.clipboard.write && html) {
                                    navigator.clipboard.write([new ClipboardItem({
                                        'text/html': new Blob([html], {type: 'text/html'}),
                                        'text/plain': new Blob([plain], {type: 'text/plain'}),
                                    })]).then(function() {
                                        console.log('[wasm-loader] Copied to system clipboard (' + plain.length + ' chars)');
                                    }).catch(function(e) {
                                        console.error('[wasm-loader] Clipboard write failed:', e);
                                        globalThis._lastCopiedPlain = null;
                                    });
                                } else if (plain) {
                                    navigator.clipboard.writeText(plain).catch(function(){});
                                }
                            }, 200);
                            return false;
                        };
                        document.oncut = function(ev) {
                            ev.preventDefault();
                            // Cut = copy to system clipboard + delete from doc
                            if (globalThis.TheFakeWebSocket) {
                                globalThis.TheFakeWebSocket.send('uno .uno:Cut');
                            }
                            // Also write to system clipboard (same as copy)
                            if (globalThis.postMobileMessage) {
                                globalThis.postMobileMessage('gettextselection mimetype=text/html');
                            }
                            setTimeout(function() {
                                var html = clip._selectionContent || '';
                                var plain = clip._selectionPlainTextContent || '';
                                if (!plain && html) {
                                    var d = document.createElement('div');
                                    d.innerHTML = html;
                                    var kill = d.querySelectorAll('style, head, script, meta, link, title');
                                    for (var ki = 0; ki < kill.length; ki++) kill[ki].remove();
                                    plain = (d.textContent || '').trim();
                                }
                                globalThis._lastCopiedPlain = plain || null;
                                if (navigator.clipboard && navigator.clipboard.write && html) {
                                    navigator.clipboard.write([new ClipboardItem({
                                        'text/html': new Blob([html], {type: 'text/html'}),
                                        'text/plain': new Blob([plain], {type: 'text/plain'}),
                                    })]).catch(function() {});
                                }
                            }, 200);
                            return false;
                        };

                        // Paste handler is registered at the top of this
                        // file (capture phase, before COOL loads). No need
                        // to set it again here.
                        mark('clipboard:wasm_copy_override');
                    }
                } catch(e) {}
                // For COLD-reload doc opens (new iframe, initial doc) we
                // also post WasmDocReady so the viewer's shield drops.
                // For HOT-switches we do NOT — `trySendSwitch`'s
                // docReadyInterval is the authoritative source there
                // (it gates on actual canvas-pixel change, whereas this
                // docPoll's `postSwitchAccept` flag fires merely 500 ms
                // after switchSendT and can race in before the new
                // doc's canvas has painted).
                var midSwitch = window.__switchSendT &&
                                (performance.now() - window.__switchSendT) < 60000;
                if (!midSwitch) {
                    var qWopi = new URLSearchParams(window.location.search).get('WOPISrc') || '';
                    try {
                        parent.postMessage(JSON.stringify({
                            MessageId: 'WasmDocReady',
                            Values: { filename: qWopi, ms: 0, source: 'docPoll' }
                        }), '*');
                    } catch(e) {}
                }
            }
        }, 200);
    }
    startDocPoll();

    // Load online.js via document.write — only reliable path in cool.html.
    // If the build-time cache-bust ran, window.__assetMap maps "online.js"
    // to its content-hashed filename; use that so the fetch resolves
    // (the plain name no longer exists on disk after cache-bust-build.js
    // renames it to online.<hash>.js).
    var onlineJsName = (typeof window !== 'undefined' && window.__assetMap
        && window.__assetMap['online.js']) || 'online.js';
    document.write('<scr' + 'ipt type="text/javascript" src="' + onlineJsName + '"><\/scr' + 'ipt>');
    mark('loader:online.js_written', onlineJsName);
})();
