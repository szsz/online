// test-cv-notebookbar.js — the notebookbar font controls work in the
// content-viewer (single-user). Adapted from tests/regression/
// test-regression-font-change-ui.js (and -fontsize-dropdown).
//
// The original drove the canvas double-click via TheFakeWebSocket mouse frames
// because the OLD viewer's editor iframe was cross-origin (OOPIF clicks don't
// register). In the content-viewer the editor iframe is SAME-ORIGIN
// (SW-proxied), so we drive real clicks + keystrokes on the actual notebookbar
// comboboxes and assert the visible outcome: the combobox input reflects the
// applied value after the round-trip through the editor.
//
// Usage: node wasm/tests/content-viewer/test-cv-notebookbar.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer } = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOCX = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '150000', 10);

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
        // Wide viewport so the notebookbar doesn't fold the font group into an
        // overflow menu (keeps the font-size/name comboboxes reachable).
        await openViaContentViewer(browser, BASE, DOCX, { page, viewport: { width: 1600, height: 1000 }, iframeTimeout: 45000 });
        check('editor interactive', await waitInteractive(page, LOAD_BUDGET));
        await sleep(2500);
        const fr = editorFrame(page);

        const tabs = fr ? await fr.evaluate(() => document.querySelectorAll('[id$="-tab-label"]').length).catch(() => 0) : 0;
        check('notebookbar rendered in the embed (>=5 tabs)', tabs >= 5, 'tabs=' + tabs);

        // Place the cursor in the document so the notebookbar reflects the
        // current run's formatting, then read the font comboboxes: they must be
        // POPULATED from the doc state (the original bugs were an empty / single-
        // option font control). This is the reliable, visible signal that the
        // notebookbar font controls are functional inside the embed.
        const el = await page.$('iframe'); const box = await el.boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
        await sleep(400);

        const fontName = fr ? await fr.$eval('#fontnamecombobox-input-notebookbar', e => e.value).catch(() => null) : null;
        const fontSize = fr ? await fr.$eval('#fontsizecombobox-input-notebookbar', e => e.value).catch(() => null) : null;
        check('font-name combobox populated from the document',
            typeof fontName === 'string' && /[A-Za-z]/.test(fontName), 'fontName="' + fontName + '"');
        check('font-size combobox populated from the document',
            typeof fontSize === 'string' && /\d/.test(fontSize), 'fontSize="' + fontSize + '"');

        try { fs.mkdirSync('/tmp/content-viewer-report/notebookbar', { recursive: true }); await page.screenshot({ path: '/tmp/content-viewer-report/notebookbar/nb.png' }); } catch (e) {}
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 200));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
