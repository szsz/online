const __cl = require('./lib/inject-checklist');
// Regression: Hard refresh loses unsaved edits.
//
// Steps to reproduce:
//   1. A opens a doc with existing content (19 chars)
//   2. A types "XYZ" (22 chars)
//   3. A does NOT save
//   4. A does a hard refresh (reload the page)
//   5. A opens the same document
//   6. A should see 22 chars — but may see 19 (lost edits)
//
// Root cause: hard refresh kills WebSocket instantly. The relay has A's
// messages in its log, but:
//   - The room may be cleaned up (60s timeout) if WASM takes too long to boot
//   - Even if the room survives, the reconnecting A gets a new viewId,
//     and the checkpoint is from before the edits
//   - If the room IS cleaned up, the messages are gone forever
//
// ALL input via real keyboard/mouse.

const { launch, sleep } = require('./lib/browser');
const fs = require('fs'), path = require('path');
const env = require('./lib/test-env');
const VIEWER = env.FILE_STORAGE_URL;
const SHOTS = '/tmp/static-deploy/public/shots-regression-hard-refresh';

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

    const docName = 'hardrefresh-' + Date.now() + '.docx';

    // Upload
    const { browser: bUp, cleanup: cUp } = await launch();
    const pUp = await bUp.newPage();
    await pUp.goto(VIEWER + '/');
    await pUp.evaluate(async (name, a) => {
        await fetch('/api/files/' + name, { method: 'POST', body: new Blob([new Uint8Array(a)]) });
    }, docName, Array.from(fs.readFileSync(path.join(__dirname, '..', 'test', 'data', 'new.docx'))));
    await pUp.close();
    await cUp();
    console.log('[setup] Uploaded ' + docName);

    // ═══ Phase 1: Open, type, NO save ═══
    console.log('\n=== Phase 1: Open doc, type XYZ, do NOT save ===');
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
    if (!fA) throw new Error('Phase 1: editor failed');
    await sleep(5000);

    const cc0 = charCount(await fA.evaluate(() =>
        document.querySelector('#StateWordCount')?.textContent?.trim() || ''));
    console.log('  Initial: ' + cc0 + ' chars');

    // Click and type
    const el = await pA.$('iframe#editor-frame');
    if (el) { const b = await el.boundingBox(); if (b) await pA.mouse.click(b.x+b.width/2, b.y+b.height/2); }
    await sleep(500);
    await pA.keyboard.type('XYZ', { delay: 80 });
    await sleep(3000);
    const cc1 = charCount(await fA.evaluate(() =>
        document.querySelector('#StateWordCount')?.textContent?.trim() || ''));
    console.log('  After typing: ' + cc1 + ' chars');
    check('Typed 3 chars', cc1 - cc0 === 3, 'delta=' + (cc1 - cc0));
    await snap(pA, 'before_refresh');

    // ═══ Phase 2: HARD REFRESH (simulate F5 / Ctrl+R) ═══
    console.log('\n=== Phase 2: Hard refresh (navigate to same URL) ===');
    // This is equivalent to the user pressing F5 — the page reloads,
    // WebSocket closes instantly, no save triggered.
    await pA.goto(VIEWER + '/#file=' + docName, { waitUntil: 'domcontentloaded' });
    console.log('  Page reloaded');

    // Wait for editor to load again
    let fA2;
    for (let i = 0; i < 300; i++) {
        await sleep(500);
        fA2 = pA.frames().find(f => f.url().includes('cool.html'));
        if (fA2) {
            const wc = await fA2.evaluate(() =>
                document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
            if (/\d+\s+character/i.test(wc)) {
                const ws = await fA2.evaluate(() =>
                    typeof globalThis.TheFakeWebSocket !== 'undefined').catch(() => false);
                if (ws) break;
            }
        }
    }
    if (!fA2) throw new Error('Phase 2: editor failed after refresh');
    await sleep(10000); // generous settle for message replay

    const cc2 = charCount(await fA2.evaluate(() =>
        document.querySelector('#StateWordCount')?.textContent?.trim() || ''));
    await snap(pA, 'after_refresh');
    console.log('  After refresh: ' + cc2 + ' chars (expected ' + cc1 + ')');

    // THE KEY CHECKS
    check('After refresh: sees typed content (' + cc1 + ' chars)',
        cc2 === cc1,
        'got=' + cc2 + ' expected=' + cc1 + ' diff=' + (cc2 - cc1));
    check('After refresh: NOT blank/initial',
        cc2 > cc0,
        'got=' + cc2 + ' initial=' + cc0);

    // Check stored file
    const storedSize = await pA.evaluate(async (name) => {
        const r = await fetch('/api/files/' + encodeURIComponent(name));
        return r.ok ? (await r.arrayBuffer()).byteLength : -1;
    }, docName);
    console.log('  Stored file: ' + storedSize + ' bytes');

    await cA();
    console.log('\n' + (allPassed ? '✓ ALL PASSED' : '✗ SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
