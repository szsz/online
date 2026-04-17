const __cl = require('./lib/inject-checklist');
// Regression: A types (unsaved), A goes offline, B joins.
//
// A's edits are in the relay message log but NOT in a checkpoint.
// When B joins with no active peers, the relay serves the OLD checkpoint
// (before A's edits) plus the message log. B should replay the messages
// to catch up.
//
// Bug: If the relay's message log doesn't include A's edits, or if
// the message replay doesn't work, B opens with stale/blank content.

const { launch, sleep } = require('./lib/browser');
const fs = require('fs'), path = require('path');
const env = require('./lib/test-env');
const VIEWER = env.FILE_STORAGE_URL;
const SHOTS = '/tmp/static-deploy/public/shots-regression-latejoin-offline-unsaved';

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

    const docName = 'ljoffline-' + Date.now() + '.docx';
    const { browser: bUp, cleanup: cUp } = await launch();
    const pUp = await bUp.newPage();
    await pUp.goto(VIEWER + '/');
    await pUp.evaluate(async (name, a) => {
        await fetch('/api/files/' + name, { method: 'POST', body: new Blob([new Uint8Array(a)]) });
    }, docName, Array.from(fs.readFileSync(path.join(__dirname, '..', 'test', 'data', 'new.docx'))));
    await pUp.close();
    await cUp();
    console.log('[setup] Uploaded ' + docName + ' (initial ~19 chars)');

    // ═══ Phase 1: A opens, types, does NOT save, then CLOSES ═══
    console.log('\n=== Phase 1: A opens, types (NO save), closes ===');
    const { browser: bA, cleanup: cA } = await launch();
    const pA = await bA.newPage();
    await pA.setViewport({ width: 1280, height: 900 });
    await pA.goto(VIEWER + '/#file=' + docName, { waitUntil: 'domcontentloaded' });

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

    const ccA0 = charCount(await fA.evaluate(() =>
        document.querySelector('#StateWordCount')?.textContent?.trim() || ''));
    console.log('  A initial: ' + ccA0 + ' chars');

    // Type content
    await clickA();
    await pA.keyboard.type('UNSAVED_CONTENT_FROM_A ', { delay: 40 });
    await sleep(3000);
    const ccA1 = charCount(await fA.evaluate(() =>
        document.querySelector('#StateWordCount')?.textContent?.trim() || ''));
    console.log('  A after typing: ' + ccA1 + ' chars');
    check('A typed 23 chars', ccA1 - ccA0 === 23, 'delta=' + (ccA1 - ccA0));
    await snap(pA, 'A_after_type');

    // A does NOT press Ctrl+S — edits are only in relay message log
    console.log('  [A] Closing WITHOUT saving...');
    await cA();
    console.log('  A closed. Relay has messages but checkpoint is from initial activation.');
    await sleep(5000); // let relay detect disconnect

    // ═══ Phase 2: B opens the same doc ═══
    console.log('\n=== Phase 2: B opens same doc (A is gone, unsaved edits in relay) ===');
    const { browser: bB, cleanup: cB } = await launch();
    const pB = await bB.newPage();
    await pB.setViewport({ width: 1280, height: 900 });
    await pB.goto(VIEWER + '/#file=' + docName, { waitUntil: 'domcontentloaded' });

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
    await sleep(10000); // generous settle

    const ccB0 = charCount(await fB.evaluate(() =>
        document.querySelector('#StateWordCount')?.textContent?.trim() || ''));
    await snap(pB, 'B_after_open');
    console.log('  B after open: ' + ccB0 + ' chars (A had ' + ccA1 + ')');

    // THE KEY CHECKS
    check('B sees A content (within ±5)', Math.abs(ccB0 - ccA1) <= 5,
        'B=' + ccB0 + ' A=' + ccA1 + ' diff=' + Math.abs(ccB0 - ccA1));
    check('B is NOT blank/initial (>25 chars)', ccB0 > 25,
        'B=' + ccB0 + ' (initial was ~19)');

    // Check stored file
    const storedSize = await pB.evaluate(async (name) => {
        const r = await fetch('/api/files/' + encodeURIComponent(name));
        if (!r.ok) return -1;
        return (await r.arrayBuffer()).byteLength;
    }, docName);
    console.log('  Stored file size: ' + storedSize + ' bytes');

    await cB();
    console.log('\n' + (allPassed ? '✓ ALL PASSED' : '✗ SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
