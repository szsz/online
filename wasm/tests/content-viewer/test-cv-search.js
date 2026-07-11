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
// new.docx body is "baseline newcontent" — search for an EXISTING in-body word
// rather than appending a nonsense token. Appending a token adds an extra
// doc-edit + a second race (the appended text landing) for no test benefit; the
// subject ("Ctrl+F finds + selects a word that is in the doc") is fully covered
// by an in-body token and is far more reliable.
const TOKEN = 'newcontent';
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
        const el = await page.$('iframe'); const box = await el.boundingBox();

        // Locate the visible QuickFind / find-bar input, if any. The modern
        // Writer path opens the Navigator QuickFind tab (#navigator-search-input);
        // the legacy mobile path uses #search-input.
        async function findSearchRect() {
            return fr ? fr.evaluate(() => {
                const ids = ['navigator-search-input', 'search-input', 'toolbar-search'];
                for (const id of ids) {
                    const e = document.getElementById(id);
                    if (e && e.offsetParent !== null) {
                        const r = e.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0)
                            return { id, x: r.x, y: r.y, w: r.width, h: r.height };
                    }
                }
                const q = document.querySelector('input[type="search"], .search-input');
                if (q && q.offsetParent !== null) {
                    const r = q.getBoundingClientRect();
                    if (r.width > 0) return { id: 'query', x: r.x, y: r.y, w: r.width, h: r.height };
                }
                return null;
            }).catch(() => null) : null;
        }

        // Ctrl+F does not always open the QuickFind input on the first press
        // (the keystroke can land in the doc instead). Click the doc to focus
        // the iframe, then press Ctrl+F, retrying until the input appears.
        await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.5, 400));
        await sleep(300);
        let searchRect = null;
        for (let attempt = 0; attempt < 4 && !searchRect; attempt++) {
            await page.keyboard.down('Control'); await page.keyboard.press('KeyF'); await page.keyboard.up('Control');
            await sleep(1500);
            searchRect = await findSearchRect();
        }
        check('Ctrl+F opened a search input', !!searchRect,
            searchRect ? searchRect.id : '(none)');
        if (!searchRect) throw new Error('QuickFind input never appeared after Ctrl+F');

        // Type the token into the input and commit. The QuickFind search command
        // occasionally does not register even when the input value is correct
        // (a kit-side race), so wrap the whole type+commit+observe in a retry:
        // clear the input, type the token, press Enter, then poll the status bar
        // for the "Selected" state. Enter and the Search pushbutton
        // (#navigator-search-button-button) both commit — Enter is the canonical
        // keyboard flow.
        async function typeAndSearchOnce() {
            const r = await findSearchRect();
            if (!r) return '';
            const ix = box.x + r.x + r.w / 2;
            const iy = box.y + r.y + r.h / 2;
            await page.mouse.click(ix, iy);
            await sleep(300);
            await page.mouse.click(ix, iy, { clickCount: 3 }); // select existing text
            await sleep(200);
            await page.keyboard.press('Backspace');
            await sleep(200);
            await page.keyboard.type(TOKEN, { delay: 60 });
            await sleep(400);
            await page.keyboard.press('Enter');
            // Poll the status bar: a found match selects the text, flipping
            // #StateWordCount to a "Selected: …" state.
            let st = '';
            const sd = Date.now() + 6000;
            while (Date.now() < sd) {
                st = fr ? await statusText(fr) : '';
                if (/select/i.test(st)) return st;
                await sleep(300);
            }
            return st;
        }

        let st = await typeAndSearchOnce();
        if (!/select/i.test(st)) {
            log(`  search did not register (status="${st}") — retrying once`);
            st = await typeAndSearchOnce();
        }
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
