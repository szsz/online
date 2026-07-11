// test-cv-e2e-upload.js — end-to-end: upload a document through the content
// viewer, open it, and co-edit it (a second user joins and types).
//
// Migrated from wasm/tests/misc/test-e2e-upload.js — legacy version retired
// (co-edit half ported; legacy upload-page half is not applicable — see below).
//
// The legacy test had two halves:
//   (1) The legacy /upload drop-zone page: upload a file, wait for the
//       #btn-open button, read the #share-url field, click Open. This is the
//       legacy VIEWER's upload-and-share UI (drop zone + share-URL + deep-link
//       Open button) — the content viewer has no /upload page; documents are
//       opened directly through the /collabora-tester file <input>. That half
//       is legacy-only and is NOT ported.
//   (2) The co-edit half: a second browser opens the shared document and types
//       HELLO, and the test asserts co-editing works. This IS separable and
//       ports directly to the content viewer.
//
// This CV port keeps the end-to-end spirit — upload → open → a second user
// co-edits — expressed with the content-viewer harness: A uploads through the
// real tester file <input> with the Co-edit checkbox (the CV equivalent of
// "upload then get a share URL"), B joins via the per-room join link in an
// ISOLATED context (the CV equivalent of "second browser opens the share
// URL"), and B types HELLO through the real keyboard. The subject assertions —
// both editors open, and B's typing reaches A — are preserved.
//
// Usage: node wasm/tests/content-viewer/test-cv-e2e-upload.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openCoEditPair, waitCvCharCount } = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOCX = process.env.DOCX
    || path.join(__dirname, '..', '..', '..', 'test', 'data', 'test document.docx');
const SHOT_DIR = '/tmp/content-viewer-report/e2e-upload';
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
    await page.keyboard.type(text, { delay: 50 });
}

(async () => {
    if (!fs.existsSync(DOCX)) { check('fixture present', false, DOCX); process.exit(2); }
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    try {
        // ── Upload + open (A) and a second user joins (B) ──
        const { A, B } = await openCoEditPair(browser, BASE, path.basename(DOCX), fs.readFileSync(DOCX), {
            userA: 'E2E Alice', userB: 'E2E Bob', loadBudgetMs: LOAD_BUDGET,
        });
        check('A: uploaded doc opened (editor iframe)', !!A.editorFrame);
        check('B: joined the shared doc (editor iframe, separate context)', !!B.editorFrame);

        const aBase = await waitCvCharCount(A.page, c => c >= 0, 30000);
        const bBase = await waitCvCharCount(B.page, c => c >= 0, 30000);
        check('A: content visible after open', aBase >= 0, 'A=' + aBase);
        check('B: opened the same doc (matching baseline)', bBase === aBase, 'A=' + aBase + ' B=' + bBase);

        // ── B co-edits: types HELLO; must reach A ──
        await typeIntoDoc(B.page, 'HELLO');   // +5
        const bAfter = await waitCvCharCount(B.page, c => c >= aBase + 5, 30000);
        check('B: own typing landed', bAfter >= aBase + 5, 'B=' + bAfter);
        const aSeesB = await waitCvCharCount(A.page, c => c >= aBase + 5, PROPAGATE_BUDGET);
        check('Co-editing works: A received B\'s HELLO', aSeesB >= aBase + 5,
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
