// test-cv-regression-checkpoint-cursor-delete.js — checkpoint rotation +
// cursor state + late-join delete convergence, through the content viewer.
//
// Migrated from wasm/tests/regression/test-regression-checkpoint-cursor-delete.js
// — legacy version retired.
//
// Legacy subject / scenario:
//   1. A opens the doc and inserts a word (" ALPHA").
//   2. B joins (late joiner, replays A's insert).
//   3. B selects text (its selection becomes B's live cursor state at the relay).
//   4. A saves (Ctrl+S) → 0x07 rotates the checkpoint; B's cursor snapshot is
//      baked into checkpointCursors.
//   5. C joins after the rotation.
//   6. B presses Delete → the content is removed on ALL THREE (convergence).
//
// What is asserted:
//   • A/B/C converge on the same char count after the delete, and
//   • the delete actually removed content (count dropped from post-ALPHA).
//   The "C sees B's remote-selection highlight from the checkpoint" probe is
//   INFORMATIONAL only — in the legacy test it is a KNOWN LIMITATION
//   (cursor/selection broadcasts don't ride the relay, so the checkpoint's
//   cursor snapshot is effectively empty and late joiners can't see peer
//   selections from it). We log the probe but do NOT gate on it, exactly as
//   the legacy test did.
//
// CV port: A creates via the tester Co-edit checkbox; B and C each join by the
// per-room join link in their own ISOLATED browser contexts (own SW +
// storage). A's save is the tester Save button, which in a CV co-edit room
// rotates the relay checkpoint (the 0x07 the scenario needs). Same subject,
// only the harness (tester upload/Save/join-link) differs. All input via real
// keyboard/mouse; state read via #StateWordCount only.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-checkpoint-cursor-delete.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const {
    openViaContentViewer, joinViaContentViewer,
    waitCvInteractive, cvEditorFrame, cvCharCount, waitCvCharCount,
} = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOCX = process.env.DOCX || path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/checkpoint-cursor-delete';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const PROPAGATE_BUDGET = parseInt(process.env.PROPAGATE_BUDGET || '120000', 10);

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
let snapN = 0;
async function snap(page, name) {
    try { fs.mkdirSync(SHOT_DIR, { recursive: true });
        await page.screenshot({ path: SHOT_DIR + '/' + String(++snapN).padStart(2, '0') + '_' + name + '.png' }); } catch (e) {}
}
async function focusDoc(page) {
    const el = await page.$('iframe');
    const box = await el.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
    await sleep(500);
}
async function typeIntoDoc(page, text) { await focusDoc(page); await page.keyboard.type(text, { delay: 80 }); }
async function ctrl(page, key) { await page.keyboard.down('Control'); await page.keyboard.press(key); await page.keyboard.up('Control'); await sleep(300); }
async function clickSave(page) {
    const h = await page.evaluateHandle(() =>
        [...document.querySelectorAll('button')].find(b => /^save$/i.test((b.textContent || '').trim())));
    const el = h.asElement();
    if (el) { await el.click(); return true; }
    return false;
}
// Remote-selection probe (informational only — see header).
async function checkHasPeerSelection(page) {
    try {
        const fr = cvEditorFrame(page);
        if (!fr) return { hasMarker: false, reason: 'no-frame' };
        return fr.evaluate(() => {
            const markers = document.querySelectorAll('.leaflet-selection-marker, .leaflet-cursor-handler, path[fill*="rgba"]');
            let count = 0;
            for (const m of markers) { const r = m.getBoundingClientRect ? m.getBoundingClientRect() : null; if (r && r.width > 1 && r.height > 1) count++; }
            const overlays = document.querySelectorAll('.lool-annotation, .user-cursor-overlay');
            const hasRemote = document.documentElement.innerHTML.match(/data-remote|data-userId|remote-cursor/i);
            return { hasMarker: count > 0 || overlays.length > 0 || !!hasRemote, markerCount: count, overlayCount: overlays.length };
        });
    } catch (e) { return { hasMarker: false, reason: 'eval-error ' + e.message }; }
}

