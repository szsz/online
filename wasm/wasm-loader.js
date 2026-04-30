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
    function mark(name, detail) {
        var dt = (performance.now() - t0).toFixed(1);
        var navMs = msSinceNav();
        window.__prewarmTimings.events.push({ t: +dt, tNav: navMs, name: name, detail: detail || '' });
        console.log('[profile +' + dt + 'ms] ' + name + (detail ? ' ' + detail : ''));
    }
    window.__prewarmMark = mark;

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
    if (displayName) {
        var applyName = function() {
            try {
                if (window.app && window.app.map && window.app.map['wopi']) {
                    window.app.map['wopi'].BaseFileName = displayName;
                    window.app.map['wopi'].BreadcrumbDocName = displayName;
                }
                var ni = document.querySelector('#document-name-input');
                if (ni && ni.value !== displayName) ni.value = displayName;
                try { document.title = displayName; } catch(e) {}
            } catch(e) {}
        };
        // Bug iter 17 #2: removed the 120 s applyName poll that previously
        // ran at 250 ms cadence. It raced the per-switchdoc title poll
        // (root cause of the A↔B flicker observed when toggling between
        // two same-type files). The MutationObserver below catches any
        // late COOL clobber via a single one-shot apply.
        applyName();
        // Watch for late DOM insertion of the input; once it appears,
        // attach a MutationObserver so we re-apply if COOL ever resets
        // it back to the fileId.
        var observerInstalled = false;
        var watchStart = Date.now();
        var watchInt = setInterval(function() {
            var ni = document.querySelector('#document-name-input');
            if (ni && !observerInstalled) {
                observerInstalled = true;
                try {
                    new MutationObserver(function() {
                        if (ni.value !== displayName) ni.value = displayName;
                    }).observe(ni, { attributes: true, attributeFilter: ['value'] });
                } catch(e) {}
            }
            if (Date.now() - watchStart > 120000) clearInterval(watchInt);
        }, 500);
    }

    // ───── SERVICE WORKER REGISTRATION ─────
    // Register sw.js to lock the heavy WASM assets into Cache Storage.
    // Why this is at the top of wasm-loader rather than inline in cool.html:
    // wasm-loader runs the moment cool.html starts, so the SW is installed
    // before any of online.wasm / soffice.data starts streaming. The first
    // visit still goes to network (SW only takes effect on the SECOND
    // navigation by default; we use clients.claim() in sw.js to take over
    // sooner where possible). Subsequent visits hit the SW cache regardless
    // of HTTP-cache pressure — see test-regression-wasm-cache-pressure.js.
    if ('serviceWorker' in navigator) {
        // Scope is /browser/ (the directory the SW lives in). That's
        // exactly where online.wasm + soffice.data live, so the scope
        // covers all heavy assets. Use a relative path so it works
        // regardless of which (sub-)origin we're served from.
        navigator.serviceWorker.register('sw.js').then(function(reg) {
            mark('sw:registered', 'scope=' + reg.scope);
            // If the page loaded before the SW could take control, ask
            // the new worker to claim immediately. This affects the very
            // first visit; subsequent visits are already controlled.
            if (!navigator.serviceWorker.controller && reg.active) {
                mark('sw:no_controller_first_visit');
            }
        }).catch(function(err) {
            // SW is a defense-in-depth optimisation; failing to register
            // is non-fatal (we still have HTTP cache headers as the
            // primary mechanism).
            mark('sw:register_failed', err.message);
        });
    } else {
        mark('sw:unavailable', 'navigator.serviceWorker missing');
    }

    // ───── EARLY SNAPSHOT CHECK ─────
    // Only check if a snapshot EXISTS (HEAD check, no body materialization).
    // The actual 73MB ArrayBuffer is loaded lazily in the deploy.sh injection
    // right before callMain — after the WASM module has fully instantiated.
    // Loading it eagerly caused memory pressure that broke __wasm_call_ctors.
    window.__wasmSnapshotData = undefined; // undefined = not yet checked
    window.__wasmSnapshotExists = false;
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
            // Also delete any stale Cache Storage entry so subsequent
            // visits don't even find the metadata.
            if ('caches' in self) {
                caches.open('wasm-snapshot').then(function(c) {
                    return Promise.all([c.delete('/snapshot/heap-v2'), c.delete('/snapshot/meta')]);
                }).catch(function() {});
            }
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
                    // Fingerprint matches — snapshot is valid. Eagerly read
                    // the heap blob so it's ready before Module.preRun fires.
                    // Reading 256MB from Cache API takes ~500ms-2s; smaller
                    // than the wasm-fetch + instantiate that runs in
                    // parallel, so this isn't on the cold-start critical
                    // path. (Was previously left as null/'deferred' but
                    // never actually loaded — making preRun a no-op.)
                    mark('snapshot:exists');
                    logTiming('Snapshot: found (warm start)');
                    window.__wasmSnapshotExists = true;
                    return heapResp.arrayBuffer().then(function(buf) {
                        window.__wasmSnapshotData = buf;
                        mark('snapshot:heap_loaded', (buf.byteLength/1048576).toFixed(0) + 'MB');
                        return buf;
                    }).catch(function(e) {
                        mark('snapshot:heap_load_failed', e.message);
                        window.__wasmSnapshotData = null;
                        return null;
                    });
                }).catch(function(e) {
                    return discardStale('meta-parse-error: ' + (e.message || ''));
                });
            }
            // Dev mode: BUILD_FINGERPRINT not injected. Accept whatever's there.
            mark('snapshot:exists');
            window.__wasmSnapshotExists = true;
            return heapResp.arrayBuffer().then(function(buf) {
                window.__wasmSnapshotData = buf;
                return buf;
            }).catch(function(e) {
                window.__wasmSnapshotData = null;
                return null;
            });
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
        // Forward to parent so the viewer's shield (which hides the iframe
        // during pre-warm) can show the same progress to the user.
        try {
            parent.postMessage(JSON.stringify({
                MessageId: 'WasmProgress',
                Values: { label: label, pct: pct, detail: detail }
            }), '*');
        } catch(e) {}
    }
    function ensureOverlay(label, pct, detail) {
        var o = document.getElementById('wasm-loading-overlay');
        if (!o) {
            // Recreate overlay (was removed after prewarm).
            o = document.createElement('div');
            o.id = 'wasm-loading-overlay';
            o.innerHTML =
                '<div id="wasm-spinner"></div>' +
                '<div id="wasm-progress-label"></div>' +
                '<div id="wasm-progress-bar"><div id="wasm-progress-bar-fill"></div></div>' +
                '<div id="wasm-progress-detail"></div>';
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
                    '#wasm-progress-detail{font-size:12px;color:#666;}';
                document.head.appendChild(st);
            }
            (document.body || document.documentElement).appendChild(o);
        }
        o.style.opacity = '1';
        o.style.transition = '';
        updateProgress(label, pct, detail);
    }
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
        var watchStart = performance.now();
        var visiblePollInterval = setInterval(function() {
            var sample = snapshotCanvas();
            if (sample && sample !== canvasBaseline) {
                var dt = (performance.now() - watchStart).toFixed(0);
                mark('bridge:canvas_visible', dt + 'ms');
                clearInterval(visiblePollInterval);
                try {
                    parent.postMessage(JSON.stringify({
                        MessageId: 'WasmSwitchVisible',
                        Values: { filename: filename, ms: +dt }
                    }), '*');
                } catch(e) {}
                if (typeof hideOverlay === 'function') hideOverlay();

                // Gate WasmDocReady on BOTH:
                //   (a) status bar has a real value ("N characters",
                //       "Sheet X of Y", "Slide X of Y") — means Kit
                //       finished layout
                //   (b) canvas has been stable for STABILITY_MS — tiles
                //       have stopped arriving
                //
                // A previous iteration also required "≥ 3 distinct
                // canvas samples" to guard against firing after a
                // single partial tile landed. But on the warm path
                // (snapshot restore), the canvas can stabilize
                // immediately after one paint, and the 3-sample guard
                // never unlocked → WasmDocReady never fired → shield
                // stayed up forever. Dropped it; (a)+(b) is enough
                // (the parent visiblePoll already confirms the canvas
                // differs from the pre-switch baseline, so we know
                // SOME paint happened before we entered this block).
                // 400 ms after Rec 6.5 (capture-point shift) made the
                // warm path reliable. Iter9–13 saw apparent regressions
                // at 400 ms but those were the lockstep capture race,
                // not STABILITY_MS related.
                // Iter7 (post-warm-restore-flag-clear): with the doc-
                // switch loop fixed, the canvas paints ONCE and stays.
                // Combined with statusReady (which only fires when LO
                // emitted a real word/cell/slide count, i.e. layout is
                // done), the stability buffer is just paranoia. 100 ms
                // is enough to ride out a single jittery frame.
                var STABILITY_MS = 100;
                var readyStart = performance.now();
                var lastSample = null;
                var lastChangeAt = performance.now();
                var docReadyInterval = setInterval(function() {
                    var wc = document.querySelector('#StateWordCount');
                    var dp = document.querySelector('#StatusDocPos');
                    var wcReady = wc && wc.textContent && /character|word|cell|slide/i.test(wc.textContent);
                    var dpReady = dp && dp.textContent && /Sheet|Slide/i.test(dp.textContent);
                    var statusReady = wcReady || dpReady;
                    var sample = snapshotCanvas();
                    if (sample !== lastSample) {
                        lastSample = sample;
                        lastChangeAt = performance.now();
                    }
                    var stableFor = performance.now() - lastChangeAt;
                    if (statusReady && stableFor >= STABILITY_MS) {
                        var rdt = (performance.now() - readyStart).toFixed(0);
                        mark('bridge:doc_ready', rdt + 'ms, stable ' + stableFor.toFixed(0) + 'ms');
                        clearInterval(docReadyInterval);
                        window.__wasmLoadedDocName = filename;
                        try {
                            parent.postMessage(JSON.stringify({
                                MessageId: 'WasmDocReady',
                                Values: { filename: filename, ms: +rdt + +dt }
                            }), '*');
                        } catch(e) {}
                    }
                    if (performance.now() - readyStart > 60000) {
                        clearInterval(docReadyInterval);
                        try {
                            parent.postMessage(JSON.stringify({
                                MessageId: 'WasmDocReady',
                                Values: { filename: filename, ms: -1, timeout: true }
                            }), '*');
                        } catch(e) {}
                    }
                }, 50);
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
    function fileProgress(name, loaded, total) {
        var key = Object.keys(PROGRESS_WEIGHTS).find(k => name === k);
        if (!key) return;
        progressState.fileBytes[key] = { loaded: loaded, total: total };
        progressState.fileDone[key] = total > 0 ? Math.min(1, loaded / total) : 0;
        var pct = aggregateProgress();
        var detail = Object.keys(progressState.fileBytes)
            .filter(k => progressState.fileBytes[k].total > 0)
            .map(k => k + ' ' + Math.round(progressState.fileDone[k]*100) + '%')
            .join('  ');
        updateProgress('Downloading editor assets…', pct, detail);
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
            if (name === 'online.wasm') {
                return origFetch.apply(this, arguments).then(function(r) {
                    progressState.fileDone[name] = 1;
                    var dur = performance.now() - tStart;
                    mark('net:fetch_end', name + ' ' + dur.toFixed(0) + 'ms (unwrapped for V8 code cache)');
                    logCacheState(key, name, dur);
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
        // The fingerprint can be null if the 200ms setTimeout hasn't
        // fired yet, so the marker check is the reliable fallback.
        var hasCoolMarker = html && (html.indexOf('data-coolorigin') >= 0 ||
                                     html.indexOf('meta-origin') >= 0);
        var isInternal = hasCoolMarker ||
                         (globalThis._lastCopiedPlain && plain === globalThis._lastCopiedPlain);

        if (isInternal) {
            // Clipboard holds content from our document → Kit internal
            // paste (preserves full formatting). We suppressed Map.Keyboard's
            // uno:Paste in the keydown handler, so we send it ourselves.
            console.log('[wasm-loader] Internal paste (' +
                (hasCoolMarker ? 'COOL marker' : 'fingerprint') +
                ', ' + plain.length + ' chars)');
            globalThis.TheFakeWebSocket.send('uno .uno:Paste');
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
                        window.__wasmWarmWatchdogTimer = setTimeout(function() {
                            try {
                                console.warn('[snapshot] Warm-restore watchdog: '
                                    + 'doc:loaded missing 6s after restore — '
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
                        }, 6000);   // Iter A10: tightened from 12 s.
                                    // Happy warms measured at 6–8 s after
                                    // restore for the doc:loaded mark to
                                    // fire — but the SAME-TYPE-then-cross-
                                    // type warm-restore failure is now
                                    // 100 % reproducible after iter 5,
                                    // so paying 12 s waiting for a verdict
                                    // we already know is pure overhead.
                                    // 6 s gives a 3-second margin over the
                                    // happy-path tail and clips failure
                                    // recovery by 6 s on every retry.
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
            var loaded = writerLoaded || calcLoaded || impressLoaded;
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
                window.__wasmInitialDocLoaded = true;  // sticky one-shot
                // Authoritative "LO is painting this doc" flag for the
                // initial-load path (cold-reload iframe opens with the
                // target's WOPISrc and no switchdoc). Tests should read
                // window.__wasmLoadedDocName to know which doc is
                // actually rendered (vs prewarm). The switchdoc path
                // updates this separately via the docReadyInterval
                // inside checkHashSwitch.
                try {
                    var initParams = new URLSearchParams(window.location.search);
                    var initWopi = initParams.get('WOPISrc') || '';
                    if (initWopi) window.__wasmLoadedDocName = initWopi;
                } catch(e) {}
                prewarmWordCountAtReady = wc ? wc.textContent : '';
                mark('prewarm:ready');
                logTiming('Document ready');
                clearInterval(docPollInterval);
                docPollInterval = null;
                updateProgress('Ready', 100);
                setTimeout(hideOverlay, 150);

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
                try {
                    var pwWopi = new URLSearchParams(window.location.search).get('WOPISrc') || '';
                    parent.postMessage(JSON.stringify({
                        MessageId: 'WasmPrewarmReady',
                        Values: { filename: pwWopi }
                    }), '*');
                } catch(e) {}
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
