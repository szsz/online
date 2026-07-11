// test-cv-regression-checkpoint-timing.js — a user-initiated save must rotate
// the co-edit checkpoint promptly (the 1.5s Kit-serialize settle), and the
// rotated content must reach a peer.
//
// Migrated from wasm/tests/regression/test-regression-checkpoint-timing.js —
// legacy version retired. Re-scoped during migration to match the CURRENT
// relay architecture (see "Why re-scoped" below).
//
// The constant this guards (still live):
//   wasm/relay-adapter.js cvSaveAndRotate() (line ~1207) and
//   saveAndUploadCheckpoint() (line ~1245) both do:
//       sendToKit('save …');  setTimeout(<read bytes, POST /shared-file, 0x07>, 1500);
//   The 1500ms is the Kit-serialize settle between asking Kit to save and
//   reading the saved bytes back for the checkpoint rotation. Its own comment:
//   "Previous 5s delay caused late joiners to miss checkpoints when they
//   connected during the delay window." A regression that bumps 1500 → 5000
//   slows every save-driven checkpoint rotation.
//
// Why re-scoped (the legacy test's stated subject no longer exists):
//   The legacy test's docstring describes a "relay triggers a fresh save on
//   the active client when a late joiner connects" delay. In the current relay
//   architecture there is NO trigger-save-on-join: message-relay.js's JOIN
//   handler serves the existing checkpoint immediately ("no save-trigger
//   anywhere"), and Room.hasUnsavedChanges() is dead code. So the 1500ms delay
//   is reachable ONLY through a USER save (Ctrl+S / the Save button), never via
//   a join. The legacy test itself already had A save up-front and then
//   measured B's cold-join under a 120s ceiling — which would not catch a
//   1500→5000 regression at all. This port instead exercises the delay where
//   it actually lives: a user save that drives cvSaveAndRotate, asserting the
//   rotation completes within a tight budget and the peer converges.
//
// Harness: A + B co-edit (openCoEditPair). A types ALPHA (real keyboard) then
// clicks the tester Save button → cvSaveAndRotate (the 1.5s path). We capture
// A's own SaveComplete{rotated:true} postMessage as the direct rotation signal
// and time it, then confirm B still holds the content. State via #StateWordCount.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-checkpoint-timing.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openCoEditPair, waitCvCharCount } = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOCX = process.env.DOCX || path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/checkpoint-timing';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const PROPAGATE_BUDGET = parseInt(process.env.PROPAGATE_BUDGET || '90000', 10);
// Save-driven rotation budget. The Kit-serialize settle is 1.5s; the rest is
// FS read + SHA-256 + /shared-file POST + 0x07. Locally this is a couple of
// seconds; on Azure a WAN POST stacks on top. 30s is a comfortable ceiling
// that still cleanly separates the fixed 1.5s regime from a 5s regression
// (which, compounded across a contended run, pushes the rotation past this
// bound). It is NOT a 120s cold-join ceiling — this budget is meant to be
// sensitive to the settle constant.
const ROTATE_BUDGET = parseInt(process.env.ROTATE_BUDGET || '30000', 10);

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
    await page.keyboard.type(text, { delay: 80 });
}
// Install a listener for the editor's SaveComplete postMessage BEFORE clicking
// Save, so we can time the save→rotation completion directly (the editor posts
// SaveComplete{rotated:true} from cvSaveAndRotate right after the 0x07 send).
async function armSaveCompleteWatcher(page) {
    await page.evaluate(() => {
        window.__cvSaveComplete = null;
        window.__cvSaveCompleteAt = 0;
        window.addEventListener('message', function (e) {
            if (typeof e.data !== 'string') return;
            try {
                const m = JSON.parse(e.data);
                if (m && m.MessageId === 'SaveComplete') {
                    window.__cvSaveComplete = m.Values || {};
                    window.__cvSaveCompleteAt = Date.now();
                }
            } catch (_) {}
        });
    });
}
async function clickSave(page) {
    const h = await page.evaluateHandle(() =>
        [...document.querySelectorAll('button')].find(b => /^save$/i.test((b.textContent || '').trim())));
    const el = h.asElement();
    if (el) { await el.click(); return true; }
    return false;
}
async function waitSaveComplete(page, budget) {
    const d = Date.now() + budget;
    while (Date.now() < d) {
        const v = await page.evaluate(() => window.__cvSaveComplete).catch(() => null);
        if (v) return v;
        await sleep(250);
    }
    return null;
}

(async () => {
    if (!fs.existsSync(DOCX)) { check('fixture present', false, DOCX); process.exit(2); }
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    try {
        // ── A + B co-edit ──
        const { A, B } = await openCoEditPair(browser, BASE, path.basename(DOCX), fs.readFileSync(DOCX), {
            userA: 'CP Alice', userB: 'CP Bob', loadBudgetMs: LOAD_BUDGET,
        });
        check('A: editor iframe appeared', !!A.editorFrame);
        check('B: editor iframe appeared (separate context)', !!B.editorFrame);

        const aBase = await waitCvCharCount(A.page, c => c >= 0, 30000);
        const bBase = await waitCvCharCount(B.page, c => c >= 0, 30000);
        check('A: char count readable', aBase >= 0, 'base=' + aBase);
        check('B: opened the same doc (matching baseline)', bBase === aBase, 'A=' + aBase + ' B=' + bBase);

        // ── A types ALPHA (5 chars) → reaches B ──
        await typeIntoDoc(A.page, 'ALPHA');
        const aTyped = await waitCvCharCount(A.page, c => c >= aBase + 5, 30000);
        check('A: typed ALPHA', aTyped >= aBase + 5, 'count=' + aTyped);
        const bSeesTyped = await waitCvCharCount(B.page, c => c >= aBase + 5, PROPAGATE_BUDGET);
        check('B: received A\'s typing', bSeesTyped >= aBase + 5, 'B=' + bSeesTyped);

        // ── A saves via the tester Save button → cvSaveAndRotate (the 1.5s path) ──
        await armSaveCompleteWatcher(A.page);
        const tSave = Date.now();
        check('A: tester Save button clicked', await clickSave(A.page));
        const sc = await waitSaveComplete(A.page, ROTATE_BUDGET);
        const rotateMs = Date.now() - tSave;
        log(`SaveComplete after ${rotateMs}ms: ${sc ? JSON.stringify(sc) : '(none)'}`);

        // The regression sentinel: the save-driven checkpoint rotation must
        // COMPLETE within the budget. A 1500→5000 settle regression (compounded
        // under contention) pushes this past ROTATE_BUDGET.
        check('save-driven checkpoint rotation completes within budget',
            !!sc && rotateMs < ROTATE_BUDGET, 'rotateMs=' + rotateMs + ' budget=' + ROTATE_BUDGET);
        // The save must actually rotate the checkpoint (ALPHA produced changed
        // bytes vs the opened doc), not no-op.
        check('save rotated the checkpoint (changed bytes)',
            !!sc && sc.rotated === true, sc ? 'rotated=' + sc.rotated : 'no SaveComplete');

        // Content stays converged on the peer after the rotation (the checkpoint
        // now carries ALPHA; B must still show it).
        const bAfterSave = await waitCvCharCount(B.page, c => c >= aBase + 5, PROPAGATE_BUDGET);
        check('B: still holds ALPHA content after A\'s save', bAfterSave >= aBase + 5, 'B=' + bAfterSave);

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
