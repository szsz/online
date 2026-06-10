const __cl = require('../../lib/inject-checklist');
// Regression: Late joiner with UNSAVED edits (no Ctrl+S from first browser).
//
// Bug scenario:
//   1. Browser A opens a document, types content — does NOT save
//   2. Browser A closes (or stays open)
//   3. Browser B opens the same document
//   4. B should see A's content via message replay, but instead
//      may overwrite with blank content because B's activation
//      triggers saveAndUploadCheckpoint() with the prewarm blank doc.
//
// Test cases:
//   Case 1: A types, A STAYS OPEN, B joins (tests live co-edit catch-up)
//   Case 2: A types, A CLOSES, B joins (tests message replay from relay log)
//   Case 3: A types, A types MORE after B joins, both should converge

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs'), path = require('path');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');
const { openSecretInBrowser } = require('../../lib/open-via-viewer');
const { waitInFrame, evalInFrame, getCharCount } = require('../../lib/two-tab');
const VIEWER = env.FILE_STORAGE_URL;
const SHOTS = '/tmp/static-deploy/public/shots-regression-latejoin-unsaved';

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) console.log(`  ✓ ${label}`);
    else { console.log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
function charCount(s) { const m = s && s.match(/(\d+) characters/); return m ? parseInt(m[1]) : -1; }

(async () => {
    fs.rmSync(SHOTS, { recursive: true, force: true });
    fs.mkdirSync(SHOTS, { recursive: true });

    let stepNum = 0;
    async function snap(page, name) {
        stepNum++;
        const f = `${String(stepNum).padStart(2, '0')}_${name}.png`;
        await page.screenshot({ path: `${SHOTS}/${f}` });
    }

    // Upload fresh doc via v2 (encrypted)
    const docName = 'ljunsaved-' + Date.now() + '.docx';
    const bytes = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx'));
    const { b64urlSecret, fileId } = await uploadV2(VIEWER, docName, bytes);
    console.log('[setup] Uploaded v2 ' + docName + ' → ' + fileId.substring(0,8) + '…');

    // ═══ CASE 1: A types (no save), B joins while A is still open ═══
    console.log('\n=== CASE 1: A types (no save), B joins while A is open ===');

    const { browser: browserA, cleanup: cleanupA } = await launch();
    // openSecretInBrowser filters out the prewarm-blank bootstrap iframe and
    // resolves to the FILE-loading iframe. two-tab helpers (waitInFrame,
    // evalInFrame, getCharCount) re-resolve the active iframe on every
    // poll so a mid-test viewer-side replaceChild doesn't detach our refs.
    const upA = await openSecretInBrowser(browserA, VIEWER, b64urlSecret,
        { iframeTimeout: env.scaleTimeout(60000),
          gotoTimeout: env.scaleTimeout(60000),
          viewport: { width: 1280, height: 900 } });
    const pageA = upA.page;
    await waitInFrame(pageA,
        () => /\d+\s+character/i.test(
                  document.querySelector('#StateWordCount')?.textContent || '')
              && typeof globalThis.TheFakeWebSocket !== 'undefined',
        { timeout: env.scaleTimeout(150000) });
    await sleep(5000);

    async function clickA() {
        const el = await pageA.$('iframe#editor-frame');
        if (el) { const b = await el.boundingBox(); if (b) await pageA.mouse.click(b.x + b.width/2, b.y + b.height/2); }
        await sleep(300);
    }

    const ccA0 = await getCharCount(pageA);
    console.log('  A initial: ' + ccA0 + ' chars');

    // A types — NO SAVE
    await clickA();
    await pageA.keyboard.type('UNSAVED_EDITS ', { delay: 60 });
    await sleep(3000);
    const ccA1 = await getCharCount(pageA);
    check('CASE1: A typed 14 chars', ccA1 - ccA0 === 14, 'delta=' + (ccA1 - ccA0));
    await snap(pageA, 'case1_A_after_type');

    // DO NOT SAVE — B joins while A's edits are only in the relay message log
    console.log('  [A] NOT saving — B will join with unsaved edits in relay');

    // B joins (same browser, different context). isolatedContext gives B its
    // own localStorage / IndexedDB so the viewer sees it as a distinct client.
    const upB = await openSecretInBrowser(browserA, VIEWER, b64urlSecret,
        { iframeTimeout: env.scaleTimeout(60000),
          gotoTimeout: env.scaleTimeout(60000),
          isolatedContext: true,
          viewport: { width: 1280, height: 900 } });
    const pageB = upB.page;
    await waitInFrame(pageB,
        () => /\d+\s+character/i.test(
                  document.querySelector('#StateWordCount')?.textContent || '')
              && typeof globalThis.TheFakeWebSocket !== 'undefined',
        { timeout: env.scaleTimeout(150000) });
    await sleep(10000); // generous settle for message replay

    const ccB0 = await getCharCount(pageB);
    await snap(pageB, 'case1_B_after_join');
    console.log('  B after join: ' + ccB0 + ' chars (A had ' + ccA1 + ')');
    check('CASE1: B sees A content (within ±5)', Math.abs(ccB0 - ccA1) <= 5,
        'B=' + ccB0 + ' A=' + ccA1 + ' diff=' + Math.abs(ccB0 - ccA1));
    check('CASE1: B is NOT blank', ccB0 > 20, 'B=' + ccB0);

    // Verify A's content hasn't been corrupted by B joining
    await sleep(3000);
    const ccA2 = await getCharCount(pageA);
    check('CASE1: A still has content after B joined', ccA2 >= ccA1,
        'A_now=' + ccA2 + ' A_before=' + ccA1);

    // Check the stored (encrypted) file wasn't overwritten with blank
    const storedSize = await pageA.evaluate(async (id) => {
        const r = await fetch('/api/v2/file/' + id);
        if (!r.ok) return -1;
        return (await r.json()).size;
    }, fileId);
    check('CASE1: Stored file not tiny (>1000 bytes ciphertext)', storedSize > 1000,
        'storedSize=' + storedSize);

    await snap(pageA, 'case1_A_final');
    await snap(pageB, 'case1_B_final');

    // Clean up
    await cleanupA();
    await sleep(3000);

    // ═══ CASE 2: Nobody is open, C opens the doc ═══
    // After Case 1, the checkpoint should contain A's edits
    console.log('\n=== CASE 2: All browsers closed, C opens ===');

    const { browser: browserC, cleanup: cleanupC } = await launch();
    const upC = await openSecretInBrowser(browserC, VIEWER, b64urlSecret,
        { iframeTimeout: env.scaleTimeout(60000),
          gotoTimeout: env.scaleTimeout(60000),
          viewport: { width: 1280, height: 900 } });
    const pageC = upC.page;
    await waitInFrame(pageC,
        () => /\d+\s+character/i.test(
                  document.querySelector('#StateWordCount')?.textContent || '')
              && typeof globalThis.TheFakeWebSocket !== 'undefined',
        { timeout: env.scaleTimeout(150000) });
    await sleep(5000);

    const ccC0 = await getCharCount(pageC);
    await snap(pageC, 'case2_C_after_open');
    console.log('  C after open: ' + ccC0 + ' chars (A had ' + ccA1 + ')');
    check('CASE2: C sees A content (within ±5)', Math.abs(ccC0 - ccA1) <= 5,
        'C=' + ccC0 + ' A=' + ccA1 + ' diff=' + Math.abs(ccC0 - ccA1));
    check('CASE2: C is NOT blank', ccC0 > 20, 'C=' + ccC0);

    await cleanupC();

    console.log('\n' + (allPassed ? '✓ ALL PASSED' : '✗ SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
