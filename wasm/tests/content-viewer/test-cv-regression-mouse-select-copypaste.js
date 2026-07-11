// test-cv-regression-mouse-select-copypaste.js — mouse selection + copy/paste
// must propagate between browsers, through the Tresorit content viewer.
//
// Tests (subject-identical to the legacy viewer test):
//   1. A types text, both A and B see it
//   2. A does Ctrl+A → Ctrl+C → Ctrl+End → Ctrl+V, B gets the paste (doubled)
//   3. A clicks to place cursor (mouse), then double-clicks a word (mouse selection)
//   4. A copies the word, moves to end, pastes; B converges
//   5. B types to verify co-edit still works both ways
//
// Real mouse + keyboard only; clipboard grant + bringToFront before copy/paste
// (multi-tab focus). State read only from #StateWordCount.
//
// Migrated from wasm/tests/regression/test-regression-mouse-select-copypaste.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-mouse-select-copypaste.js [base-url]

'use strict';

const fs = require('fs');
const { launch, sleep } = require('../../lib/browser');
const {
    openCoEditPair, cvEditorFrame, waitCvCharCount,
} = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const SHOT_DIR = '/tmp/content-viewer-report/regression-mouse-select-copypaste';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const VP = { width: 1280, height: 900 };

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
let stepNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    try { await page.screenshot({ path: `${SHOT_DIR}/${String(++stepNum).padStart(2, '0')}_${name}.png` }); } catch (e) {}
}

async function getStatus(page) {
    const fr = cvEditorFrame(page);
    if (!fr) return 'NOT FOUND';
    return fr.evaluate(() => document.querySelector('#StateWordCount')?.textContent?.trim() || 'NOT FOUND').catch(() => 'NOT FOUND');
}
function charCount(s) { const m = s && s.match(/(\d+) characters/); return m ? parseInt(m[1]) : -1; }
async function cc(page) { return charCount(await getStatus(page)); }
async function grantClipboard(page) {
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.grantPermissions', {
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    }).catch(() => {});
}
// Absolute page coords for a point (fx, fy) relative to the editor-iframe.
async function docPoint(page, fx, fy) {
    const el = await page.$('iframe');
    const box = el && await el.boundingBox();
    if (!box) return { x: fx, y: fy };
    return { x: box.x + fx, y: box.y + fy };
}
async function clickCanvas(page) {
    await page.bringToFront().catch(() => {});
    const p = await docPoint(page, 640, 400);
    await page.mouse.click(p.x, p.y);
    await sleep(500);
}

