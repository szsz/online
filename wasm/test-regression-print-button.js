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
//   2. The flow reaches print() with a blob: URL (NOT an editor-origin URL).
//   3. The PDF body starts with "%PDF-" (real saveAs output, not an empty
//      stub).
//   4. No "404" console error from the editor-origin /download/ route appears.
//
// Stubs out the real print dialog so the test doesn't freeze on a system
// modal in headless Chrome.

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

        // Stub iframe.contentWindow.print BEFORE navigation so the OS dialog
        // never fires. The real Map.Print._onIframeLoaded creates the hidden
        // iframe via L.DomUtil.create, then calls
        // this._printIframe.contentWindow.print() at Map.Print.js:55. We hook
        // the iframe creation and replace contentWindow with a stub that
        // records the call instead of opening the dialog.
        const installStub = (page) => {
            return page.evaluateOnNewDocument(() => {
                window.__printDialogOpened = false;
                window.__printBlobUrl = null;
                const origDescriptor = Object.getOwnPropertyDescriptor(
                    HTMLIFrameElement.prototype, 'contentWindow');
                Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
                    configurable: true,
                    get() {
                        const real = origDescriptor.get.call(this);
                        // Wrap real contentWindow so .print() is intercepted
                        // but everything else (e.g. assignment in viewer)
                        // works.
                        if (!real) return real;
                        return new Proxy(real, {
                            get(t, prop) {
                                if (prop === 'print') {
                                    return function() {
                                        try {
                                            window.__printBlobUrl =
                                                t.location && t.location.href;
                                        } catch(e) {}
                                        window.__printDialogOpened = true;
                                    };
                                }
                                return t[prop];
                            },
                            set(t, prop, value) { t[prop] = value; return true; }
                        });
                    }
                });
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
        console.log('  Editor ready, dispatching .uno:Print');

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
            // app.dispatcher.dispatch is the canonical entry; fall back to
            // socket-level uno command if app dispatcher isn't on window.
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

        // Poll for the stubbed print() call. Allow up to 20 s for the kit's
        // saveAs("pdf") + downloadas: round-trip + blob URL construction.
        const dialogTimeout = env.scaleTimeout(20000);
        const dialogStart = Date.now();
        let dialogOpened = false;
        let blobUrl = null;
        while (Date.now() - dialogStart < dialogTimeout) {
            const state = await up.page.evaluate(() => ({
                opened: window.__printDialogOpened,
                url: window.__printBlobUrl,
            }));
            if (state.opened) {
                dialogOpened = true;
                blobUrl = state.url;
                break;
            }
            await sleep(500);
        }

        check('print() invoked within ' + dialogTimeout + 'ms', dialogOpened);
        check('print iframe carries a blob: URL (not editor-origin /download/)',
              blobUrl && blobUrl.startsWith('blob:'),
              'url=' + blobUrl);

        // Validate the blob content: download via XHR and check the PDF magic.
        if (blobUrl && blobUrl.startsWith('blob:')) {
            const head = await up.page.evaluate(async (u) => {
                const r = await fetch(u);
                const b = await r.arrayBuffer();
                const head4 = new Uint8Array(b).slice(0, 5);
                return Array.from(head4).map(c => String.fromCharCode(c)).join('');
            }, blobUrl);
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
