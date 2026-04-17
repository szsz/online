const __cl = require('./lib/inject-checklist');
// Regression: Hard refresh with slow reconnect loses unsaved edits.
//
// The relay cleans up rooms 60s after the last client disconnects.
// If the user hard-refreshes and WASM takes >60s to boot (cold cache,
// slow connection), the room is deleted and the edits are lost.
//
// This test simulates this by:
//   1. A opens, types XYZ (no save)
//   2. A's browser closes (simulating hard refresh disconnect)
//   3. Wait 70 seconds (room cleanup fires at 60s)
//   4. New browser opens the same doc
//   5. Check: are the edits preserved?

const { launch, sleep } = require('./lib/browser');
const fs = require('fs'), path = require('path');
const env = require('./lib/test-env');
const VIEWER = env.FILE_STORAGE_URL;
const SHOTS = '/tmp/static-deploy/public/shots-regression-hard-refresh-slow';

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

    const docName = 'hrslow-' + Date.now() + '.docx';
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
    console.log('\n=== Phase 1: Open, type XYZ, do NOT save ===');
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

    const cc0 = charCount(await fA.evaluate(() =>
        document.querySelector('#StateWordCount')?.textContent?.trim() || ''));
    console.log('  Initial: ' + cc0 + ' chars');

    const el = await pA.$('iframe#editor-frame');
    if (el) { const b = await el.boundingBox(); if (b) await pA.mouse.click(b.x+b.width/2, b.y+b.height/2); }
    await sleep(500);
    await pA.keyboard.type('XYZ', { delay: 80 });
    await sleep(3000);
    const cc1 = charCount(await fA.evaluate(() =>
        document.querySelector('#StateWordCount')?.textContent?.trim() || ''));
    console.log('  After typing: ' + cc1 + ' chars');
    check('Typed 3 chars', cc1 - cc0 === 3, 'delta=' + (cc1 - cc0));
    await snap(pA, 'before_disconnect');

    // ═══ Phase 2: Close browser (simulating hard refresh disconnect) ═══
    console.log('\n=== Phase 2: Close browser (simulate disconnect) ===');
    await cA();
    console.log('  Browser closed. WebSocket disconnected.');

    // ═══ Phase 3: Wait >60s for room cleanup ═══
    console.log('\n=== Phase 3: Waiting 70s for room cleanup timeout... ===');
    for (let i = 0; i < 7; i++) {
        await sleep(10000);
        process.stdout.write('  ' + ((i+1)*10) + 's...');
    }
    console.log(' done');

    // Check: is the room still in the relay?
    const { browser: bCheck, cleanup: cCheck } = await launch();
    const pCheck = await bCheck.newPage();
    // The relay debug API shows active rooms
    const roomKey = encodeURIComponent(docName).replace(/%/g, '_');
    const roomExists = await pCheck.evaluate(async (url) => {
        try {
            const r = await fetch(url, { mode: 'cors' });
            if (!r.ok) return 'fetch-error-' + r.status;
            const rooms = await r.json();
            return JSON.stringify(rooms);
        } catch(e) { return 'error: ' + e.message; }
    }, env.RELAY_URL.replace('wss:', 'https:').replace('ws:', 'http:') + '/../debug/api/rooms');
    console.log('  Relay rooms after 70s: ' + (roomExists || 'none').substring(0, 200));
    await pCheck.close();
    await cCheck();

    // ═══ Phase 4: New browser opens same doc ═══
    console.log('\n=== Phase 4: New browser opens same doc ===');
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
    await sleep(5000);

    const cc2 = charCount(await fB.evaluate(() =>
        document.querySelector('#StateWordCount')?.textContent?.trim() || ''));
    await snap(pB, 'after_reopen');
    console.log('  After reopen: ' + cc2 + ' chars (expected ' + cc1 + ')');

    check('After slow reconnect: sees typed content (' + cc1 + ' chars)',
        cc2 === cc1,
        'got=' + cc2 + ' expected=' + cc1 + ' lost=' + (cc1 - cc2) + ' chars');
    check('Edits NOT lost',
        cc2 > cc0,
        'got=' + cc2 + ' initial=' + cc0);

    await cB();
    console.log('\n' + (allPassed ? '✓ ALL PASSED' : '✗ SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
