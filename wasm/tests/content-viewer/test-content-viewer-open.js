// E2E: our WASM editor embedded by the Tresorit content-preview app.
//
// Drives content-preview's standalone /collabora-tester route through the REAL
// file <input> (no backend, no Tresorit host): pick a .docx → the SPA stages it
// into its service worker (collabora-sw.js) → navigates a same-origin editor
// iframe to /collabora-<ver>/cool.html → the SW proxies our editor's assets
// (flat CDN) and serves the document at /local-file/<id> → our editor's
// "content-viewer mode" fetches it into the Emscripten FS and opens it.
//
// Asserts: cross-origin isolation is active (SAB available), the editor iframe
// reaches ready state, and the document loads (#StateWordCount shows a char
// count). This is the acceptance test for the content-viewer integration.
//
// Topology (all localhost = secure context, so COOP/COEP → crossOriginIsolated
// without TLS):
//   :8090  content-viewer-server.js  → content-preview/dist  (top page + SW)
//   :8091  editor-CDN (this harness) → wasm/online-build/browser/dist (flat)
// content-preview/dist MUST be built with VITE_COLLABORA_CDN_URL=
//   http://localhost:8091 + VITE_COLLABORA_CDN_FLAT=1 (see the test's env check).

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { launch, sleep } = require('../../lib/browser');

const REPO = path.join(__dirname, '..', '..', '..');
const EDITOR_DIST = process.env.EDITOR_DIST || path.join(REPO, 'wasm', 'online-build', 'browser', 'dist');
const CV_DIST = process.env.CONTENT_VIEWER_DIST || '/home/localadmin/content-preview/dist';
const DOCX = process.env.DOCX || path.join(CV_DIST, 'test.docx');
const CDN_PORT = 8091;
const CV_PORT = 8090;
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '150000', 10);

let passed = true;
const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); passed = false; }
}

function contentType(f) {
    if (f.endsWith('.wasm')) return 'application/wasm';
    if (f.endsWith('.js')) return 'text/javascript';
    if (f.endsWith('.json')) return 'application/json';
    if (f.endsWith('.css')) return 'text/css';
    if (f.endsWith('.html')) return 'text/html';
    return 'application/octet-stream';
}

// Minimal CORS static host standing in for our editor CDN (the FD in prod).
function startEditorCdn() {
    const srv = http.createServer((req, res) => {
        try {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
            let raw = req.url.split('?')[0];
            let rel;
            try { rel = decodeURIComponent(raw); } catch (e) { rel = raw; } // tolerate malformed %
            rel = rel.replace(/^\/+/, '');
            const f = path.join(EDITOR_DIST, rel);
            if (!f.startsWith(EDITOR_DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
                res.statusCode = 404; return res.end('not found');
            }
            res.setHeader('Content-Type', contentType(f));
            fs.createReadStream(f).on('error', () => { try { res.destroy(); } catch (_) {} }).pipe(res);
        } catch (e) {
            try { res.statusCode = 500; res.end('err'); } catch (_) {}
        }
    });
    srv.on('clientError', (e, sock) => { try { sock.destroy(); } catch (_) {} });
    return new Promise(r => srv.listen(CDN_PORT, () => r(srv)));
}

function startContentViewer() {
    const p = spawn('node', [path.join(REPO, 'wasm', 'content-viewer-server.js')], {
        env: { ...process.env, PORT: String(CV_PORT), CONTENT_VIEWER_DIST: CV_DIST, SSL_CERT: '', SSL_KEY: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.stdout.on('data', d => process.stdout.write('[cv] ' + d));
    p.stderr.on('data', d => process.stdout.write('[cv-err] ' + d));
    return p;
}

(async () => {
    // Pre-flight: the built content-preview must be pointed at our editor CDN.
    if (!fs.existsSync(path.join(CV_DIST, 'index.html'))) {
        check('content-preview dist present', false, CV_DIST); return finish();
    }
    if (!fs.existsSync(path.join(EDITOR_DIST, 'cool.html'))) {
        check('editor build present', false, EDITOR_DIST); return finish();
    }
    if (!fs.existsSync(DOCX)) { check('fixture docx present', false, DOCX); return finish(); }
    const sw = fs.readFileSync(path.join(CV_DIST, 'collabora-sw.js'), 'utf8');
    check('content-preview built with cdnFlat SW', /cdnFlat/.test(sw));

    const cdn = await startEditorCdn();
    log(`editor-CDN on :${CDN_PORT} → ${EDITOR_DIST}`);
    const cv = startContentViewer();
    await sleep(1500);

    let browser;
    try {
        ({ browser } = await launch({ headless: 'new' }));
        const page = await browser.newPage();
        const errs = [];
        page.on('console', m => {
            const t = m.text();
            if (/content-viewer|local-file|Aborted|memory access|RuntimeError|unreachable/i.test(t))
                log('  [page] ' + t.slice(0, 160));
            if (/Aborted|memory access out of bounds|RuntimeError|unreachable/i.test(t)) errs.push(t.slice(0, 120));
        });
        page.on('pageerror', e => log('  [pageerror] ' + String(e).slice(0, 160)));

        log('open /collabora-tester');
        await page.goto(`http://localhost:${CV_PORT}/collabora-tester`, { waitUntil: 'domcontentloaded', timeout: 60000 });

        const coi = await page.evaluate(() => self.crossOriginIsolated);
        check('top page cross-origin isolated (SAB available)', coi === true, 'crossOriginIsolated=' + coi);

        const input = await page.waitForSelector('input[type=file]', { timeout: 15000 });
        log('upload ' + path.basename(DOCX));
        await input.uploadFile(DOCX);

        await page.waitForFunction(() => {
            const f = document.querySelector('iframe');
            return !!(f && f.src && f.src.includes('cool.html'));
        }, { timeout: 30000 });
        const src = await page.evaluate(() => document.querySelector('iframe').src);
        check('editor iframe navigated to cool.html', /cool\.html\?.*localFileId=/.test(src), src.slice(src.indexOf('cool.html')));

        // Access the same-origin editor frame + wait for the doc to load.
        log('waiting for editor ready (cold load, budget ' + (LOAD_BUDGET / 1000) + 's)...');
        let editorFrame = null;
        const deadline = Date.now() + LOAD_BUDGET;
        while (Date.now() < deadline && !editorFrame) {
            editorFrame = page.frames().find(f => f.url().includes('cool.html'));
            if (!editorFrame) await sleep(500);
        }
        check('editor frame handle acquired', !!editorFrame);

        let charCount = '';
        if (editorFrame) {
            try {
                await editorFrame.waitForFunction(
                    () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''),
                    { timeout: deadline - Date.now() });
                charCount = await editorFrame.evaluate(() => document.querySelector('#StateWordCount')?.textContent || '');
            } catch (e) { /* asserted below */ }
        }
        check('document loaded in editor (#StateWordCount lit)', /character/i.test(charCount), charCount.trim());
        check('no WASM abort / OOB during load', errs.length === 0, errs.slice(0, 2).join(' | '));

        try {
            fs.mkdirSync('/tmp/content-viewer-report', { recursive: true });
            await page.screenshot({ path: '/tmp/content-viewer-report/collabora-tester.png' });
            log('screenshot: /tmp/content-viewer-report/collabora-tester.png');
        } catch (e) { /* best effort */ }
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        if (browser) { try { await browser.close(); } catch (e) {} }
        try { cv.kill(); } catch (e) {}
        try { cdn.close(); } catch (e) {}
    }
    finish();
})();

function finish() {
    log(passed ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED');
    process.exit(passed ? 0 : 1);
}
