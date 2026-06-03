const __cl = require('./lib/inject-checklist');
// Test: 3 browsers co-editing via relay.
// Document: "Hello World" (1 line)
// A types "ABC" at start, B types "XYZ" at end, C types "PQR" in middle
// Expected: "ABCHelloPQR WorldXYZ" = 20 chars
// ALL input via real keyboard/mouse — no TheFakeWebSocket.send() calls.
//
// Migrated to the viewer flow (lib/open-via-viewer.js).
const { launch, sleep } = require('./lib/browser');
const fs = require('fs');
const env = require('./lib/test-env');
const { openViaViewer, openSecretInBrowser } = require('./lib/open-via-viewer');

const VIEWER = env.FILE_STORAGE_URL;
const TIMEOUT = env.scaleTimeout(300000);
const SHOT_DIR = '/tmp/static-deploy/public/shots3';

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await sleep(500);
    const filename = `${String(++shotNum).padStart(2,'0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${filename}` }); } catch(e) {}
    console.log(`  [snap] ${filename}`);
}

async function getStatus(frame) {
    return frame.evaluate(() => {
        const el = document.querySelector('#StateWordCount');
        return el ? el.textContent.trim() : 'NOT FOUND';
    });
}

function charCount(status) {
    const m = (status||'').match(/(\d+) characters/);
    return m ? parseInt(m[1]) : -1;
}

async function waitForCharCount(frame, expected, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (charCount(await getStatus(frame)) === expected) return true;
        await sleep(500);
    }
    return false;
}

async function waitForAnyCharCount(frames, expected, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
        for (const f of frames) {
            if (charCount(await getStatus(f)) === expected) return true;
        }
        await sleep(500);
    }
    return false;
}

