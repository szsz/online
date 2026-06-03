// Regression: Print button produces a printable PDF via the in-memory FS.
//
// Before the fix, clicking Print → kit saveAs("print.pdf","pdf",...) wrote the
// PDF into Emscripten's virtual FS, the kit sent `downloadas: downloadid=...
// id=print ...` over WS, and _onDownloadAsMsg constructed a URL pointing at
// the C++ coolwsd HTTP server's /<urlPrefix>/<doc>/download/<id> route — a
// route that does not exist in WASM (coolwsd runs in-process inside the
// browser worker, no listening HTTP). The XHR 404'd silently; the user saw
// the "Downloading..." toast disappear and nothing else happen.
//
// The fix (browser/src/layer/tile/CanvasTileLayer.js:_onDownloadAsMsg)
// short-circuits in WASM mode (window.ThisIsTheEmscriptenApp && window.__wasmFS):
// reads /tmp/user/docs/<downloadid>/<filename> directly via Module.FS, builds
// a Blob URL, and fires filedownloadready — which Map.Print._onFileReady then
// XHRs (works on blob:), drops into a hidden iframe, and calls
// iframe.contentWindow.print() to open the OS print dialog.
//
// Iters 11+12 diag revealed a second kit-side bug uncovered by the
// blob-URL fix: ChildSession::downloadAs called
// FileUtil::createRandomDir(jailDoc), which used non-recursive
// std::filesystem::create_directory. When jailDoc (/tmp/user/docs)
// didn't exist in the Emscripten FS at downloadas-time (race with
// snapshot-inject's lazy mkdir on warm restore), the kit threw
// `filesystem error: in create_directory: No such file or directory`
// and silently never replied to the browser. Fixed by switching to
// create_directories (recursive) in common/FileUtil.cpp.
//
// What this test asserts:
//   1. After the doc is loaded, dispatching .uno:Print triggers the kit's
//      downloadas flow.
//   2. The map fires `filedownloadready` with a blob: URL (NOT an
//      editor-origin /download/ URL). This is the canonical signal the
//      fix produces; the downstream iframe.print() chain is gravy.
//   3. The PDF body starts with "%PDF-" (real saveAs output, not an empty
//      stub).
//   4. No "404" console error from the editor-origin /download/ route appears.
//
// Note on assertion choice — earlier iterations of this test stubbed
// HTMLIFrameElement.contentWindow.print() globally and polled the top
// page's window for an `__printDialogOpened` flag. That approach was
// frame-scoped wrong (the proxy's `window` closure captured the
// editor iframe's window, but the test polled the top page) AND
// fragile against headless Chrome's blob-PDF iframe.onload behavior.
// Hooking `app.map.fire` for `filedownloadready` inside the editor
// frame is the right surface: it's exactly the kit→viewer boundary
// where the WASM short-circuit produces its observable effect.

const { launch, sleep } = require('./lib/browser');
const { openViaViewer } = require('./lib/open-via-viewer');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');

const VIEWER = env.FILE_STORAGE_URL;
const TIMEOUT = env.scaleTimeout(120000);

