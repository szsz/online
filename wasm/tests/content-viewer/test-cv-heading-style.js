// test-cv-heading-style.js — apply a paragraph style via the notebookbar in the
// content-viewer. Adapted from tests/regression/test-regression-heading-styles.js
// (which used sendUnoCommand for SelectAll; here we drive real UI only).
//
// Opens a doc, places the cursor in the body, records the font size, clicks the
// "Heading 1" entry in the notebookbar styles iconview (#stylesview_4), and
// asserts the applied style changed the formatting — the font-size combobox
// value changes (Heading 1 is larger than Body Text). Visible outcome, real UI.
//
// Usage: node wasm/tests/content-viewer/test-cv-heading-style.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer } = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
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
const fontSize = fr => fr.$eval('#fontsizecombobox-input-notebookbar', e => e.value).catch(() => '');

(async () => {
    if (!fs.existsSync(DOCX)) { check('fixture present', false, DOCX); process.exit(2); }
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        await openViaContentViewer(browser, BASE, DOCX, { page, viewport: { width: 1600, height: 1000 }, iframeTimeout: 45000 });
        check('editor interactive', await waitInteractive(page, LOAD_BUDGET));
        await sleep(2500);
        const fr = editorFrame(page);

        // Place cursor in the body text.
        const el = await page.$('iframe'); const box = await el.boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
        await sleep(500);
        const sizeBefore = await fontSize(fr);
        check('font-size read before (body)', /\d/.test(sizeBefore), 'before="' + sizeBefore + '"');

        // Confirm the styles entry is Heading 1, then click it (real UI element).
        const label = fr ? await fr.$eval('#stylesview_4', e => (e.getAttribute('title') || e.getAttribute('aria-label') || e.textContent || '').trim()).catch(() => '') : '';
        check('styles entry #stylesview_4 is "Heading 1"', /Heading 1/i.test(label), 'label="' + label + '"');
        const h = await fr.$('#stylesview_4');
        if (h) { try { await h.click(); } catch (e) { await fr.evaluate(() => document.querySelector('#stylesview_4').click()); } }
        await sleep(2000);

        const sizeAfter = await fontSize(fr);
        check('applying Heading 1 changed the font size (style applied)',
            /\d/.test(sizeAfter) && sizeAfter !== sizeBefore, 'before="' + sizeBefore + '" after="' + sizeAfter + '"');

        try { fs.mkdirSync('/tmp/content-viewer-report/heading-style', { recursive: true }); await page.screenshot({ path: '/tmp/content-viewer-report/heading-style/h1.png' }); } catch (e) {}
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 200));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
