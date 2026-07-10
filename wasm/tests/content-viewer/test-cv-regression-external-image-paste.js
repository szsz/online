// test-cv-regression-external-image-paste.js — external 1x1 PNG paste
// (Ctrl+V) routes to the local Kit and embeds the image, through the
// Tresorit content-viewer (/collabora-tester).
//
// Background (iter9 bug, fixed long ago — kept as a tripwire): `insertfile`
// had to route to the LOCAL Kit (no relay) in single-user mode; the relay
// path silently dropped it. This test re-checks that path each cold open.
//
// Shape (real puppeteer mouse + keyboard — no sendUnoCommand, no
// app.dispatcher.dispatch, no page.evaluate(()=>el.click())):
//   1. Open new.docx via the tester upload (single-user mode).
//   2. Click into the canvas to place caret. Wait for editor ready.
//   3. Write a 1x1 transparent PNG to the OS clipboard.
//   4. Ctrl+V on the canvas.
//   5. Assert: relay-adapter logged "insertfile → local Kit" AND the
//      Picture context tab appeared (image inserted + auto-selected).
//      Image paste lands as canvas pixels which are flaky to assert; the
//      message-routed signal + visible tab flip are the smoke gate.
//
// Migrated from wasm/tests/regression/test-regression-external-image-paste.js
// — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-external-image-paste.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const {
    openBytesViaContentViewer, waitCvInteractive, cvEditorFrame,
    waitCvCharCount,
} = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/regression-external-image-paste';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);

// 1x1 transparent PNG (smallest valid).
const TINY_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
let shotN = 0;
async function snap(page, name) {
    try {
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${SHOT_DIR}/${String(++shotN).padStart(2, '0')}_${name}.png` });
    } catch (e) {}
}

async function writeClipboardImage(page, b64) {
    const writeBlobInContext = target => target.evaluate(async (data) => {
        const bin = atob(data);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        const blob = new Blob([buf], { type: 'image/png' });
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    }, b64);
    // Seed permission on the parent first (some headless setups don't
    // propagate iframe grants on the first call).
    try { await writeBlobInContext(page); }
    catch (e) { /* parent might lack permission; iframe write below is the real one */ }
    const fr = cvEditorFrame(page);
    if (!fr) throw new Error('no editor iframe found for clipboard write');
    await writeBlobInContext(fr).catch(() => {});
    await sleep(300);
}

(async () => {
    log('=== Regression: external image paste (PNG) ===');
    if (!fs.existsSync(FIXTURE)) { log('ERROR: fixture missing: ' + FIXTURE); process.exit(1); }
    log('viewer: ' + BASE);
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    const { browser, cleanup } = await launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        const cdp = await page.target().createCDPSession();
        try {
            await cdp.send('Browser.grantPermissions', {
                permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
            });
        } catch (e) { /* older Chrome */ }

        // Capture relay-adapter and kit logs to assert the insertfile path.
        // Console messages from the (same-origin, SW-proxied) editor iframe
        // surface on the page's console event too.
        const capturedLogs = [];
        page.on('console', m => capturedLogs.push(m.text()));

        log('open writer via /collabora-tester');
        const bytes = fs.readFileSync(FIXTURE);
        await openBytesViaContentViewer(browser, BASE,
            'img-paste-' + Date.now() + '.docx', bytes, { page, iframeTimeout: 60000 });
        check('editor became interactive (Save enabled)', await waitCvInteractive(page, LOAD_BUDGET));
        await waitCvCharCount(page, c => c >= 0, 60000);
        log('Editor ready');
        await sleep(3000);
        await snap(page, 'editor_ready');

        // Click into the canvas to place caret.
        const iframeEl = await page.$('iframe');
        const ifBox = await iframeEl.boundingBox();
        const clickX = ifBox.x + ifBox.width / 2;
        const clickY = ifBox.y + Math.min(ifBox.height * 0.55, 450);
        await page.mouse.click(clickX, clickY);
        await sleep(1000);
        await snap(page, 'caret_placed');

        // Write image to the OS clipboard from the editor iframe context.
        const logsBeforePaste = capturedLogs.length;
        await writeClipboardImage(page, TINY_PNG_B64);
        log('clipboard image written');

        // Ctrl+V on the canvas — drive via keyboard, real user input.
        await page.keyboard.down('Control');
        await page.keyboard.press('v');
        await page.keyboard.up('Control');
        await sleep(5000);
        await snap(page, 'after_paste');

        const newLogs = capturedLogs.slice(logsBeforePaste);
        const sawLocalKitInsert = newLogs.some(l =>
            /\[relay\]\s+insertfile\s*→\s*local\s+Kit/i.test(l));
        check('relay-adapter dispatched insertfile to local Kit',
            sawLocalKitInsert,
            sawLocalKitInsert ? 'present' :
                'no "[relay] insertfile → local Kit" log in ' + newLogs.length + ' new lines');

        // Visible outcome: a freshly inserted image is auto-selected, which
        // flips the notebookbar to the Picture context tab. (Single-user
        // direct dispatch never emits a "KitWS handleMessage" console line,
        // so the visible tab flip is the reliable signal — 2026-06-12.)
        let pictureTab = false;
        try {
            const fr = cvEditorFrame(page);
            await fr.waitForFunction(() => {
                const el = document.querySelector('#Picture-tab-label');
                return !!el && el.offsetParent !== null;
            }, { timeout: 20000 });
            pictureTab = true;
        } catch (e) {}
        check('Picture context tab appeared (image inserted + selected)',
            pictureTab,
            pictureTab ? 'visible' : '#Picture-tab-label not visible within budget');
    } catch (e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        try { await (cleanup ? cleanup() : browser.close()); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
