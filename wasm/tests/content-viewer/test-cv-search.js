// test-cv-search.js — Ctrl+F find works in the content-viewer (single-user).
// Adapted from tests/regression/test-regression-search.js.
//
// Opens a doc via /collabora-tester, types a unique token into the body,
// presses Ctrl+F, types the token into the search box, presses Enter, and
// asserts the editor found + selected it (the status bar flips to a "Selected"
// state). Pure UI: real keyboard only.
//
// Usage: node wasm/tests/content-viewer/test-cv-search.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer } = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOCX = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const TOKEN = 'ZQXFINDME';
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
async function statusText(fr) {
    return fr.evaluate(() => document.querySelector('#StateWordCount')?.textContent?.trim() || '').catch(() => '');
}

(async () => {
    if (!fs.existsSync(DOCX)) { check('fixture present', false, DOCX); process.exit(2); }
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        await openViaContentViewer(browser, BASE, DOCX, { page, iframeTimeout: 45000 });
        check('editor interactive', await waitInteractive(page, LOAD_BUDGET));
        await sleep(2000);
        const fr = editorFrame(page);

        // Type the token at the end of the doc.
        const el = await page.$('iframe'); const box = await el.boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.5, 400));
        await sleep(300);
        await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
        await sleep(150);
        await page.keyboard.type(' ' + TOKEN, { delay: 35 });
        await sleep(800);
        // Move cursor home so the search has to travel to find the token.
        await page.keyboard.down('Control'); await page.keyboard.press('Home'); await page.keyboard.up('Control');
        await sleep(300);

        // Ctrl+F → search input appears.
        await page.keyboard.down('Control'); await page.keyboard.press('KeyF'); await page.keyboard.up('Control');
        await sleep(1200);
        const searchVisible = fr ? await fr.evaluate(() => {
            const ids = ['navigator-search-input', 'search-input', 'toolbar-search'];
            return ids.some(id => { const e = document.getElementById(id); return e && e.offsetParent !== null; })
                || !!document.querySelector('input[type="search"], .search-input');
        }).catch(() => false) : false;
        check('Ctrl+F opened a search input', searchVisible);

        // Type the token + Enter.
        await page.keyboard.type(TOKEN, { delay: 40 });
        await sleep(400);
        await page.keyboard.press('Enter');
        await sleep(1200);

        // Found → the doc selects the match; the status bar flips to a
        // "Selected" state (StateWordCount shows the selection).
        const st = fr ? await statusText(fr) : '';
        check('search found + selected the token (status shows selection)',
            /select/i.test(st), 'status="' + st + '"');
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 200));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
