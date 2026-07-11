// test-cv-regression-select-delete-coedit.js — selecting a word in one
// browser and pressing Delete must propagate the deletion to the other
// browser, through the Tresorit content viewer.
//
// User-reported bug: in browser A, select a word, then press Delete. Browser
// A removes the word; browser B still shows the word (the deletion never
// propagates).
//
//   - A + B open the same doc in a CV co-edit room (isolated contexts)
//   - The doc is a real .docx (matters: docx save path is heavier than .txt
//     and is where the user actually saw the divergence)
//   - A selects the first word via real keyboard events, presses Delete
//   - Both browsers deselect so #StateWordCount reports doc-char-count not
//     selection-char-count
//   - Both must converge to the same shorter doc
//
// Migrated from wasm/tests/regression/test-regression-select-delete-coedit.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-select-delete-coedit.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const {
    openCoEditPair, cvEditorFrame,
} = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOC_NAME = 'Simple small document.docx';
const DOC_PATH = path.join(__dirname, '..', '..', '..', 'test', 'data', DOC_NAME);
const SHOT_DIR = '/tmp/content-viewer-report/regression-select-delete';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const VP = { width: 1280, height: 900 };

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
    await sleep(300);
    try { await page.screenshot({ path: `${SHOT_DIR}/${String(++shotNum).padStart(2, '0')}_${name}.png` }); } catch (e) {}
}

// #StateWordCount is "N words, M characters" (no selection) or
// "Selected: N words, M characters" (selection active).
async function getStatus(page) {
    const fr = cvEditorFrame(page);
    if (!fr) return '';
    return fr.evaluate(() => document.querySelector('#StateWordCount')?.textContent?.trim() || '').catch(() => '');
}
function charCount(status) {
    const m = status && status.match(/([\d,]+)\s+characters/);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : -1;
}
function isSelectionStatus(status) { return /^Selected:/i.test((status || '').trim()); }

async function clickCanvas(page) {
    const el = await page.$('iframe');
    const box = el && await el.boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(300);
}
async function clearSelection(page) {
    // ArrowRight without modifier collapses any selection to the caret.
    await clickCanvas(page);
    await page.keyboard.press('ArrowRight');
    await sleep(800);
}

(async () => {
    if (!fs.existsSync(DOC_PATH)) { check('fixture present', false, DOC_PATH); process.exit(2); }
    log('=== CV regression: select-word + Delete co-edit (docx) ===');
    log('viewer: ' + BASE);
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    const { browser } = await launch({ headless: 'new' });
    let ctxB = null;
    try {
        const bytes = fs.readFileSync(DOC_PATH);
        const pair = await openCoEditPair(browser, BASE, DOC_NAME, bytes, {
            userA: 'Alice Del', userB: 'Bob Del', viewport: VP, loadBudgetMs: LOAD_BUDGET,
        });
        const pageA = pair.A.page; const pageB = pair.B.page; ctxB = pair.contextB;
        await sleep(15000); // B gets checkpoint + replays log

        // A and B may converge slightly after load (docx re-serialize lands on
        // the room after B started loading). Wait up to 30s.
        let initA = charCount(await getStatus(pageA));
        let initB = charCount(await getStatus(pageB));
        const convDeadline = Date.now() + 30000;
        while ((initA !== initB || initA <= 0) && Date.now() < convDeadline) {
            await sleep(500);
            initA = charCount(await getStatus(pageA));
            initB = charCount(await getStatus(pageB));
        }
        await snap(pageA, 'A_initial'); await snap(pageB, 'B_initial');
        log(`Initial: A=${initA} chars, B=${initB} chars`);
        check('A and B both load the same number of characters',
            initA > 0 && initA === initB, 'A=' + initA + ' B=' + initB);

        // ── A: select the first word via REAL keyboard events ──
        log('--- A: Ctrl+Home, Ctrl+Shift+Right (select first word), Delete ---');
        await pageA.bringToFront().catch(() => {});
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('Home'); await pageA.keyboard.up('Control');
        await sleep(1200);
        await pageA.keyboard.down('Control'); await pageA.keyboard.down('Shift');
        await pageA.keyboard.press('ArrowRight');
        await pageA.keyboard.up('Shift'); await pageA.keyboard.up('Control');
        await sleep(1500);
        await snap(pageA, 'A_after_select'); await snap(pageB, 'B_after_select');

        const sASel = await getStatus(pageA);
        log(`A after select: "${sASel}"`);
        const aSelectionSize = isSelectionStatus(sASel) ? charCount(sASel) : 0;
        check('A has a selection of the first word',
            isSelectionStatus(sASel) && aSelectionSize > 0, sASel);

        // Delete via real keyboard.
        await pageA.keyboard.press('Delete');
        log(`A: pressed Delete (selection was ${aSelectionSize} chars)`);

        // Wait for propagation, then deselect on both before reading doc count.
        log('Waiting 12s for the delete to propagate to B...');
        await sleep(12000);
        await snap(pageA, 'A_after_delete'); await snap(pageB, 'B_after_delete');
        await clearSelection(pageA); await clearSelection(pageB);
        await snap(pageA, 'A_after_deselect'); await snap(pageB, 'B_after_deselect');

        // Converge (A deleted; B receives the deletion via the relay).
        let sA = await getStatus(pageA), sB = await getStatus(pageB);
        let finalA = charCount(sA), finalB = charCount(sB);
        const convDeadline2 = Date.now() + 30000;
        while ((finalB !== finalA || isSelectionStatus(sA) || isSelectionStatus(sB))
               && Date.now() < convDeadline2) {
            await sleep(500);
            sA = await getStatus(pageA); sB = await getStatus(pageB);
            finalA = charCount(sA); finalB = charCount(sB);
        }
        log(`Final (after deselect): A="${sA}" → ${finalA} chars`);
        log(`                        B="${sB}" → ${finalB} chars`);

        check('A status no longer reports a selection', !isSelectionStatus(sA), sA);
        check('B status no longer reports a selection', !isSelectionStatus(sB), sB);
        check('A reflects the deletion locally (chars decreased)',
            finalA > 0 && finalA < initA, 'init=' + initA + ' final=' + finalA);
        check('B reflects A\'s select+delete (THE user-reported bug)',
            finalB === finalA,
            'A=' + finalA + ' B=' + finalB + (finalB === initB ? ' — peer never saw the deletion' : ''));
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        if (ctxB) { try { await ctxB.close(); } catch (e) {} }
        try { await browser.close(); } catch (e) {}
    }
    log('\n' + (allPassed ? 'ALL PASS' : 'SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