(async () => {
    if (!fs.existsSync(DOCX)) { check('fixture present', false, DOCX); process.exit(2); }
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    try {
        // ═══ Step 1: A opens (co-edit create) ═══
        log('--- Step 1: A opens ---');
        const A = await openViaContentViewer(browser, BASE, DOCX, {
            userName: 'Cur Alice', coEdit: true, iframeTimeout: 60000,
        });
        check('A: editor iframe + join link', !!A.editorFrame && !!A.joinLink, A.joinLink || '(none)');
        check('A: editor interactive', await waitCvInteractive(A.page, LOAD_BUDGET));
        await sleep(3000);
        const aBase = await waitCvCharCount(A.page, c => c >= 0, 30000);
        check('A: char count readable', aBase >= 0, 'base=' + aBase);
        await snap(A.page, 'A_initial');

        // ═══ Step 2: A inserts " ALPHA" (6 chars) ═══
        log('--- Step 2: A inserts " ALPHA" ---');
        await ctrl(A.page, 'End');
        await typeIntoDoc(A.page, ' ALPHA');
        const aAfterAlpha = await waitCvCharCount(A.page, c => c >= aBase + 6, 30000);
        check('A typed ALPHA (+6)', aAfterAlpha >= aBase + 6, 'got=' + aAfterAlpha);
        await snap(A.page, 'A_after_ALPHA');

        // ═══ Step 3: B joins (late joiner, replays A's insert) ═══
        log('--- Step 3: B joins ---');
        const ctxB = await browser.createBrowserContext();
        const B = await joinViaContentViewer(browser, A.joinLink, {
            page: await ctxB.newPage(), userName: 'Cur Bob', iframeTimeout: 90000,
        });
        check('B: editor iframe appeared', !!B.editorFrame);
        check('B: editor interactive', await waitCvInteractive(B.page, LOAD_BUDGET));
        const bAfterJoin = await waitCvCharCount(B.page, c => c >= aBase + 6, PROPAGATE_BUDGET);
        check('B sees ALPHA after replay', bAfterJoin >= aBase + 6, 'got=' + bAfterJoin);
        await snap(B.page, 'B_initial');

        // ═══ Step 4: B selects-all (non-empty selection → live cursor state) ═══
        log('--- Step 4: B select-all ---');
        await focusDoc(B.page);
        await ctrl(B.page, 'a');
        await sleep(3000);
        await snap(B.page, 'B_after_select');

        // ═══ Step 5: A saves (tester Save → checkpoint rotation) ═══
        log('--- Step 5: A saves (checkpoint rotate) ---');
        check('A: tester Save button clicked', await clickSave(A.page));
        await sleep(8000);
        await snap(A.page, 'A_after_save');

        // ═══ Step 6: C joins after the checkpoint rotation ═══
        log('--- Step 6: C joins post-save ---');
        const ctxC = await browser.createBrowserContext();
        const C = await joinViaContentViewer(browser, A.joinLink, {
            page: await ctxC.newPage(), userName: 'Cur Carol', iframeTimeout: 90000,
        });
        check('C: editor iframe appeared', !!C.editorFrame);
        check('C: editor interactive', await waitCvInteractive(C.page, LOAD_BUDGET));
        const cAfterJoin = await waitCvCharCount(C.page, c => c >= aBase + 6, PROPAGATE_BUDGET);
        check('C sees ALPHA after join', cAfterJoin >= aBase + 6, 'got=' + cAfterJoin);
        await sleep(3000);
        await snap(C.page, 'C_initial');

        // Informational probe — peer-cursor-in-checkpoint is a KNOWN LIMITATION.
        const cSelProbe = await checkHasPeerSelection(C.page);
        log('C peer-selection probe (informational, not gated): ' + JSON.stringify(cSelProbe));

        // ═══ Step 7: B select-all + Delete → all three converge ═══
        log('--- Step 7: B presses Delete ---');
        await focusDoc(B.page);
        await ctrl(B.page, 'a');
        await sleep(500);
        await B.page.keyboard.press('Delete');
        await sleep(6000);
        await snap(A.page, 'A_after_delete');
        await snap(B.page, 'B_after_delete');
        await snap(C.page, 'C_after_delete');

        // Give the delete time to propagate to all peers, then read.
        const dl = Date.now() + PROPAGATE_BUDGET;
        let aEnd, bEnd, cEnd;
        while (Date.now() < dl) {
            aEnd = await cvCharCount(A.page); bEnd = await cvCharCount(B.page); cEnd = await cvCharCount(C.page);
            if (aEnd >= 0 && bEnd >= 0 && cEnd >= 0 && aEnd === bEnd && bEnd === cEnd && aEnd < aAfterAlpha) break;
            await sleep(500);
        }
        log('Final: A=' + aEnd + ' B=' + bEnd + ' C=' + cEnd);

        const converged = aEnd >= 0 && bEnd >= 0 && cEnd >= 0 && aEnd === bEnd && bEnd === cEnd;
        check('A/B/C converge after delete', converged, 'A=' + aEnd + ' B=' + bEnd + ' C=' + cEnd);
        check('Delete removed content (A count dropped)', aEnd < aAfterAlpha,
            'before=' + aAfterAlpha + ' after=' + aEnd);
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
