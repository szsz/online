const __cl = require('../../lib/inject-checklist');
// Regression: Late joiner prewarm race — the WASM Kit may still have the
// blank prewarm doc when the late joiner activates. If saveAndUploadCheckpoint()
// fires before the real doc is loaded, it overwrites the file with blank content.
//
// Test: A opens and edits. B opens the SAME doc rapidly (within seconds of
// page load, before prewarm fully completes). Verify B doesn't overwrite A's work.

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs'), path = require('path');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');
const VIEWER = env.FILE_STORAGE_URL;
const SHOTS = '/tmp/static-deploy/public/shots-regression-latejoin-prewarm-race';

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

    // Upload a doc with known content via v2 (encrypted)
    const docName = 'ljrace-' + Date.now() + '.docx';
    const bytes = fs.readFileSync(path.join(__dirname, '..', 'test', 'data', 'new.docx'));
    const { b64urlSecret, fileId } = await uploadV2(VIEWER, docName, bytes);
    console.log('[setup] Uploaded v2 ' + docName + ' → ' + fileId.substring(0,8) + '…');

    // Phase 1: A opens, types, saves
    console.log('\n=== Phase 1: A types and saves ===');
    const { browser: bA, cleanup: cA } = await launch();
    const pA = await bA.newPage();
    const cdpA = await pA.createCDPSession();
    await cdpA.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
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
    await sleep(5000);

    async function clickA() {
        const el = await pA.$('iframe#editor-frame');
        if (el) { const b = await el.boundingBox(); if (b) await pA.mouse.click(b.x+b.width/2, b.y+b.height/2); }
        await sleep(300);
    }

    await clickA();
    await pA.keyboard.type('IMPORTANT_DATA_MUST_NOT_BE_LOST ', { delay: 40 });
    await sleep(3000);
    const ccA = charCount(await fA.evaluate(() =>
        document.querySelector('#StateWordCount')?.textContent?.trim() || ''));
    check('A typed 32 chars', ccA > 45, 'cc=' + ccA);

    await clickA();
    await pA.keyboard.down('Control'); await pA.keyboard.press('s'); await pA.keyboard.up('Control');
    console.log('  A saved');
    await sleep(15000);
    await cA();
    console.log('  A closed');
    await sleep(5000);

    // Phase 2: Open B rapidly — it must see A's content
    console.log('\n=== Phase 2: Open B rapidly ===');
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
    await sleep(8000);

    const ccB = charCount(await fB.evaluate(() =>
        document.querySelector('#StateWordCount')?.textContent?.trim() || ''));
    await snap(pB, 'B_after_open');
    console.log('  B: ' + ccB + ' chars (A had ' + ccA + ')');
    check('B sees A content (within ±5)', Math.abs(ccB - ccA) <= 5,
        'B=' + ccB + ' A=' + ccA);
    check('B not blank', ccB > 30, 'cc=' + ccB);

    // Wait and check file storage wasn't corrupted
    await sleep(10000);
    const storedSize = await pB.evaluate(async (id) => {
        const r = await fetch('/api/v2/file/' + id);
        if (!r.ok) return -1;
        return (await r.json()).size;
    }, fileId);
    check('Stored file not corrupted (>2000B)', storedSize > 2000, 'size=' + storedSize);

    // Open C to verify file is still intact
    console.log('\n=== Phase 3: Open C to verify ===');
    await cB();
    await sleep(5000);

    const { browser: bC, cleanup: cC } = await launch();
    const pC = await bC.newPage();
    await pC.setViewport({ width: 1280, height: 900 });
    await pC.goto(VIEWER + '/#file=' + b64urlSecret, { waitUntil: 'domcontentloaded' });

    let fC;
    for (let i = 0; i < 300; i++) {
        await sleep(500);
        fC = pC.frames().find(f => f.url().includes('cool.html'));
        if (fC) {
            const wc = await fC.evaluate(() =>
                document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
            if (/\d+\s+character/i.test(wc)) {
                const ws = await fC.evaluate(() =>
                    typeof globalThis.TheFakeWebSocket !== 'undefined').catch(() => false);
                if (ws) break;
            }
        }
    }
    if (!fC) throw new Error('C failed');
    await sleep(5000);

    const ccC = charCount(await fC.evaluate(() =>
        document.querySelector('#StateWordCount')?.textContent?.trim() || ''));
    await snap(pC, 'C_verify');
    console.log('  C: ' + ccC + ' chars');
    check('C still sees content (within ±5 of A)', Math.abs(ccC - ccA) <= 5,
        'C=' + ccC + ' A=' + ccA);
    check('C not blank', ccC > 30, 'cc=' + ccC);

    await cC();
    console.log('\n' + (allPassed ? '✓ ALL PASSED' : '✗ SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
