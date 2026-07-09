// test-cv-insert-image.js — inserting an image works in the content-viewer.
// Adapted from tests/regression/test-regression-image-insert.js /
// test-singleuser-copy-paste.js case 7.
//
// Opens a doc, writes a PNG to the clipboard, focuses the body, pastes (Ctrl+V),
// and asserts the image was inserted + auto-selected — the Picture context tab
// (#Picture-tab-label) becomes visible. Real UI.
//
// Usage: node wasm/tests/content-viewer/test-cv-insert-image.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer } = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOCX = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '150000', 10);
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
const editorFrame = page => page.frames().find(f => (f.url() || '').includes('cool.html'));
async function interactive(page) {
    return page.evaluate(() => {
        if (document.querySelector('[role="status"][aria-label="Loading"]')) return false;
        const s = [...document.querySelectorAll('button')].find(b => /^save$/i.test((b.textContent || '').trim()));
        return !!(s && !s.disabled);
    }).catch(() => false);
}
async function waitInteractive(page, budget) {
    const d = Date.now() + budget;
    while (Date.now() < d) { if (await interactive(page)) return true; await sleep(500); }
    return false;
}

(async () => {
    if (!fs.existsSync(DOCX)) { check('fixture present', false, DOCX); process.exit(2); }
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        const cdp = await page.target().createCDPSession();
        try { await cdp.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }); } catch (e) {}
        await openViaContentViewer(browser, BASE, DOCX, { page, iframeTimeout: 45000 });
        check('editor interactive', await waitInteractive(page, LOAD_BUDGET));
        await sleep(2500);
        const fr = editorFrame(page);

        // Focus the body.
        const el = await page.$('iframe'); const box = await el.boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
        await sleep(400);

        // Write a PNG to the clipboard (via the same-origin iframe, which holds
        // the clipboard grant for the editor), then paste.
        await fr.evaluate(async (b64) => {
            const bin = atob(b64); const buf = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([buf], { type: 'image/png' }) })]);
        }, PNG_B64).catch(() => {});
        await sleep(400);
        await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
        await sleep(200);
        await page.keyboard.down('Control'); await page.keyboard.press('KeyV'); await page.keyboard.up('Control');

        // Visible outcome: a freshly inserted image auto-selects, flipping the
        // notebookbar to the Picture context tab.
        let pictureTab = false;
        try {
            await fr.waitForFunction(() => {
                const el2 = document.querySelector('#Picture-tab-label');
                return !!el2 && el2.offsetParent !== null;
            }, { timeout: 12000 });
            pictureTab = true;
        } catch (e) {}
        check('image inserted + selected (Picture context tab visible)', pictureTab);

        try { fs.mkdirSync('/tmp/content-viewer-report/insert-image', { recursive: true }); await page.screenshot({ path: '/tmp/content-viewer-report/insert-image/img.png' }); } catch (e) {}
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 200));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
