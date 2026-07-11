// test-cv-regression-latejoin-unsaved.js — late joiner with UNSAVED edits
// (no tester Save from the first browser) must converge, through the Tresorit
// content viewer.
//
// Bug scenario:
//   1. Browser A opens a co-edit room, types content — does NOT save
//   2. Browser B opens the same room
//   3. B should see A's content via message replay, but the pre-fix path
//      let B's activation overwrite the room with the prewarm blank doc.
//
// Test cases (subject-identical to the legacy viewer test):
//   Case 1: A types, A STAYS OPEN, B joins  (tests live co-edit catch-up)
//   Case 2: A + B close, C joins fresh       (tests replay from the relay log /
//            rotated checkpoint)
//
// ALL input via real keyboard/mouse. "Save" here = the tester Save button,
// which is deliberately NOT clicked (the edits stay unsaved in the relay).
//
// NOTE: the legacy test also probed the viewer's /api/v2/file/<id> ciphertext
// size to prove storage wasn't overwritten blank. That endpoint is
// legacy-viewer storage machinery with no content-viewer analog; the same
// property is covered here by asserting B and C never go blank + converge to
// A's char count (the user-visible guarantee).
//
// Migrated from wasm/tests/regression/test-regression-latejoin-unsaved.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-latejoin-unsaved.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const {
    openBytesViaContentViewer, joinViaContentViewer,
    waitCvInteractive, cvCharCount, waitCvCharCount,
} = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/regression-latejoin-unsaved';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const PROPAGATE_BUDGET = parseInt(process.env.PROPAGATE_BUDGET || '120000', 10);
const VP = { width: 1280, height: 900 };

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
async function typeAtEnd(page, text) {
    await page.bringToFront().catch(() => {});
    const el = await page.$('iframe');
    const box = el && await el.boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
    await sleep(500);
    await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
    await sleep(300);
    await page.keyboard.type(text, { delay: 60 });
    await sleep(1500);
}

(async () => {
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
    log('viewer: ' + BASE);
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    const bytes = fs.readFileSync(FIXTURE);
    const NAME = 'cv-ljunsaved-' + Date.now() + '.docx';
    const { browser } = await launch({ headless: 'new' });
    let ctxB = null, ctxC = null;
    try {
        // ═══ CASE 1: A types (no save), B joins while A is still open ═══
        log('=== CASE 1: A types (no save), B joins while A is open ===');
        const A = await openBytesViaContentViewer(browser, BASE, NAME, bytes, {
            userName: 'Alice Unsaved', coEdit: true, viewport: VP, iframeTimeout: 60000,
        });
        check('A: editor iframe + join link', !!A.editorFrame && !!A.joinLink, A.joinLink || '(none)');
        check('A: editor interactive', await waitCvInteractive(A.page, LOAD_BUDGET));
        await sleep(5000);
        const ccA0 = await waitCvCharCount(A.page, c => c >= 0, 60000);
        log('  A initial: ' + ccA0 + ' chars');

        // A types — NO tester Save (edits live only in the relay message log).
        await typeAtEnd(A.page, 'UNSAVED_EDITS ');
        const ccA1 = await waitCvCharCount(A.page, c => c >= ccA0 + 14, 30000);
        check('CASE1: A typed 14 chars', ccA1 - ccA0 === 14, 'delta=' + (ccA1 - ccA0));
        await snap(A.page, 'case1_A_after_type');
        log('  [A] NOT saving — B will join with unsaved edits in relay');

        // B joins the shared link in an isolated context.
        ctxB = await browser.createBrowserContext();
        const pageB = await ctxB.newPage();
        const B = await joinViaContentViewer(browser, A.joinLink, {
            page: pageB, userName: 'Bob Unsaved', viewport: VP, iframeTimeout: 90000,
        });
        check('B: editor iframe appeared', !!B.editorFrame);
        check('B: editor interactive', await waitCvInteractive(B.page, LOAD_BUDGET));
        await sleep(6000);
        const ccB0 = await waitCvCharCount(B.page, c => Math.abs(c - ccA1) <= 5, PROPAGATE_BUDGET);
        await snap(B.page, 'case1_B_after_join');
        log('  B after join: ' + ccB0 + ' chars (A had ' + ccA1 + ')');
        check('CASE1: B sees A content (within ±5)', Math.abs(ccB0 - ccA1) <= 5,
            'B=' + ccB0 + ' A=' + ccA1 + ' diff=' + Math.abs(ccB0 - ccA1));
        check('CASE1: B is NOT blank', ccB0 > 20, 'B=' + ccB0);

        // Verify A's content hasn't been corrupted by B joining.
        await sleep(3000);
        const ccA2 = await cvCharCount(A.page);
        check('CASE1: A still has content after B joined', ccA2 >= ccA1,
            'A_now=' + ccA2 + ' A_before=' + ccA1);
        await snap(A.page, 'case1_A_final');
        await snap(B.page, 'case1_B_final');

        // Close A and B — nobody is live; the relay must retain the edits.
        try { await A.page.close(); } catch (e) {}
        try { await ctxB.close(); } catch (e) {} ctxB = null;
        await sleep(3000);

        // ═══ CASE 2: All browsers closed, C opens fresh ═══
        log('=== CASE 2: All browsers closed, C opens ===');
        ctxC = await browser.createBrowserContext();
        const pageC = await ctxC.newPage();
        const C = await joinViaContentViewer(browser, A.joinLink, {
            page: pageC, userName: 'Cara Unsaved', viewport: VP, iframeTimeout: 90000,
        });
        check('C: editor iframe appeared', !!C.editorFrame);
        check('C: editor interactive', await waitCvInteractive(C.page, LOAD_BUDGET));
        const ccC0 = await waitCvCharCount(C.page, c => Math.abs(c - ccA1) <= 5, PROPAGATE_BUDGET);
        await snap(C.page, 'case2_C_after_open');
        log('  C after open: ' + ccC0 + ' chars (A had ' + ccA1 + ')');
        check('CASE2: C sees A content (within ±5)', Math.abs(ccC0 - ccA1) <= 5,
            'C=' + ccC0 + ' A=' + ccA1 + ' diff=' + Math.abs(ccC0 - ccA1));
        check('CASE2: C is NOT blank', ccC0 > 20, 'C=' + ccC0);
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        for (const c of [ctxB, ctxC]) { if (c) { try { await c.close(); } catch (e) {} } }
        try { await browser.close(); } catch (e) {}
    }
    log('\n' + (allPassed ? 'ALL PASS' : 'SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