(async () => {
    console.log('=== Test 3: 3 Browsers, 1 line, ABC/PQR/XYZ ===\n');

    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const { browser, cleanup } = await launch();

    let allPassed = true;
    function check(label, condition) { __cl.recordCheck(label, condition);
        if (condition) {
            console.log(`  ✓ ${label}`);
        } else {
            console.log(`  ✗ FAIL: ${label}`);
            allPassed = false;
        }
    }

    try {
        const docName = 'test3-' + Date.now() + '.txt';
        const bytes = Buffer.from('Hello World', 'utf8');

        console.log('[A] Opening...');
        const upA = await openViaViewer(browser, VIEWER, docName, bytes,
            { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
              isolatedContext: true });
        const pageA = upA.page, frameA = upA.editorFrame;
        await waitForCharCount(frameA, 11, TIMEOUT);
        console.log(`[A] Loaded: "${await getStatus(frameA)}"`);
        await sleep(10000);

        console.log('[B] Opening...');
        const upB = await openSecretInBrowser(browser, VIEWER, upA.b64urlSecret,
            { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
              isolatedContext: true });
        const pageB = upB.page, frameB = upB.editorFrame;
        await waitForCharCount(frameB, 11, TIMEOUT);
        console.log(`[B] Loaded: "${await getStatus(frameB)}"`);
        await sleep(10000);

        console.log('[C] Opening...');
        const upC = await openSecretInBrowser(browser, VIEWER, upA.b64urlSecret,
            { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
              isolatedContext: true });
        const pageC = upC.page, frameC = upC.editorFrame;
        await waitForCharCount(frameC, 11, TIMEOUT);
        console.log(`[C] Loaded: "${await getStatus(frameC)}"`);
        await sleep(15000);

        await snap(pageA, 'A_initial');
        await snap(pageB, 'B_initial');
        await snap(pageC, 'C_initial');
        check('Initial: all 11 chars',
            charCount(await getStatus(frameA)) === 11 &&
            charCount(await getStatus(frameB)) === 11 &&
            charCount(await getStatus(frameC)) === 11);

        async function clickCanvas(page) {
            await page.mouse.click(640, 400);
            await sleep(500);
        }

        console.log('\n=== Phase 1: A types ABC at start ===\n');
        await sleep(2000);
        await clickCanvas(pageA);

        for (const ch of ['A', 'B', 'C']) {
            console.log(`[A] Types "${ch}"...`);
            await pageA.keyboard.type(ch, { delay: 50 });
            await sleep(8000);
            const expected = 11 + 'ABC'.indexOf(ch) + 1;
            await waitForAnyCharCount([frameA, frameB, frameC], expected, 5000);
            const sA = await getStatus(frameA);
            const sB = await getStatus(frameB);
            const sC = await getStatus(frameC);
            console.log(`  A="${sA}" B="${sB}" C="${sC}"`);
        }

        console.log('\n[wait] 10s convergence...');
        await sleep(10000);
        await snap(pageA, 'A_after_ABC');
        await snap(pageB, 'B_after_ABC');
        await snap(pageC, 'C_after_ABC');
        let sA = await getStatus(frameA);
        let sB = await getStatus(frameB);
        let sC = await getStatus(frameC);
        console.log(`[converge] A="${sA}" B="${sB}" C="${sC}"`);
        check('All at 14 after ABC',
            charCount(sA) === 14 && charCount(sB) === 14 && charCount(sC) === 14);

        // Phase 2: B types XYZ at end
        console.log('\n=== Phase 2: B types XYZ at end ===\n');
        console.log('[B] Ctrl+End');
        await clickCanvas(pageB);
        await pageB.keyboard.down('Control');
        await pageB.keyboard.press('End');
        await pageB.keyboard.up('Control');
        await sleep(3000);

        for (const ch of ['X', 'Y', 'Z']) {
            console.log(`[B] Types "${ch}"...`);
            await pageB.keyboard.type(ch, { delay: 50 });
            await sleep(8000);
            const expected = 14 + 'XYZ'.indexOf(ch) + 1;
            await waitForAnyCharCount([frameA, frameB, frameC], expected, 5000);
            const sA = await getStatus(frameA);
            const sB = await getStatus(frameB);
            const sC = await getStatus(frameC);
            console.log(`  A="${sA}" B="${sB}" C="${sC}"`);
        }

        console.log('\n[wait] 10s convergence...');
        await sleep(10000);
        await snap(pageA, 'A_after_XYZ');
        await snap(pageB, 'B_after_XYZ');
        await snap(pageC, 'C_after_XYZ');
        sA = await getStatus(frameA);
        sB = await getStatus(frameB);
        sC = await getStatus(frameC);
        console.log(`[converge] A="${sA}" B="${sB}" C="${sC}"`);
        check('All at 17 after XYZ',
            charCount(sA) === 17 && charCount(sB) === 17 && charCount(sC) === 17);

        // Phase 3: C types PQR in middle
        console.log('\n=== Phase 3: C types PQR in middle ===\n');
        console.log('[C] Click middle of document');
        await pageC.mouse.click(500, 400);
        await sleep(3000);

        for (const ch of ['P', 'Q', 'R']) {
            console.log(`[C] Types "${ch}"...`);
            await pageC.keyboard.type(ch, { delay: 50 });
            await sleep(8000);
            const expected = 17 + 'PQR'.indexOf(ch) + 1;
            await waitForAnyCharCount([frameA, frameB, frameC], expected, 5000);
            const sA = await getStatus(frameA);
            const sB = await getStatus(frameB);
            const sC = await getStatus(frameC);
            console.log(`  A="${sA}" B="${sB}" C="${sC}"`);
        }

        console.log('\n[wait] 10s final settle...');
        await sleep(10000);
        await snap(pageA, 'A_final');
        await snap(pageB, 'B_final');
        await snap(pageC, 'C_final');
        sA = await getStatus(frameA);
        sB = await getStatus(frameB);
        sC = await getStatus(frameC);
        console.log(`\n[final] A="${sA}" B="${sB}" C="${sC}"`);
        check('All at 20 chars',
            charCount(sA) === 20 && charCount(sB) === 20 && charCount(sC) === 20);

        console.log('\n' + (allPassed ? '✓ ALL CHECKS PASSED' : '✗ SOME CHECKS FAILED'));

    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        await cleanup();
        console.log('\nDone.');
        process.exit(allPassed ? 0 : 1);
    }
})();
