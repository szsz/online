const __cl = require('./lib/inject-checklist');
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

const { launch, sleep } = require('./lib/browser');
const fs = require('fs'), path = require('path');
const env = require('./lib/test-env');
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

    // Upload fresh doc
    const docName = 'ljunsaved-' + Date.now() + '.docx';
    const { browser: browserUp, cleanup: cleanupUp } = await launch();
    const up = await browserUp.newPage();
    await up.goto(VIEWER + '/');
    await up.evaluate(async (name, a) => {
        await fetch('/api/files/' + name, { method: 'POST', body: new Blob([new Uint8Array(a)]) });
    }, docName, Array.from(fs.readFileSync(path.join(__dirname, '..', 'test', 'data', 'new.docx'))));
    await up.close();
    await cleanupUp();
    console.log('[setup] Uploaded ' + docName);

    // ═══ CASE 1: A types (no save), B joins while A is still open ═══
    console.log('\n=== CASE 1: A types (no save), B joins while A is open ===');

    const { browser: browserA, cleanup: cleanupA } = await launch();
    const pageA = await browserA.newPage();
    await pageA.setViewport({ width: 1280, height: 900 });
    await pageA.goto(VIEWER + '/#file=' + docName, { waitUntil: 'domcontentloaded' });

    let frameA;
    for (let i = 0; i < 300; i++) {
        await sleep(500);
        frameA = pageA.frames().find(f => f.url().includes('cool.html'));
        if (frameA) {
            const wc = await frameA.evaluate(() =>
                document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
            if (/\d+\s+character/i.test(wc)) {
                const ws = await frameA.evaluate(() =>
                    typeof globalThis.TheFakeWebSocket !== 'undefined').catch(() => false);
                if (ws) break;
            }
        }
    }
    if (!frameA) throw new Error('A did not load');
    await sleep(5000);

    async function getWcA() {
        return frameA.evaluate(() =>
            document.querySelector('#StateWordCount')?.textContent?.trim() || '').catch(() => '');
    }
    async function clickA() {
        const el = await pageA.$('iframe#editor-frame');
        if (el) { const b = await el.boundingBox(); if (b) await pageA.mouse.click(b.x + b.width/2, b.y + b.height/2); }
        await sleep(300);
    }

    const ccA0 = charCount(await getWcA());
    console.log('  A initial: ' + ccA0 + ' chars');

    // A types — NO SAVE
    await clickA();
    await pageA.keyboard.type('UNSAVED_EDITS ', { delay: 60 });
    await sleep(3000);
    const ccA1 = charCount(await getWcA());
    check('CASE1: A typed 14 chars', ccA1 - ccA0 === 14, 'delta=' + (ccA1 - ccA0));
    await snap(pageA, 'case1_A_after_type');

    // DO NOT SAVE — B joins while A's edits are only in the relay message log
    console.log('  [A] NOT saving — B will join with unsaved edits in relay');

    // B joins (same browser, different context)
    const ctxB = await browserA.createBrowserContext();
    const pageB = await ctxB.newPage();
    await pageB.setViewport({ width: 1280, height: 900 });
    await pageB.goto(VIEWER + '/#file=' + docName, { waitUntil: 'domcontentloaded' });

    let frameB;
    for (let i = 0; i < 300; i++) {
        await sleep(500);
        frameB = pageB.frames().find(f => f.url().includes('cool.html'));
        if (frameB) {
            const wc = await frameB.evaluate(() =>
                document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
            if (/\d+\s+character/i.test(wc)) {
                const ws = await frameB.evaluate(() =>
                    typeof globalThis.TheFakeWebSocket !== 'undefined').catch(() => false);
                if (ws) break;
            }
        }
    }
    if (!frameB) throw new Error('B did not load');
    await sleep(10000); // generous settle for message replay

    async function getWcB() {
        return frameB.evaluate(() =>
            document.querySelector('#StateWordCount')?.textContent?.trim() || '').catch(() => '');
    }

    const ccB0 = charCount(await getWcB());
    await snap(pageB, 'case1_B_after_join');
    console.log('  B after join: ' + ccB0 + ' chars (A had ' + ccA1 + ')');
    check('CASE1: B sees A content (within ±5)', Math.abs(ccB0 - ccA1) <= 5,
        'B=' + ccB0 + ' A=' + ccA1 + ' diff=' + Math.abs(ccB0 - ccA1));
    check('CASE1: B is NOT blank', ccB0 > 20, 'B=' + ccB0);

    // Verify A's content hasn't been corrupted by B joining
    await sleep(3000);
    const ccA2 = charCount(await getWcA());
    check('CASE1: A still has content after B joined', ccA2 >= ccA1,
        'A_now=' + ccA2 + ' A_before=' + ccA1);

    // Check the stored file wasn't overwritten with blank
    const storedSize = await pageA.evaluate(async (name) => {
        const r = await fetch('/api/files/' + encodeURIComponent(name));
        if (!r.ok) return -1;
        const buf = await r.arrayBuffer();
        return buf.byteLength;
    }, docName);
    check('CASE1: Stored file not tiny (>1000 bytes)', storedSize > 1000,
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
    const pageC = await browserC.newPage();
    await pageC.setViewport({ width: 1280, height: 900 });
    await pageC.goto(VIEWER + '/#file=' + docName, { waitUntil: 'domcontentloaded' });

    let frameC;
    for (let i = 0; i < 300; i++) {
        await sleep(500);
        frameC = pageC.frames().find(f => f.url().includes('cool.html'));
        if (frameC) {
            const wc = await frameC.evaluate(() =>
                document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
            if (/\d+\s+character/i.test(wc)) {
                const ws = await frameC.evaluate(() =>
                    typeof globalThis.TheFakeWebSocket !== 'undefined').catch(() => false);
                if (ws) break;
            }
        }
    }
    if (!frameC) throw new Error('C did not load');
    await sleep(5000);

    const ccC0 = charCount(await frameC.evaluate(() =>
        document.querySelector('#StateWordCount')?.textContent?.trim() || '').catch(() => ''));
    await snap(pageC, 'case2_C_after_open');
    console.log('  C after open: ' + ccC0 + ' chars (A had ' + ccA1 + ')');
    check('CASE2: C sees A content (within ±5)', Math.abs(ccC0 - ccA1) <= 5,
        'C=' + ccC0 + ' A=' + ccA1 + ' diff=' + Math.abs(ccC0 - ccA1));
    check('CASE2: C is NOT blank', ccC0 > 20, 'C=' + ccC0);

    await cleanupC();

    console.log('\n' + (allPassed ? '✓ ALL PASSED' : '✗ SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
