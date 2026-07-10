// test-cv-regression-print-button.js — Print produces a printable PDF via the
// in-memory Emscripten FS (blob: URL), not the dead C++-coolwsd /download/
// HTTP route.
//
// WHAT IS VERIFIED (same subject as the legacy test):
//   1. Triggering print runs the kit's downloadas flow (saveAs "print.pdf").
//   2. The map fires `filedownloadready` with a blob: URL (NOT an
//      editor-origin /download/ URL) — the canonical signal of the WASM
//      short-circuit in CanvasTileLayer._onDownloadAsMsg. A Download_As
//      postMessage (host integration) is also accepted, as in the legacy test.
//   3. The blob body starts with "%PDF-" (real saveAs output, not a stub).
//   4. No editor-origin /download/ 404 appears (the pre-fix bug signature).
//
// Harness change vs legacy: the legacy test triggered print through
// app.dispatcher.dispatch('print'). The content-viewer's editor iframe is
// SAME-ORIGIN, so we drive the real user input instead: click into the doc,
// press Ctrl+P (COOL's keyboard handler dispatches print), with a File-tab
// Print-button fallback. The map.fire/_onDownloadAsMsg hooks remain —
// observation-only instrumentation, never used to drive.
//
// Migrated from wasm/tests/regression/test-regression-print-button.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-print-button.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, waitCvInteractive } = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOCX = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const EVT_BUDGET = 45000;   // kit saveAs(pdf) + downloadas round-trip + blob build
const SHOT_DIR = '/tmp/content-viewer-report/regression-print-button';

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
const editorFrame = page => page.frames().find(f => (f.url() || '').includes('cool.html'));
async function snap(page, name) {
    try { fs.mkdirSync(SHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${SHOT_DIR}/${name}.png` }); } catch (e) {}
}

(async () => {
    if (!fs.existsSync(DOCX)) { check('fixture present', false, DOCX); process.exit(2); }
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    try {
        const page = await browser.newPage();

        // Stub iframe.contentWindow.print so the OS print dialog never opens
        // if Map.Print._onIframeLoaded fires. Best-effort harness protection;
        // the real assertion is on `filedownloadready` below.
        await page.evaluateOnNewDocument(() => {
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
                                if (prop === 'print') return function () { /* noop */ };
                                const v = Reflect.get(t, prop);
                                return typeof v === 'function' ? v.bind(t) : v;
                            },
                            set(t, prop, value) { t[prop] = value; return true; },
                        });
                    },
                });
            } catch (_) { /* some envs lock the prototype — fine */ }
        });

        // Capture kit console lines about the print/downloadas pipeline (diag).
        const kitLines = [];
        page.on('console', (msg) => {
            try {
                const t = msg.text();
                if (/downloadas|saveAs|SaveAs|registerdownload|filterDownloadAs|cmd=downloadas/i.test(t)) {
                    if (kitLines.length < 50) kitLines.push(t.substring(0, 300));
                }
            } catch (_) { /* */ }
        });

        // Track network: the bug signature is a 404 to /<prefix>/<doc>/download/<id>.
        let saw404 = false;
        page.on('response', r => {
            const u = r.url();
            if (u.indexOf('/download/') >= 0 && r.status() === 404) {
                saw404 = true;
                log('  · saw 404 on ' + u);
            }
        });

        await openViaContentViewer(browser, BASE, DOCX, {
            page, viewport: { width: 1600, height: 1000 }, iframeTimeout: 45000,
        });
        check('editor interactive', await waitCvInteractive(page, LOAD_BUDGET));
        const fr = editorFrame(page);
        if (!fr) throw new Error('editor frame never appeared');
        await fr.waitForFunction(() => {
            const wc = document.querySelector('#StateWordCount');
            return !!(wc && wc.textContent && wc.textContent.includes('characters'));
        }, { timeout: 60000 });
        await sleep(2000);
        log('Editor ready, hooking filedownloadready');

        // Observation-only instrumentation: capture filedownloadready /
        // Download_As postMessage and whether _onDownloadAsMsg ever ran.
        const diag = await fr.evaluate(() => {
            window.__capturedPrintEvent = null;
            window.__capturedDownloadAsPM = null;
            window.__diag = {
                hasWasmFS: !!window.__wasmFS,
                hasEmscriptenApp: !!window.ThisIsTheEmscriptenApp,
                gotDownloadasReply: null,
                firedEvents: [],
            };
            try {
                const layer = app.map._docLayer || (app.map._layers
                    && Object.values(app.map._layers).find(l => l._onDownloadAsMsg));
                if (layer && typeof layer._onDownloadAsMsg === 'function') {
                    const orig = layer._onDownloadAsMsg.bind(layer);
                    layer._onDownloadAsMsg = function (textMsg) {
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

            const origFire = app.map.fire;
            app.map.fire = function (type, data) {
                if (type === 'filedownloadready') {
                    window.__capturedPrintEvent = { url: data && data.url, ts: Date.now() };
                }
                if (type === 'postMessage' && data && data.msgId === 'Download_As') {
                    window.__capturedDownloadAsPM = { args: data.args, ts: Date.now() };
                }
                if (window.__diag.firedEvents.length < 200
                    && (type === 'filedownloadready' || type === 'postMessage'
                        || type.indexOf('download') >= 0 || type.indexOf('print') >= 0)) {
                    window.__diag.firedEvents.push({ type, ts: Date.now() });
                }
                return origFire.apply(this, arguments);
            };
            return {
                hasWasmFS: window.__diag.hasWasmFS,
                hasEmscriptenApp: window.__diag.hasEmscriptenApp,
                downloadAsHooked: window.__diag.downloadAsHooked,
            };
        });
        log('  diag pre-trigger: ' + JSON.stringify(diag));
        await snap(page, '01_ready');

        // ── Trigger print via REAL user input: click into the doc, Ctrl+P ──
        const ifEl = await page.$('iframe');
        const ifBox = await ifEl.boundingBox();
        await page.mouse.click(ifBox.x + ifBox.width / 2,
            ifBox.y + Math.min(ifBox.height * 0.5, 400));
        await sleep(500);
        await page.keyboard.down('Control');
        await page.keyboard.press('p');
        await page.keyboard.up('Control');
        log('Pressed Ctrl+P');

        const readCaptured = () => fr.evaluate(() => ({
            fired: window.__capturedPrintEvent,
            pm: window.__capturedDownloadAsPM,
        })).catch(() => ({ fired: null, pm: null }));

        let captured = null, capturedPM = null;
        let triedFallback = false;
        const evtStart = Date.now();
        while (Date.now() - evtStart < EVT_BUDGET) {
            const state = await readCaptured();
            if (state.fired || state.pm) { captured = state.fired; capturedPM = state.pm; break; }
            // Fallback after 15 s: drive the File-tab Print button (real UI).
            if (!triedFallback && Date.now() - evtStart > 15000) {
                triedFallback = true;
                log('  Ctrl+P produced nothing yet — falling back to File tab → Print button');
                try {
                    const tabRect = await fr.evaluate(() => {
                        const el = document.querySelector('#File-tab-label');
                        if (!el) return null;
                        const r = el.getBoundingClientRect();
                        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                    });
                    if (tabRect) {
                        await page.mouse.click(ifBox.x + tabRect.x, ifBox.y + tabRect.y);
                        await sleep(1200);
                    }
                    const btnRect = await fr.evaluate(() => {
                        const btns = [...document.querySelectorAll('button')];
                        const b = btns.find(x => x.offsetWidth > 0 && x.offsetHeight > 0
                            && /print/i.test(x.getAttribute('aria-label') || x.id || ''));
                        if (!b) return null;
                        const r = b.getBoundingClientRect();
                        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                    });
                    if (btnRect) {
                        await page.mouse.click(ifBox.x + btnRect.x, ifBox.y + btnRect.y);
                        log('  clicked notebookbar Print button');
                    } else {
                        log('  no visible Print button found in the File tab');
                    }
                } catch (e) { log('  fallback click failed: ' + e.message); }
            }
            await sleep(500);
        }

        // Diagnostic dump regardless of pass/fail.
        const post = await fr.evaluate(() => ({
            got: window.__diag.gotDownloadasReply,
            fired: window.__diag.firedEvents.slice(-30),
        })).catch(() => ({}));
        log('  diag post-trigger: downloadas reply=' + JSON.stringify(post.got));
        log('  map.fire events (last 30): ' + JSON.stringify(post.fired));
        log('  kit console lines matching pipeline (count=' + kitLines.length + '):');
        for (const line of kitLines) log('    | ' + line);
        await snap(page, '02_after_print');

        check('filedownloadready (or Download_As pm) fires within ' + EVT_BUDGET + 'ms',
            !!(captured || capturedPM),
            capturedPM ? 'took postMessage path (host integration)' : '');

        const url = captured && captured.url;
        check('event URL is a blob: URL (not editor-origin /download/)',
            !!(url && url.startsWith('blob:')), 'url=' + url);

        if (url && url.startsWith('blob:')) {
            const head = await fr.evaluate(async (u) => {
                const r = await fetch(u);
                const b = await r.arrayBuffer();
                const head5 = new Uint8Array(b).slice(0, 5);
                return Array.from(head5).map(c => String.fromCharCode(c)).join('');
            }, url);
            check('blob body starts with "%PDF-"', head === '%PDF-',
                'first 5 bytes: ' + JSON.stringify(head));
        }

        check('no editor-origin /download/ 404 (the pre-fix bug signature)', !saw404);
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
