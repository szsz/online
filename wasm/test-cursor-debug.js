const __cl = require('./lib/inject-checklist');
// Co-editing test: 2 browsers typing via real keyboard, verify convergence.
// ALL input via keyboard/mouse — no TheFakeWebSocket.send() calls.
// Expected: "ABCHello WorldXYZ" = 17 chars, identical on both browsers.
//
// Migrated to the viewer flow (lib/open-via-viewer.js).
const { launch, sleep } = require('./lib/browser');
const fs = require('fs');
const env = require('./lib/test-env');
const { openViaViewer, openSecretInBrowser } = require('./lib/open-via-viewer');

const VIEWER = env.FILE_STORAGE_URL;
const TIMEOUT = env.scaleTimeout(300000);
const SHOT_DIR = '/tmp/static-deploy/public/shots';

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await sleep(500);
    const filename = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
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

(async () => {
    console.log('=== Co-editing: real keyboard input, content verification ===\n');

    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const { browser, cleanup } = await launch();

    let allPassed = true;
    function check(label, condition) {
        __cl.recordCheck(label, condition);
        if (condition) console.log(`  ✓ ${label}`);
        else { console.log(`  ✗ FAIL: ${label}`); allPassed = false; }
    }

    try {
        const docName = 'cotest-' + Date.now() + '.txt';
        const bytes = Buffer.from('Hello World', 'utf8');

        console.log('[A] Opening...');
        const { page: pageA, editorFrame: frameA, b64urlSecret } =
            await openViaViewer(browser, VIEWER, docName, bytes,
                { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
                  isolatedContext: true });
        await waitForCharCount(frameA, 11, TIMEOUT);
        console.log(`[A] Loaded: "${await getStatus(frameA)}"`);
        await sleep(10000);

        console.log('[B] Opening...');
        const { page: pageB, editorFrame: frameB } =
            await openSecretInBrowser(browser, VIEWER, b64urlSecret,
                { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
                  isolatedContext: true });
        await waitForCharCount(frameB, 11, TIMEOUT);
        console.log(`[B] Loaded: "${await getStatus(frameB)}"`);
        await sleep(15000);

        await snap(pageA, 'A_initial');
        await snap(pageB, 'B_initial');
        check('Initial: both 11 chars',
            charCount(await getStatus(frameA)) === 11 &&
            charCount(await getStatus(frameB)) === 11);

        async function clickCanvas(page) {
            await page.mouse.click(640, 400);
            await sleep(500);
        }

        console.log('\n=== Typing ===\n');
        await sleep(2000);

        // Phase 1: A types ABC at cursor position 0 (real keyboard)
        await clickCanvas(pageA);
        for (const ch of ['A', 'B', 'C']) {
            console.log(`\n[A] Types "${ch}"...`);
            await pageA.keyboard.type(ch, { delay: 50 });
            const expected = 11 + 'ABC'.indexOf(ch) + 1;
            await sleep(8000);
            await snap(pageA, `A_after_${ch}`);
            await snap(pageB, `B_after_${ch}`);
            const sA = await getStatus(frameA);
            const sB = await getStatus(frameB);
            check(`After "${ch}": B=${charCount(sB)} (expected ${expected})`,
                charCount(sB) === expected);
            console.log(`  A="${sA}"  B="${sB}"`);
        }

        // Wait for convergence
        console.log('\n[wait] 10s for A to converge...');
        await sleep(10000);
        let convA = await getStatus(frameA);
        let convB = await getStatus(frameB);
        console.log(`[converge] A="${convA}" B="${convB}"`);
        check('Both at 14 after ABC', charCount(convA) === 14 && charCount(convB) === 14);

        // Phase 2: B moves to end (Ctrl+End) and types XYZ (real keyboard)
        console.log('\n[B] Ctrl+End');
        await clickCanvas(pageB);
        await pageB.keyboard.down('Control');
        await pageB.keyboard.press('End');
        await pageB.keyboard.up('Control');
        await sleep(3000);

        for (const ch of ['X', 'Y', 'Z']) {
            console.log(`\n[B] Types "${ch}"...`);
            await pageB.keyboard.type(ch, { delay: 50 });
            const expected = 14 + 'XYZ'.indexOf(ch) + 1;
            await sleep(8000);
            await snap(pageA, `A_after_${ch}`);
            await snap(pageB, `B_after_${ch}`);
            const sA = await getStatus(frameA);
            const sB = await getStatus(frameB);
            check(`After "${ch}": A=${charCount(sA)} (expected ${expected})`,
                charCount(sA) === expected);
            console.log(`  A="${sA}"  B="${sB}"`);
        }

        // Final
        console.log('\n[wait] 10s settle...');
        await sleep(10000);
        await snap(pageA, 'A_final');
        await snap(pageB, 'B_final');
        const fA = await getStatus(frameA);
        const fB = await getStatus(frameB);
        console.log(`\n[final] A="${fA}"  B="${fB}"`);
        check('Final: both 17 chars', charCount(fA) === 17 && charCount(fB) === 17);

        console.log('\n' + (allPassed ? '✓ ALL CHECKS PASSED' : '✗ SOME CHECKS FAILED'));

    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        await cleanup();
        console.log('\nDone.');
        process.exit(allPassed ? 0 : 1);
    }
})();