(async () => {
    console.log('=== Regression: Print button → blob URL ===');
    const { browser, cleanup } = await launch();
    let allPassed = true;

    function check(label, cond, ev) {
        if (cond) console.log('  ✓ ' + label);
        else {
            console.log('  ✗ FAIL: ' + label + (ev ? ' [' + ev + ']' : ''));
            allPassed = false;
        }
    }

    try {
        const docBytes = fs.readFileSync(
            path.join(__dirname, '..', 'test', 'data', 'new.docx'));
        const docName = 'print-' + Date.now() + '.docx';

        // Stub iframe.contentWindow.print so the OS print dialog never opens
        // if Map.Print._onIframeLoaded does fire. Best-effort: the real
        // assertion is on `filedownloadready` below; this stub just keeps
        // headless Chrome from doing anything visible if the iframe onload
        // path runs.
        const installStub = (page) => {
            return page.evaluateOnNewDocument(() => {
                try {
                    const orig = Object.getOwnPropertyDescriptor(
                        HTMLIFrameElement.prototype, 'contentWindow');
                    if (!orig || !orig.get) return;
                    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
                        configurable: true,
                        get() {
                            const real = orig.get.call(this);
                            if (!real) return real;
                            return new Proxy(real, {
                                get(t, prop) {
                                    if (prop === 'print') return function() { /* noop */ };
                                    const v = Reflect.get(t, prop);
                                    return typeof v === 'function' ? v.bind(t) : v;
                                },
                                set(t, prop, value) { t[prop] = value; return true; }
                            });
                        }
                    });
                } catch (_) { /* some envs lock the prototype — fine */ }
            });
        };

        // Capture browser console lines that mention the print/downloadas
        // pipeline. In WASM mode the kit's `LOG_DBG`/`LOG_ERR` from
        // ChildSession::downloadAs route through Emscripten to console.log
        // — surfacing them tells us whether saveAs() actually ran and what
        // jail path it used. Capped to avoid blowing up the report.
        const kitLines = [];
        const onConsole = (msg) => {
            try {
                const t = msg.text();
                if (/downloadas|saveAs|SaveAs|registerdownload|filterDownloadAs|cmd=downloadas/i.test(t)) {
                    if (kitLines.length < 50) kitLines.push(t.substring(0, 300));
                }
            } catch (_) { /* */ }
        };

        const up = await openViaViewer(browser, VIEWER, docName, docBytes,
            { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
              isolatedContext: true,
              onPage: (page) => {
                  page.on('console', onConsole);
                  return installStub(page);
              } });

        // Wait for the doc to be loaded enough that .uno:Print would succeed.
        await up.editorFrame.waitForFunction(() => {
            const wc = document.querySelector('#StateWordCount');
            return !!(wc && wc.textContent && wc.textContent.includes('characters'));
        }, { timeout: TIMEOUT });
        console.log('  Editor ready, hooking filedownloadready');

        // Diagnostics + capture: log every meaningful link in the chain so a
        // failure points to the exact broken step instead of a generic
        // "filedownloadready never fired."
        const diag = await up.editorFrame.evaluate(() => {
            window.__capturedPrintEvent = null;
            window.__capturedDownloadAsPM = null;
            window.__diag = {
                hasDispatcher: !!(typeof app !== 'undefined' && app.dispatcher
                    && typeof app.dispatcher.dispatch === 'function'),
                hasMapPrint: !!(typeof app !== 'undefined' && app.map
                    && typeof app.map.print === 'function'),
                wopiDisablePrint: (typeof app !== 'undefined' && app.map && app.map['wopi'])
                    ? !!app.map['wopi'].DisablePrint : 'no-wopi-handler',
                wopiHidePrint: (typeof app !== 'undefined' && app.map && app.map['wopi'])
                    ? !!app.map['wopi'].HidePrintOption : 'no-wopi-handler',
                wopiDownloadAsPM: (typeof app !== 'undefined' && app.map && app.map['wopi'])
                    ? !!app.map['wopi'].DownloadAsPostMessage : 'no-wopi-handler',
                hasWasmFS: !!window.__wasmFS,
                hasEmscriptenApp: !!window.ThisIsTheEmscriptenApp,
                sentMessages: [],
                gotDownloadasReply: null,
                firedEvents: [],
            };

            // Hook outbound: app.socket.sendMessage
            try {
                const origSend = app.socket.sendMessage;
                app.socket.sendMessage = function(msg) {
                    if (typeof msg === 'string' && (msg.startsWith('downloadas') || msg.indexOf('Print') >= 0)) {
                        window.__diag.sentMessages.push({ msg: msg.substring(0, 200), ts: Date.now() });
                    }
                    return origSend.apply(this, arguments);
                };
            } catch (e) { window.__diag.sentMessagesHookErr = e.message; }

            // Hook inbound at the WS layer if reachable, else hook _onMessage.
            // CanvasTileLayer._onDownloadAsMsg is what fires filedownloadready;
            // intercept it directly to see if it ever ran.
            try {
                const layer = app.map._docLayer || (app.map._layers && Object.values(app.map._layers).find(l => l._onDownloadAsMsg));
                if (layer && typeof layer._onDownloadAsMsg === 'function') {
                    const orig = layer._onDownloadAsMsg.bind(layer);
                    layer._onDownloadAsMsg = function(textMsg) {
                        window.__diag.gotDownloadasReply = {
                            msg: typeof textMsg === 'string' ? textMsg.substring(0, 300) : '<non-string>',
                            ts: Date.now(),
                        };
                        return orig(textMsg);
                    };
                    window.__diag.downloadAsHooked = true;
                } else {
                    window.__diag.downloadAsHooked = false;
                }
            } catch (e) { window.__diag.downloadAsHookErr = e.message; }

            // Hook app.map.fire to capture filedownloadready + postMessage events.
            const origFire = app.map.fire;
            app.map.fire = function(type, data) {
                if (type === 'filedownloadready') {
                    window.__capturedPrintEvent = {
                        url: data && data.url,
                        ts: Date.now(),
                    };
                }
                if (type === 'postMessage' && data && data.msgId === 'Download_As') {
                    window.__capturedDownloadAsPM = {
                        args: data.args,
                        ts: Date.now(),
                    };
                }
                if (window.__diag.firedEvents.length < 200
                    && (type === 'filedownloadready' || type === 'postMessage'
                        || type === 'docloaded' || type.indexOf('download') >= 0
                        || type.indexOf('print') >= 0)) {
                    window.__diag.firedEvents.push({ type: type, ts: Date.now() });
                }
                return origFire.apply(this, arguments);
            };

            return {
                hasDispatcher: window.__diag.hasDispatcher,
                hasMapPrint: window.__diag.hasMapPrint,
                wopi: {
                    DisablePrint: window.__diag.wopiDisablePrint,
                    HidePrintOption: window.__diag.wopiHidePrint,
                    DownloadAsPostMessage: window.__diag.wopiDownloadAsPM,
                },
                hasWasmFS: window.__diag.hasWasmFS,
                hasEmscriptenApp: window.__diag.hasEmscriptenApp,
                downloadAsHooked: window.__diag.downloadAsHooked,
            };
        });
        console.log('  diag pre-dispatch: ' + JSON.stringify(diag));

        // Track network: the bug signature is a 404 to /<prefix>/<doc>/download/<id>
        let saw404 = false;
        up.page.on('response', r => {
            const u = r.url();
            if (u.indexOf('/download/') >= 0 && r.status() === 404) {
                saw404 = true;
                console.log('  · saw 404 on ' + u);
            }
        });

        // Trigger print via the kit dispatcher (same path the toolbar uses).
        await up.editorFrame.evaluate(() => {
            if (typeof app !== 'undefined' && app.dispatcher
                && typeof app.dispatcher.dispatch === 'function') {
                app.dispatcher.dispatch('print');
            } else if (typeof app !== 'undefined' && app.socket
                       && typeof app.socket.sendMessage === 'function') {
                app.socket.sendMessage('uno .uno:Print');
            } else {
                throw new Error('No kit dispatcher reachable');
            }
        });

        // Poll for filedownloadready (or the postMessage fallback). Allow
        // up to 30 s for the kit's saveAs("pdf") + downloadas: round-trip +
        // blob URL construction.
        const evtTimeout = env.scaleTimeout(30000);
        const evtStart = Date.now();
        let captured = null;
        let capturedPM = null;
        while (Date.now() - evtStart < evtTimeout) {
            const state = await up.editorFrame.evaluate(() => ({
                fired: window.__capturedPrintEvent,
                pm: window.__capturedDownloadAsPM,
            }));
            if (state.fired || state.pm) {
                captured = state.fired;
                capturedPM = state.pm;
                break;
            }
            await sleep(500);
        }

        // Dump chain state regardless of pass/fail so the report always
        // shows where the print pipeline got stuck this run.
        const post = await up.editorFrame.evaluate(() => ({
            sent: window.__diag.sentMessages,
            got: window.__diag.gotDownloadasReply,
            fired: window.__diag.firedEvents.slice(-30),
        }));
        console.log('  diag post-dispatch:');
        console.log('    sent ' + post.sent.length + ' downloadas/Print message(s): '
            + JSON.stringify(post.sent));
        console.log('    got downloadas: reply: ' + JSON.stringify(post.got));
        console.log('    map.fire events seen (last 30): '
            + JSON.stringify(post.fired));
        console.log('    kit console lines matching pipeline (count=' + kitLines.length + '):');
        for (const line of kitLines) console.log('      | ' + line);

        check('filedownloadready (or Download_As pm) fires within ' + evtTimeout + 'ms',
              !!(captured || capturedPM),
              capturedPM ? 'took postMessage path (host integration)' : '');

        const url = captured && captured.url;
        check('event URL is a blob: URL (not editor-origin /download/)',
              url && url.startsWith('blob:'),
              'url=' + url);

        // Validate the blob content: fetch from the editor frame (same
        // origin as the blob) and check the PDF magic.
        if (url && url.startsWith('blob:')) {
            const head = await up.editorFrame.evaluate(async (u) => {
                const r = await fetch(u);
                const b = await r.arrayBuffer();
                const head4 = new Uint8Array(b).slice(0, 5);
                return Array.from(head4).map(c => String.fromCharCode(c)).join('');
            }, url);
            check('blob body starts with "%PDF-"', head === '%PDF-',
                  'first 5 bytes: ' + JSON.stringify(head));
        }

        check('no editor-origin /download/ 404 (the pre-fix bug signature)',
              !saw404);

        console.log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    } catch (err) {
        console.error('FAIL:', err.message);
        if (err.stack) console.error(err.stack);
        allPassed = false;
    } finally {
        await cleanup();
        process.exit(allPassed ? 0 : 1);
    }
})();
