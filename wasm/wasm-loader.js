// wasm-loader.js — hash-switch bridge + deep profiling instrumentation.
// Every phase is marked on window.__prewarmTimings for test inspection.
(function() {
    'use strict';
    var params = new URLSearchParams(window.location.search);
    var wopiSrc = params.get('WOPISrc') || '';
    var ext = wopiSrc.split('.').pop().toLowerCase().split('?')[0];
    var docType = 'writer';
    if (['xlsx','xls','ods','csv','tsv'].indexOf(ext) >= 0) docType = 'calc';
    else if (['pptx','ppt','odp','ppsx','pps'].indexOf(ext) >= 0) docType = 'impress';
    window.__wasmDocType = docType;

    // ───── PROFILING ─────
    var t0 = performance.now();
    window.__prewarmTimings = { t0Wall: Date.now(), events: [] };
    function mark(name, detail) {
        var dt = (performance.now() - t0).toFixed(1);
        window.__prewarmTimings.events.push({ t: +dt, name: name, detail: detail || '' });
        console.log('[profile +' + dt + 'ms] ' + name + (detail ? ' ' + detail : ''));
    }
    window.__prewarmMark = mark;  // external code can mark events too

    mark('loader:start', 'doc=' + docType + ' ext=' + ext);

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
                        var txt = (typeof ev.data === 'string' ? ev.data : '').substring(0, 120);
                        var sw = window.__switchSendT;
                        if (sw && (txt.indexOf('status:') === 0 || txt.indexOf('loaded:') === 0 ||
                                   txt.indexOf('invalidatetiles') === 0 || txt.indexOf('tile ') === 0 ||
                                   txt.indexOf('editor:') === 0 || txt.indexOf('statusindicator') === 0)) {
                            var dt = (performance.now() - sw).toFixed(0);
                            mark('msg:' + txt.split(' ')[0].replace(':',''), dt + 'ms  ' + txt.substring(0, 80));
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
            try {
                if (window.app && window.app.map && window.app.map['wopi']) {
                    window.app.map['wopi'].BaseFileName = filename;
                    window.app.map['wopi'].BreadcrumbDocName = filename;
                }
                var nameInput = document.querySelector('#document-name-input');
                if (nameInput) nameInput.value = filename;
                document.title = filename;
            } catch(e) {}
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

                // After canvas change, wait for status bar to populate.
                var readyStart = performance.now();
                var docReadyInterval = setInterval(function() {
                    var wc = document.querySelector('#StateWordCount');
                    var dp = document.querySelector('#StatusDocPos');
                    var wcReady = wc && wc.textContent && /character|word|cell|slide/i.test(wc.textContent);
                    var dpReady = dp && dp.textContent && /Sheet|Slide/i.test(dp.textContent);
                    if (wcReady || dpReady) {
                        var rdt = (performance.now() - readyStart).toFixed(0);
                        mark('bridge:doc_ready', rdt + 'ms');
                        clearInterval(docReadyInterval);
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
                }, 100);
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
        var filename = decodeURIComponent(m[1]);
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
        // ── Clipboard POST interceptor ────────────────────────────
        // COOL's Clipboard.js in WASM mode POSTs clipboard HTML to
        // /collabora-online-mobile/cool/clipboard then calls .uno:Paste.
        // But the WASM Kit can't read from the HTTP clipboard endpoint
        // so .uno:Paste finds an empty clipboard. Intercept the POST:
        // extract text from the uploaded HTML, inject as textinput via
        // TheFakeWebSocket.send (our relay-adapter intercepts Blob
        // messages and routes through the relay). Then return 200 to
        // COOL so it doesn't error out. When COOL subsequently sends
        // .uno:Paste, Kit's clipboard is empty → no-op (the text was
        // already inserted via textinput).
        if (typeof key === 'string' && key.includes('/cool/clipboard') && opts && opts.method === 'POST') {
            mark('clipboard:post_intercepted');
            // Read the body (FormData or Blob or string)
            var clipBody = opts.body;
            if (clipBody) {
                (async function() {
                    try {
                        var htmlText = '';
                        if (clipBody instanceof FormData) {
                            var file = clipBody.get('file');
                            if (file && file instanceof Blob) {
                                htmlText = await file.text();
                            }
                        } else if (clipBody instanceof Blob) {
                            htmlText = await clipBody.text();
                        } else if (typeof clipBody === 'string') {
                            htmlText = clipBody;
                        }
                        if (htmlText && htmlText.trim()) {
                            console.log('[wasm-loader] Clipboard POST intercepted: ' + htmlText.length + ' chars HTML');
                            // Send as paste blob with the FULL HTML so Kit
                            // preserves formatting (bold, italic, underline).
                            var blob = new Blob(['paste mimetype=text/html\n', htmlText]);
                            if (globalThis.TheFakeWebSocket) {
                                globalThis.TheFakeWebSocket.send(blob);
                            }
                            // COOL will follow up with _doInternalPaste →
                            // `uno .uno:Paste`. We already pasted via the
                            // blob above, so suppress the duplicate. Set a
                            // flag that interceptedSend checks.
                            globalThis._suppressNextPaste = true;
                            setTimeout(function() { globalThis._suppressNextPaste = false; }, 5000);
                        }
                    } catch(e) {
                        console.error('[wasm-loader] Clipboard POST intercept error:', e);
                    }
                })();
            }
            // Return fake 200 so COOL doesn't show an error
            return Promise.resolve(new Response('{"ok":true}', {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }));
        }

        return origFetch.apply(this, arguments);
    };

    // ── XHR clipboard POST interceptor ────────────────────────────
    // COOL's _doAsyncDownload uses XMLHttpRequest (NOT fetch), so our
    // fetch wrapper above never sees the clipboard POST. Wrap XHR.open
    // to intercept POSTs to /cool/clipboard.
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
            mark('clipboard:xhr_post_intercepted');
            // Read the FormData body. The clipboard HTML is in a field
            // named 'file'. Extract it and send as a paste blob.
            var xhr = this;
            (async function() {
                try {
                    var htmlText = '';
                    if (body instanceof FormData) {
                        var file = body.get('file');
                        if (file instanceof Blob) htmlText = await file.text();
                    } else if (body instanceof Blob) {
                        htmlText = await body.text();
                    } else if (typeof body === 'string') {
                        htmlText = body;
                    }
                    if (htmlText && htmlText.trim()) {
                        // The blob from _readContentSyncToBlob is multi-section:
                        //   text/html\n<hex-size>\n<html>\ntext/plain\n<hex-size>\n<plain>\n
                        // Parse and extract the best section (prefer text/html).
                        var bestMime = null, bestContent = null;
                        var sections = htmlText.split(/(?=text\/html\n|text\/plain\n)/);
                        for (var si = 0; si < sections.length; si++) {
                            var sec = sections[si];
                            var nlPos = sec.indexOf('\n');
                            if (nlPos < 0) continue;
                            var secMime = sec.substring(0, nlPos).trim();
                            if (secMime !== 'text/html' && secMime !== 'text/plain') continue;
                            var rest = sec.substring(nlPos + 1);
                            // Skip the hex-size line
                            var nl2 = rest.indexOf('\n');
                            var secContent = nl2 >= 0 ? rest.substring(nl2 + 1).replace(/\n$/, '') : rest;
                            if (secMime === 'text/html' && secContent) {
                                bestMime = 'text/html'; bestContent = secContent;
                            } else if (secMime === 'text/plain' && !bestContent) {
                                bestMime = 'text/plain'; bestContent = secContent;
                            }
                        }
                        if (!bestContent) { bestMime = 'text/html'; bestContent = htmlText; }
                        console.log('[wasm-loader] XHR clipboard POST intercepted: ' +
                            bestContent.length + ' chars (' + bestMime + ')');
                        var blob = new Blob(['paste mimetype=' + bestMime + '\n', bestContent]);
                        if (globalThis.TheFakeWebSocket) {
                            globalThis.TheFakeWebSocket.send(blob);
                        }
                        globalThis._suppressNextPaste = true;
                        setTimeout(function() { globalThis._suppressNextPaste = false; }, 5000);
                    }
                } catch(e) {
                    console.error('[wasm-loader] XHR clipboard intercept error:', e);
                }
            })();
            // Fake a successful response so COOL doesn't error out
            Object.defineProperty(xhr, 'status', { get: function() { return 200; } });
            Object.defineProperty(xhr, 'readyState', { get: function() { return 4; } });
            Object.defineProperty(xhr, 'response', {
                get: function() { return new Blob(['OK']); }
            });
            setTimeout(function() {
                if (xhr.onreadystatechange) xhr.onreadystatechange();
                if (xhr.onload) xhr.onload();
            }, 50);
            return; // Don't actually send the XHR
        }
        return _origXHRSend.apply(this, arguments);
    };

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
            var impressLoaded = nav && nav.textContent && nav.textContent.includes('Slide Show');
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
            }
            var runtimeReady = (typeof Module !== 'undefined') &&
                               (window.__wasmExports || (Module && Module.calledRun));

            if (runtimeReady && canvases > 0 && loaded && changed && !window.__wasmPrewarmReady) {
                window.__wasmPrewarmReady = true;
                window.__wasmInitialDocLoaded = true;  // sticky one-shot
                prewarmWordCountAtReady = wc ? wc.textContent : '';
                mark('prewarm:ready');
                clearInterval(docPollInterval);
                docPollInterval = null;
                updateProgress('Ready', 100);
                setTimeout(hideOverlay, 150);
                try {
                    parent.postMessage(JSON.stringify({
                        MessageId: 'App_LoadingStatus',
                        Values: { Status: 'Initialized' }
                    }), '*');
                } catch(e) {}
                // Fix Ctrl+C for WASM mode. COOL's mobile path just sends
                // postMobileMessage('COPY') which copies to Kit's internal
                // clipboard but never writes to the SYSTEM clipboard.
                // Override: after Kit processes .uno:Copy, request the
                // selection content, then write it to the system clipboard
                // via the Clipboard API.
                try {
                    if (window.app && window.app.map && window.app.map._clip) {
                        var clip = window.app.map._clip;
                        document.oncopy = function(ev) {
                            ev.preventDefault();
                            // Request selection from Kit (populates _selectionContent)
                            if (globalThis.postMobileMessage) {
                                globalThis.postMobileMessage('gettextselection mimetype=text/html');
                            }
                            // Give Kit a moment to respond, then write to clipboard
                            setTimeout(function() {
                                var html = clip._selectionContent || '';
                                var plain = clip._selectionPlainTextContent || '';
                                if (!plain && html) {
                                    // Strip <style>, <head>, <script> and
                                    // meta tags before extracting text —
                                    // div.textContent includes CSS rules
                                    // from <style> as visible text.
                                    var d = document.createElement('div');
                                    d.innerHTML = html;
                                    var kill = d.querySelectorAll('style, head, script, meta, link, title');
                                    for (var ki = 0; ki < kill.length; ki++) kill[ki].remove();
                                    plain = (d.textContent || '').trim();
                                }
                                if (navigator.clipboard && navigator.clipboard.write && html) {
                                    navigator.clipboard.write([new ClipboardItem({
                                        'text/html': new Blob([html], {type: 'text/html'}),
                                        'text/plain': new Blob([plain], {type: 'text/plain'}),
                                    })]).then(function() {
                                        console.log('[wasm-loader] Copied to system clipboard (' + plain.length + ' chars)');
                                    }).catch(function(e) {
                                        console.error('[wasm-loader] Clipboard write failed:', e);
                                    });
                                } else if (plain) {
                                    // Fallback: write plain text
                                    navigator.clipboard.writeText(plain).catch(function(){});
                                }
                            }, 200);
                            return false;
                        };
                        document.oncut = function(ev) {
                            document.oncopy(ev);
                            // Also send the cut command to Kit
                            if (globalThis.TheFakeWebSocket)
                                globalThis.TheFakeWebSocket.send('uno .uno:Cut');
                            return false;
                        };
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

    // Load online.js via document.write — only reliable path in cool.html
    document.write('<scr' + 'ipt type="text/javascript" src="online.js"><\/scr' + 'ipt>');
    mark('loader:online.js_written');
})();
