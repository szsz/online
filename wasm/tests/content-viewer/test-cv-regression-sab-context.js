// test-cv-regression-sab-context.js — two ISOLATED browser contexts co-edit
// one document through the content viewer and converge (SharedArrayBuffer /
// per-context isolation).
//
// Migrated from wasm/tests/regression/test-regression-sab-context.js —
// legacy version retired.
//
// Legacy subject: co-edit requires each simulated user to run in its own
// browser context. Two pages sharing ONE browser context share localStorage;
// the (legacy) viewer derived the same client identity from it, so the relay
// deduped A and B as one client and co-edit appeared one-directional. The fix
// was test-infra: every co-edit test opens each user in a fresh
// browser.createBrowserContext(). The legacy test proved it with a contrast —
// separate contexts converge (the assertion that matters), shared context
// does not (a demonstration of the bug).
//
// In the content viewer the isolation is structural: openCoEditPair() joins B
// in a fresh browser.createBrowserContext() (its own SW + storage), and the
// join is by a per-room join link, not by a localStorage-derived identity.
// So the SUBJECT assertion — two isolated contexts co-edit and CONVERGE
// bidirectionally — ports directly and is verified below.
//
// The legacy BAD/contrast half (shared-context dedup) is NOT ported: the CV
// helpers never share a context between co-edit peers, and the identity is not
// localStorage-derived, so the shared-context dedup bug is not reachable
// through the content-viewer flow — it was a legacy-viewer identity-derivation
// artefact. Its absence in CV is by construction, not something a test can
// demonstrate here.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-sab-context.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openCoEditPair, waitCvCharCount } = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOCX = process.env.DOCX || path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/sab-context';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const PROPAGATE_BUDGET = parseInt(process.env.PROPAGATE_BUDGET || '90000', 10);

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
async function typeIntoDoc(page, text) {
    const el = await page.$('iframe');
    const box = await el.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
    await sleep(800);
    await page.keyboard.type(text, { delay: 60 });
}

(async () => {
    if (!fs.existsSync(DOCX)) { check('fixture present', false, DOCX); process.exit(2); }
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    try {
        // A creates the co-edit session; B joins in an ISOLATED context.
        const { A, B } = await openCoEditPair(browser, BASE, path.basename(DOCX), fs.readFileSync(DOCX), {
            userA: 'Iso Alice', userB: 'Iso Bob', loadBudgetMs: LOAD_BUDGET,
        });
        check('A: editor iframe appeared', !!A.editorFrame);
        check('B: editor iframe appeared (separate context)', !!B.editorFrame);

        const aBase = await waitCvCharCount(A.page, c => c >= 0, 30000);
        const bBase = await waitCvCharCount(B.page, c => c >= 0, 30000);
        check('A: char count readable', aBase >= 0, 'A=' + aBase);
        check('B: opened the same doc (matching baseline)', bBase === aBase, 'A=' + aBase + ' B=' + bBase);

        // A → B propagation (the isolation-converges assertion, direction 1).
        await typeIntoDoc(A.page, 'XYZ');   // +3
        const aAfter = await waitCvCharCount(A.page, c => c >= aBase + 3, 30000);
        check('A: own typing landed (relay echoes back — proves not deduped)',
            aAfter >= aBase + 3, 'A=' + aAfter);
        const bSeesA = await waitCvCharCount(B.page, c => c >= aBase + 3, PROPAGATE_BUDGET);
        check('Separate contexts: B converges to A (A→B)', bSeesA >= aBase + 3,
            'B=' + bSeesA + ' expected>=' + (aBase + 3));

        // B → A propagation (direction 2 — full bidirectional convergence).
        await typeIntoDoc(B.page, 'QQ');    // +2
        const bAfter = await waitCvCharCount(B.page, c => c >= aBase + 5, 30000);
        check('B: own typing landed', bAfter >= aBase + 5, 'B=' + bAfter);
        const aSeesB = await waitCvCharCount(A.page, c => c >= aBase + 5, PROPAGATE_BUDGET);
        check('Separate contexts: A converges to B (B→A)', aSeesB >= aBase + 5,
            'A=' + aSeesB + ' expected>=' + (aBase + 5));

        try {
            fs.mkdirSync(SHOT_DIR, { recursive: true });
            await A.page.screenshot({ path: SHOT_DIR + '/a-final.png' });
            await B.page.screenshot({ path: SHOT_DIR + '/b-final.png' });
        } catch (e) {}
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