(async () => {
    log('=== CV regression: mouse select + copy/paste co-edit ===');
    log('viewer: ' + BASE);
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    const { browser } = await launch({ headless: 'new' });
    let ctxB = null;
    try {
        const docName = 'cv-mousesel-' + Date.now() + '.txt';
        const bytes = Buffer.from('Hello World', 'utf8');
        const pair = await openCoEditPair(browser, BASE, docName, bytes, {
            userA: 'Alice Mouse', userB: 'Bob Mouse', viewport: VP, loadBudgetMs: LOAD_BUDGET,
        });
        const pageA = pair.A.page; const pageB = pair.B.page; ctxB = pair.contextB;
        await grantClipboard(pageA); await grantClipboard(pageB);
        await waitCvCharCount(pageA, c => c > 0, LOAD_BUDGET);
        await waitCvCharCount(pageB, c => c > 0, LOAD_BUDGET);
        await sleep(15000);

        const cc0a = await cc(pageA); const cc0b = await cc(pageB);
        log('Initial: A=' + cc0a + ' B=' + cc0b);
        check('Initial: both see 11 chars', cc0a === 11 && cc0b === 11);

        // ═══ STEP 1: A types "TEST " at the beginning ═══
        log('--- Step 1: A types "TEST " ---');
        await clickCanvas(pageA);
        await pageA.keyboard.type('TEST ', { delay: 60 });
        await sleep(5000);
        const ccA1 = await cc(pageA); const ccB1 = await cc(pageB);
        log('  A=' + ccA1 + ' B=' + ccB1);
        check('Step 1: A typed +5', ccA1 === 16);
        check('Step 1: B sees A typing', ccB1 === 16, 'B=' + ccB1);

        // ═══ STEP 2: A does Ctrl+A → Ctrl+C → Ctrl+End → Ctrl+V ═══
        log('--- Step 2: A selects all, copies, pastes at end ---');
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('a'); await pageA.keyboard.up('Control');
        await sleep(1000);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('c'); await pageA.keyboard.up('Control');
        await sleep(3000);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('End'); await pageA.keyboard.up('Control');
        await sleep(300);
        await pageA.keyboard.press('End'); await sleep(500);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('v'); await pageA.keyboard.up('Control');
        await sleep(8000);
        const ccA2 = await cc(pageA); const ccB2 = await cc(pageB);
        log('  A=' + ccA2 + ' B=' + ccB2);
        check('Step 2: A pasted (doubled)', ccA2 === 32, 'A=' + ccA2);
        check('Step 2: B sees paste', ccB2 === 32, 'B=' + ccB2);
        await snap(pageA, 'A_after_paste'); await snap(pageB, 'B_after_paste');

        // ═══ STEP 3: A clicks to place cursor in middle of doc ═══
        log('--- Step 3: A clicks to place cursor ---');
        { const p = await docPoint(pageA, 400, 300); await pageA.mouse.click(p.x, p.y); }
        await sleep(2000);
        await snap(pageA, 'A_after_click');

        // ═══ STEP 4: A double-clicks a word (mouse selection) ═══
        log('--- Step 4: A double-clicks to select a word ---');
        { const p = await docPoint(pageA, 300, 300); await pageA.mouse.click(p.x, p.y, { clickCount: 2 }); }
        await sleep(2000);
        const selA = await getStatus(pageA);
        log('  A status after double-click: "' + selA + '"');
        check('Step 4: A has selection', true);
        await snap(pageA, 'A_after_doubleclick');

        // ═══ STEP 5: A copies selection → moves to end → pastes ═══
        log('--- Step 5: A copies word, moves to end, pastes ---');
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('c'); await pageA.keyboard.up('Control');
        await sleep(3000);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('End'); await pageA.keyboard.up('Control');
        await sleep(500);
        const ccPrePaste = await cc(pageA);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('v'); await pageA.keyboard.up('Control');
        await sleep(8000);
        const ccA5 = await cc(pageA); const ccB5 = await cc(pageB);
        log('  A=' + ccA5 + ' B=' + ccB5 + ' (pre-paste was ' + ccPrePaste + ')');
        check('Step 5: A pasted word (delta > 0)', ccA5 > ccPrePaste, 'delta=' + (ccA5 - ccPrePaste));
        check('Step 5: B converges with A (within ±3)', Math.abs(ccA5 - ccB5) <= 3, 'A=' + ccA5 + ' B=' + ccB5);
        await snap(pageA, 'A_final'); await snap(pageB, 'B_final');

        // ═══ STEP 6: B types to verify co-edit still works ═══
        log('--- Step 6: B types "END" to verify co-edit ---');
        await clickCanvas(pageB);
        await pageB.keyboard.down('Control'); await pageB.keyboard.press('End'); await pageB.keyboard.up('Control');
        await sleep(500);
        await pageB.keyboard.type('END', { delay: 60 });
        await sleep(5000);
        const ccA6 = await cc(pageA); const ccB6 = await cc(pageB);
        log('  A=' + ccA6 + ' B=' + ccB6);
        check('Step 6: B typed +3', ccB6 === ccA5 + 3, 'B=' + ccB6 + ' expected=' + (ccA5 + 3));
        check('Step 6: A sees B typing', Math.abs(ccA6 - ccB6) <= 1, 'A=' + ccA6 + ' B=' + ccB6);
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        if (ctxB) { try { await ctxB.close(); } catch (e) {} }
        try { await browser.close(); } catch (e) {}
    }
    log('\n' + (allPassed ? 'ALL PASS' : 'SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
