const __cl = require('../../lib/inject-checklist');
// Regression: Late joiner must NOT overwrite document with blank/stale content.
//
// Bug scenario:
//   1. Browser A opens a document, types content, saves (Ctrl+S)
//   2. Browser A closes
//   3. Browser B opens the same document
//   4. B should see A's content — but instead may see a blank document
//      because B's activation triggers saveAndUploadCheckpoint() before
//      the checkpoint file is properly loaded, overwriting the stored
//      file with blank prewarm content.
//
// This test reproduces the issue by:
//   Phase 1: A opens, types, saves, verifies content
//   Phase 2: A closes completely
//   Phase 3: B opens the same doc, verifies it sees A's content
//   Phase 4: B types more, saves
//   Phase 5: C opens the same doc, verifies it sees A+B content
//
// ALL input via real keyboard/mouse.

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs'), path = require('path');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');
const VIEWER = env.FILE_STORAGE_URL;
const SHOTS = '/tmp/static-deploy/public/shots-regression-latejoin-overwrite';

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
    const docName = 'ljover-' + Date.now() + '.docx';
    const bytes = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx'));
    const { b64urlSecret, fileId } = await uploadV2(VIEWER, docName, bytes);
    console.log('[setup] Uploaded v2 ' + docName + ' → ' + fileId.substring(0,8) + '…');

    // Helper: open the doc in a fresh browser, wait for editor, return helpers
    async function openDoc(label) {
        const { browser, cleanup } = await launch();
        const page = await browser.newPage();
        const cdp = await page.createCDPSession();
        await cdp.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
        await page.setViewport({ width: 1280, height: 900 });
        await page.goto(VIEWER + '/#file=' + b64urlSecret, { waitUntil: 'domcontentloaded' });

        let frame;
        for (let i = 0; i < 300; i++) {
            await sleep(500);
            frame = page.frames().find(f => f.url().includes('cool.html'));
            if (frame) {
                const wc = await frame.evaluate(() =>
                    document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
                if (/\d+\s+character/i.test(wc)) {
                    const ws = await frame.evaluate(() =>
                        typeof globalThis.TheFakeWebSocket !== 'undefined').catch(() => false);
                    if (ws) break;
                }
            }
        }
        if (!frame) throw new Error(label + ': editor did not load');
        await sleep(5000); // settle

        async function getWc() {
            return frame.evaluate(() =>
                document.querySelector('#StateWordCount')?.textContent?.trim() || '').catch(() => '');
        }
        async function clickEditor() {
            const el = await page.$('iframe#editor-frame');
            if (el) { const b = await el.boundingBox(); if (b) await page.mouse.click(b.x + b.width/2, b.y + b.height/2); }
            await sleep(300);
        }

        const cc = charCount(await getWc());
        console.log(`[${label}] Loaded: ${cc} chars`);
        return { browser, page, frame, cleanup, getWc, clickEditor, cc };
    }

    // ═══ Phase 1: Browser A opens, types, saves ═══
    console.log('\n=== Phase 1: Browser A types and saves ===');
    const A = await openDoc('A');
    const ccA0 = A.cc;

    await A.clickEditor();
    await A.page.keyboard.type('CONTENT_FROM_A ', { delay: 60 });
    await sleep(3000);
    const ccA1 = charCount(await A.getWc());
    check('A typed 15 chars', ccA1 - ccA0 === 15, 'delta=' + (ccA1 - ccA0));
    await snap(A.page, 'A_after_type');

    // Save
    await A.clickEditor();
    await A.page.keyboard.down('Control');
    await A.page.keyboard.press('s');
    await A.page.keyboard.up('Control');
    console.log('  [A] Ctrl+S — waiting for checkpoint...');
    await sleep(15000);
    await snap(A.page, 'A_after_save');

    // Record A's final char count
    const ccAfinal = charCount(await A.getWc());
    console.log('  A final: ' + ccAfinal + ' chars');

    // ═══ Phase 2: Close A completely ═══
    console.log('\n=== Phase 2: Close Browser A ===');
    await A.cleanup();
    console.log('  A closed');
    await sleep(5000); // let relay detect disconnect

    // ═══ Phase 3: Browser B opens same doc ═══
    console.log('\n=== Phase 3: Browser B opens same doc ===');
    const B = await openDoc('B');
    const ccB0 = B.cc;
    await snap(B.page, 'B_after_open');

    // THE KEY CHECK: B must see A's content
    check('B sees A content (chars within ±5)', Math.abs(ccB0 - ccAfinal) <= 5,
        'B=' + ccB0 + ' A_final=' + ccAfinal + ' diff=' + Math.abs(ccB0 - ccAfinal));
    check('B is NOT blank (more than initial)', ccB0 > 20,
        'B=' + ccB0 + ' (initial was ~19)');

    // B types more
    await B.clickEditor();
    await B.page.keyboard.down('Control');
    await B.page.keyboard.press('End');
    await B.page.keyboard.up('Control');
    await sleep(500);
    await B.page.keyboard.type('ADDED_BY_B ', { delay: 60 });
    await sleep(3000);
    const ccB1 = charCount(await B.getWc());
    check('B typed 11 chars', ccB1 - ccB0 === 11, 'delta=' + (ccB1 - ccB0));

    // Save
    await B.clickEditor();
    await B.page.keyboard.down('Control');
    await B.page.keyboard.press('s');
    await B.page.keyboard.up('Control');
    console.log('  [B] Ctrl+S — waiting for checkpoint...');
    await sleep(15000);
    const ccBfinal = charCount(await B.getWc());
    console.log('  B final: ' + ccBfinal + ' chars');
    await snap(B.page, 'B_after_save');

    // ═══ Phase 4: Close B, open C ═══
    console.log('\n=== Phase 4: Close B, open C ===');
    await B.cleanup();
    console.log('  B closed');
    await sleep(5000);

    const C = await openDoc('C');
    const ccC0 = C.cc;
    await snap(C.page, 'C_after_open');

    check('C sees A+B content (chars within ±5)', Math.abs(ccC0 - ccBfinal) <= 5,
        'C=' + ccC0 + ' B_final=' + ccBfinal + ' diff=' + Math.abs(ccC0 - ccBfinal));
    check('C is NOT blank (more than B)', ccC0 > ccAfinal,
        'C=' + ccC0 + ' A_final=' + ccAfinal);

    await C.cleanup();

    console.log('\n' + (allPassed ? '✓ ALL PASSED' : '✗ SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
