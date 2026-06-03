const __cl = require('../../lib/inject-checklist');
// Regression test: Delete key edits in browser A must reach browser B.
//
// User-reported bug: pressing Delete in one browser does not propagate to
// the other browser.
//
// ALL input via real keyboard/mouse — no TheFakeWebSocket.send() calls.
// Migrated to the viewer flow (lib/open-via-viewer.js).
const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const env = require('../../lib/test-env');
const { openViaViewer, openSecretInBrowser } = require('../../lib/open-via-viewer');

const VIEWER = env.FILE_STORAGE_URL;
const TIMEOUT = env.scaleTimeout(300000);
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-delete-key';

const T0 = Date.now();
function log(m) { console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await sleep(300);
    const f = `${String(++shotNum).padStart(2,'0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch(e) {}
    log(`[snap] ${f}`);
}

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}${ev?' ['+ev+']':''}`); allPassed = false; }
}

async function getStatus(frame) {
    return frame.evaluate(() => {
        const el = document.querySelector('#StateWordCount');
        return el ? el.textContent.trim() : '';
    });
}
function charCount(status) {
    const m = status && status.match(/(\d+) characters/);
    return m ? parseInt(m[1]) : -1;
}
async function waitForCharCount(frame, expected, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (charCount(await getStatus(frame)) === expected) return Date.now() - t0;
        await sleep(250);
    }
    return -1;
}

// Click the editor canvas to focus it
async function clickCanvas(page) {
    await page.mouse.click(640, 400);
    await sleep(500);
}

(async () => {
    log('=== Regression: Delete key must propagate via relay ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const { browser, cleanup } = await launch();

    try {
        const docName = 'delkey-' + Date.now() + '.txt';
        const bytes = Buffer.from('Hello World', 'utf8');     // 11 chars

        log('[A] Opening...');
        const { page: pageA, editorFrame: frameA, b64urlSecret } =
            await openViaViewer(browser, VIEWER, docName, bytes,
                { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
                  isolatedContext: true });
        await waitForCharCount(frameA, 11, TIMEOUT);
        log(`[A] Loaded: "${await getStatus(frameA)}"`);
        await sleep(8000);

        log('[B] Opening...');
        const { page: pageB, editorFrame: frameB } =
            await openSecretInBrowser(browser, VIEWER, b64urlSecret,
                { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
                  isolatedContext: true });
        await waitForCharCount(frameB, 11, TIMEOUT);
        log(`[B] Loaded: "${await getStatus(frameB)}"`);
        await sleep(15000);

        await snap(pageA, 'A_initial');
        await snap(pageB, 'B_initial');
        const initA = charCount(await getStatus(frameA));
        const initB = charCount(await getStatus(frameB));
        log(`Initial: A=${initA} B=${initB}`);
        check('Both browsers see "Hello World" (11 chars)',
              initA === 11 && initB === 11);

        // ── A: position cursor at position 6 and press Delete ──────
        // Ctrl+Home moves to start, then Right x6 puts cursor at
        // "Hello |World". Delete removes the 'W'.
        log('\n--- A: move cursor to position 6, press Delete ---');
        await clickCanvas(pageA);

        // Ctrl+Home to go to start of document
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('Home');
        await pageA.keyboard.up('Control');
        await sleep(800);

        // Right arrow x6 to position cursor at "Hello |World"
        for (let i = 0; i < 6; i++) {
            await pageA.keyboard.press('ArrowRight');
            await sleep(120);
        }
        await sleep(800);
        await snap(pageA, 'A_at_position_6');

        // Press Delete key (real keyboard input)
        await pageA.keyboard.press('Delete');
        log('A: pressed Delete key');

        // ── Wait for the delete to propagate to B ───────────────────
        const target = 10;
        log(`Waiting for B to drop to ${target} chars...`);
        const tookB = await waitForCharCount(frameB, target, 30000);
        const tookA = await waitForCharCount(frameA, target, 30000);
        await snap(pageA, 'A_after_delete');
        await snap(pageB, 'B_after_delete');
        const finalA = charCount(await getStatus(frameA));
        const finalB = charCount(await getStatus(frameB));
        log(`Final: A=${finalA} (took ${tookA}ms), B=${finalB} (took ${tookB}ms)`);

        check('A reflects the deletion locally (10 chars left)',
              finalA === target,
              'expected ' + target + ' got ' + finalA);
        check('B reflects A\'s Delete-key edit (THE bug — currently fails)',
              finalB === target,
              'expected ' + target + ' got ' + finalB +
              (finalB === 11 ? ' — peer never saw the deletion (removetextcontext bypassed the relay)' : ''));
        check('A and B converge to the same character count',
              finalA === finalB && finalA > 0,
              'A=' + finalA + ' B=' + finalB);

        log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    } catch (e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        await cleanup();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
