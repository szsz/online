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

        const up = await openViaViewer(browser, VIEWER, docName, docBytes,
            { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
              isolatedContext: true,
              onPage: installStub });

        // Wait for the doc to be loaded enough that .uno:Print would succeed.
        await up.editorFrame.waitForFunction(() => {
            const wc = document.querySelector('#StateWordCount');
            return !!(wc && wc.textContent && wc.textContent.includes('characters'));
        }, { timeout: TIMEOUT });
        console.log('  Editor ready, hooking filedownloadready');

        // Hook app.map.fire INSIDE the editor frame. CanvasTileLayer's WASM
        // short-circuit calls this._map.fire('filedownloadready', {url: blobUrl})
        // exactly once when the kit returns downloadas: for the print job.
        // Capturing it is the cleanest evidence the fix path executed.
        await up.editorFrame.evaluate(() => {
            window.__capturedPrintEvent = null;
            window.__capturedDownloadAsPM = null;
            const origFire = app.map.fire;
            app.map.fire = function(type, data) {
                if (type === 'filedownloadready') {
                    window.__capturedPrintEvent = {
                        url: data && data.url,
                        ts: Date.now(),
                    };
                }
                // Some hosts route print as a Download_As postMessage instead;
                // capture that too so we can give a precise failure reason.
                if (type === 'postMessage' && data && data.msgId === 'Download_As') {
                    window.__capturedDownloadAsPM = {
                        args: data.args,
                        ts: Date.now(),
                    };
                }
                return origFire.apply(this, arguments);
            };
        });

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
