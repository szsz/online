// test-cv-regression-stylesview-overlap.js — the notebookbar's #stylesview
// preformatted-style entries occupy distinct grid cells (no overlap).
//
// Pre-fix bug (browser/css/notebookbar.css): an explicit
// grid-template-rows: repeat(auto-fit, minmax(33px, 1fr)) pinned to the
// ~64px notebookbar element height fit only one explicit row — every entry
// past the first landed in the implicit grid and stamped into the same cell,
// so N entries' bounding rectangles overlapped. Fix: grid-auto-rows: 33px +
// grid-auto-flow: row.
//
// WHAT IS VERIFIED (same subject as the legacy test):
//   1. #stylesview renders >= 2 .ui-iconview-entry entries.
//   2. No two entry rectangles overlap (1 px tolerance for sub-pixel
//      rounding). With the bug all pairs collapse onto rect#0.
//
// Migrated from wasm/tests/regression/test-regression-stylesview-overlap.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-stylesview-overlap.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, waitCvInteractive } = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOCX = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const SHOT_DIR = '/tmp/content-viewer-report/regression-stylesview-overlap';

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
const editorFrame = page => page.frames().find(f => (f.url() || '').includes('cool.html'));
let shotN = 0;
async function snap(page, name) {
    try { fs.mkdirSync(SHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${SHOT_DIR}/${String(++shotN).padStart(2, '0')}_${name}.png` }); } catch (e) {}
}

(async () => {
    if (!fs.existsSync(DOCX)) { check('fixture present', false, DOCX); process.exit(2); }
    log('=== Regression: stylesview entries do not overlap (content viewer) ===');
    log('viewer: ' + BASE);
    // 1920x1080 so the notebookbar renders the styles group inline (same
    // viewport as the legacy test). Cold opens at this size can be slow —
    // generous budget.
    const { browser } = await launch({ headless: 'new', width: 1920, height: 1080 });
    try {
        const page = await browser.newPage();
        await openViaContentViewer(browser, BASE, DOCX, {
            page, viewport: { width: 1920, height: 1080 }, iframeTimeout: 60000,
        });
        check('editor interactive', await waitCvInteractive(page, LOAD_BUDGET));
        const frame = editorFrame(page);
        if (!frame) throw new Error('editor frame never appeared');
        await frame.waitForFunction(() => {
            const wc = document.querySelector('#StateWordCount');
            return !!(wc && /\d+\s+character/i.test(wc.textContent || ''));
        }, { timeout: 60000 });

        // Notebookbar takes another moment to render the iconview entries
        // after the doc is loaded — they're populated from the kit's
        // .uno:StyleApply state-change message.
        await sleep(5000);
        await snap(page, 'editor_loaded');

        const result = await frame.evaluate(() => {
            const root = document.getElementById('stylesview');
            if (!root) return { error: 'no #stylesview' };
            const entries = Array.from(root.querySelectorAll('.ui-iconview-entry'));
            if (!entries.length) return { error: 'no entries' };
            const rects = entries.map(el => {
                const r = el.getBoundingClientRect();
                return {
                    id: el.id,
                    x: Math.round(r.left), y: Math.round(r.top),
                    w: Math.round(r.width), h: Math.round(r.height),
                };
            });
            // Find every overlapping pair, 1px tolerance for sub-pixel rounding.
            const TOL = 1;
            function overlaps(a, b) {
                const aRight = a.x + a.w, aBottom = a.y + a.h;
                const bRight = b.x + b.w, bBottom = b.y + b.h;
                if (aRight - TOL <= b.x || bRight - TOL <= a.x) return false;
                if (aBottom - TOL <= b.y || bBottom - TOL <= a.y) return false;
                return true;
            }
            const overlapping = [];
            for (let i = 0; i < rects.length; i++) {
                for (let j = i + 1; j < rects.length; j++) {
                    if (overlaps(rects[i], rects[j])) overlapping.push([rects[i], rects[j]]);
                }
            }
            const cs = window.getComputedStyle(root);
            return {
                rects, overlapping,
                gridTemplateRows: cs.gridTemplateRows,
                gridAutoRows: cs.gridAutoRows,
                gridTemplateColumns: cs.gridTemplateColumns,
            };
        }).catch(e => ({ error: 'eval failed: ' + e.message }));

        if (result.error) {
            check('stylesview readable', false, result.error);
            throw new Error('cannot probe stylesview: ' + result.error);
        }
        log(`grid-template-rows = ${result.gridTemplateRows}`);
        log(`grid-auto-rows     = ${result.gridAutoRows}`);
        log(`entries: ${result.rects.length}`);
        for (const r of result.rects.slice(0, 6)) {
            log(`  ${r.id}: ${r.x},${r.y} ${r.w}x${r.h}`);
        }
        check('stylesview has multiple entries', result.rects.length >= 2,
            'count=' + result.rects.length);
        check('no entry rectangles overlap', result.overlapping.length === 0,
            result.overlapping.length
                ? 'first overlap: ' + result.overlapping[0][0].id + ' vs ' + result.overlapping[0][1].id
                : '0 overlapping pairs');

        await snap(page, 'stylesview_layout');
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
