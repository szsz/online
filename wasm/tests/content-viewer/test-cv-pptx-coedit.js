// test-cv-pptx-coedit.js — two browsers co-editing a PPTX (Impress) through
// the content viewer. Both browsers load the same pptx into a shared room,
// both show the Impress UI, both can type on a slide, and both keep the
// Impress UI intact after the co-edit exchange.
//
// Legacy subject (viewer): A opens the pptx (co-edit), B late-joins the same
// room; both must reach the Impress UI (Slide Show menu / slide sorter /
// painted canvas); A double-clicks a placeholder and types "AAA", B does the
// same and types "BBB"; both must still have the Impress UI at the end.
//
// CV port: openCoEditPair(...) creates the room (A) + joins B; each editor
// frame is waited to Impress-ready with the same subject wait as the legacy
// test (overlay gone, then Slide Show menu OR slide sorter thumbs OR painted
// canvas). Visible-UI only.
//
// Migrated from wasm/tests/misc/test-pptx-coedit.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-pptx-coedit.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const {
    openCoEditPair, waitCvInteractive, cvEditorFrame,
} = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOC_PATH = path.join(__dirname, '..', '..', '..', 'test', 'data', 'testdoc.pptx');
const SHOT_DIR = '/tmp/content-viewer-report/pptx-coedit';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch (e) {}
}

// Same subject wait as the legacy test: overlay gone, then Slide Show menu OR
// slide-sorter thumbs OR a painted canvas.
async function waitForImpress(editorFrame, label, timeout) {
    log(`[${label}] Waiting for Impress...`);
    try {
        await editorFrame.waitForFunction(() => {
            var overlay = document.getElementById('wasm-loading-overlay');
            return !overlay || overlay.style.opacity === '0' || overlay.style.display === 'none';
        }, { timeout: timeout || 180000 });
        await editorFrame.waitForFunction(() => {
            var menus = document.querySelectorAll('.menu-text, .menu-entry-with-icon, nav.main-nav, #content-keeper');
            for (var m of menus) { if (m.textContent && m.textContent.includes('Slide Show')) return true; }
            var thumbs = document.querySelectorAll('#slide-sorter img, #slide-sorter canvas');
            if (thumbs.length > 0) return true;
            var canvases = document.querySelectorAll('canvas');
            for (var c of canvases) {
                if (c.width > 200 && c.height > 200) {
                    try {
                        var ctx = c.getContext('2d');
                        if (ctx) {
                            var d = ctx.getImageData(c.width / 4, c.height / 4, 10, 10).data;
                            var nonWhite = 0;
                            for (var i = 0; i < d.length; i += 4) if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) nonWhite++;
                            if (nonWhite > 2) return true;
                        }
                    } catch (e) {}
                }
            }
            return false;
        }, { timeout: 120000 });
        await sleep(5000); // let tiles render
        log(`[${label}] Impress loaded`);
        return true;
    } catch (e) {
        log(`[${label}] Impress load timeout: ${e.message.slice(0, 80)}`);
        return false;
    }
}
async function impressUiIntact(page) {
    const fr = cvEditorFrame(page);
    if (!fr) return false;
    return fr.evaluate(() => {
        var el = document.querySelector('nav.main-nav') || document.querySelector('#content-keeper')
            || document.querySelector('#main-menu');
        return !!(el && el.textContent && el.textContent.includes('Slide Show'));
    }).catch(() => false);
}
async function dblClickCanvasAndType(page, text) {
    const box = await (await page.$('iframe')).boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.click(cx, cy);
    await sleep(500);
    await page.mouse.click(cx, cy, { clickCount: 2 });
    await sleep(3000);
    for (const ch of text) { await page.keyboard.type(ch, { delay: 50 }); await sleep(1000); }
    await sleep(3000);
}

(async () => {
    if (!fs.existsSync(DOC_PATH)) { log('ERROR: ' + DOC_PATH + ' not found'); process.exit(2); }
    log('=== CV PPTX 2-browser co-editing test ===');
    log('viewer: ' + BASE);
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    const { browser } = await launch({ headless: 'new' });
    let ctxB = null;
    try {
        const bytes = fs.readFileSync(DOC_PATH);
        const NAME = 'cv-pptx-coedit-' + Date.now() + '.pptx';

        const pair = await openCoEditPair(browser, BASE, NAME, bytes, {
            userA: 'PPTX Alice', userB: 'PPTX Bob', loadBudgetMs: LOAD_BUDGET,
        });
        ctxB = pair.contextB;
        const A = pair.A.page, B = pair.B.page;

        const frA = cvEditorFrame(A);
        const frB = cvEditorFrame(B);
        check('Browser A: Impress loaded', frA && await waitForImpress(frA, 'A', 180000));
        await snap(A, 'A_loaded');
        check('Browser B: Impress loaded', frB && await waitForImpress(frB, 'B', 180000));
        await snap(B, 'B_loaded');

        await sleep(10000);

        log('--- Browser A: typing AAA ---');
        await dblClickCanvasAndType(A, 'AAA');
        await snap(A, 'A_after_AAA'); await snap(B, 'B_after_AAA');

        log('--- Browser B: typing BBB ---');
        await dblClickCanvasAndType(B, 'BBB');
        await snap(A, 'A_after_BBB'); await snap(B, 'B_after_BBB');

        check('A: Impress UI intact', await impressUiIntact(A));
        check('B: Impress UI intact', await impressUiIntact(B));
        await snap(A, 'A_final'); await snap(B, 'B_final');
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        if (ctxB) { try { await ctxB.close(); } catch (e) {} }
        try { await browser.close(); } catch (e) {}
    }
    log('\n' + (allPassed ? 'ALL PASS' : 'SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
