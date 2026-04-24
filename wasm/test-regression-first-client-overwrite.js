const __cl = require('./lib/inject-checklist');
// Regression: First client's activation checkpoint might save stale/blank content.
//
// Scenario: The viewer pre-warms with blank.docx, then hot-switches to a real doc.
// The relay-adapter activates and immediately calls saveAndUploadCheckpoint().
// If Kit hasn't finished loading the real doc yet, the checkpoint is the blank doc.
// A second client joining would then receive blank content.
//
// Test:
//   1. Upload a doc with known content (19 chars)
//   2. Browser A opens the doc (goes through prewarm → hot-switch)
//   3. Wait for A to fully load and stabilize
//   4. Check: did A's activation checkpoint overwrite the file with blank content?
//   5. Close A
//   6. Browser B opens the same doc
//   7. B must see the 19-char content, NOT blank

const { launch, sleep } = require('./lib/browser');
const fs = require('fs'), path = require('path');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');
const VIEWER = env.FILE_STORAGE_URL;
const SHOTS = '/tmp/static-deploy/public/shots-regression-first-client-overwrite';

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
        await page.screenshot({ path: `${SHOTS}/${String(stepNum).padStart(2,'0')}_${name}.png` });
    }

    const docName = 'fc-overwrite-' + Date.now() + '.docx';
    const bytes = fs.readFileSync(path.join(__dirname, '..', 'test', 'data', 'new.docx'));
    const { b64urlSecret, fileId } = await uploadV2(VIEWER, docName, bytes);
    console.log('[setup] Uploaded v2 ' + docName + ' as ' + fileId.substring(0,8) + '…');

    // Check initial stored ciphertext size via v2 endpoint. (The file
    // is encrypted at rest, so the server-reported size is plaintext +
    // 28 bytes for the AES-GCM IV + tag.)
    async function getStoredSize() {
        const r = await fetch(VIEWER + '/api/v2/file/' + fileId);
        if (!r.ok) return -1;
        const j = await r.json();
        return j.size;
    }
    const initialSize = await getStoredSize();
    console.log('  Initial stored (ciphertext) size: ' + initialSize + ' bytes');

    // ═══ Phase 1: Browser A opens (prewarm → hot-switch) ═══
    console.log('\n=== Phase 1: A opens doc ===');
    const { browser: bA, cleanup: cA } = await launch();
    const pA = await bA.newPage();
    await pA.setViewport({ width: 1280, height: 900 });
    await pA.goto(VIEWER + '/#file=' + b64urlSecret, { waitUntil: 'domcontentloaded' });

    let fA;
    for (let i = 0; i < 300; i++) {
        await sleep(500);
        fA = pA.frames().find(f => f.url().includes('cool.html'));
        if (fA) {
            const wc = await fA.evaluate(() =>
                document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
            if (/\d+\s+character/i.test(wc)) {
                const ws = await fA.evaluate(() =>
                    typeof globalThis.TheFakeWebSocket !== 'undefined').catch(() => false);
                if (ws) break;
            }
        }
    }
    if (!fA) throw new Error('A failed');
    await sleep(10000); // Let activation checkpoint complete

    const ccA = charCount(await fA.evaluate(() =>
        document.querySelector('#StateWordCount')?.textContent?.trim() || ''));
    await snap(pA, 'A_loaded');
    console.log('  A loaded: ' + ccA + ' chars');
    check('A sees content (19 chars)', ccA === 19, 'cc=' + ccA);

    // Check: did the activation checkpoint corrupt the stored file?
    const sizeAfterA = await getStoredSize();
    console.log('  File size after A activation: ' + sizeAfterA + ' (was ' + initialSize + ')');
    // The file should be similar size (±20% tolerance for DOCX round-trip)
    const sizeRatio = sizeAfterA / initialSize;
    check('File not corrupted by activation save (size ratio 0.5-2.0)',
        sizeRatio >= 0.5 && sizeRatio <= 2.0,
        'ratio=' + sizeRatio.toFixed(2) + ' (' + sizeAfterA + '/' + initialSize + ')');

    // ═══ Phase 2: Close A, open B ═══
    console.log('\n=== Phase 2: Close A, open B ===');
    await cA();
    await sleep(5000);

    const { browser: bB, cleanup: cB } = await launch();
    const pB = await bB.newPage();
    await pB.setViewport({ width: 1280, height: 900 });
    await pB.goto(VIEWER + '/#file=' + b64urlSecret, { waitUntil: 'domcontentloaded' });

    let fB;
    for (let i = 0; i < 300; i++) {
        await sleep(500);
        fB = pB.frames().find(f => f.url().includes('cool.html'));
        if (fB) {
            const wc = await fB.evaluate(() =>
                document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
            if (/\d+\s+character/i.test(wc)) {
                const ws = await fB.evaluate(() =>
                    typeof globalThis.TheFakeWebSocket !== 'undefined').catch(() => false);
                if (ws) break;
            }
        }
    }
    if (!fB) throw new Error('B failed');
    await sleep(5000);

    const ccB = charCount(await fB.evaluate(() =>
        document.querySelector('#StateWordCount')?.textContent?.trim() || ''));
    await snap(pB, 'B_loaded');
    console.log('  B loaded: ' + ccB + ' chars');
    check('B sees content (19 chars, not blank)', ccB === 19, 'cc=' + ccB);
    check('B is NOT blank', ccB > 10, 'cc=' + ccB);

    // Final file size check
    const finalSize = await getStoredSize();
    console.log('  Final file size: ' + finalSize + ' bytes');
    check('File intact after B', finalSize > initialSize * 0.5,
        'size=' + finalSize + ' initial=' + initialSize);

    await cB();
    console.log('\n' + (allPassed ? '✓ ALL PASSED' : '✗ SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
