const __cl = require('./lib/inject-checklist');
// Regression test: per-tab browser-context isolation for co-edit.
//
// Background: when two pages open the same file inside the SAME
// browser context (siblings in the default Puppeteer browser or two
// tabs of the same real browser window), they share localStorage and
// the viewer derives the same client identity from it — the relay
// then sees A and B as the same client and dedups their own events.
// Co-edit appears one-directional: B sees A's typing only via local
// state-sharing artefacts, not via the relay; A's local view never
// updates from its own keystrokes because the relay never echoes
// them back.
//
// The fix is in the test infrastructure: every co-edit test passes
// `isolatedContext: true` to lib/open-via-viewer.js, which creates a
// fresh `browser.createBrowserContext()` per simulated user.
//
// This test demonstrates the contrast: separate-context co-edit
// converges cleanly, shared-context does not.
//
// Migrated to the viewer flow (lib/open-via-viewer.js).
'use strict';

const { launch, sleep } = require('./lib/browser');
const fs = require('fs');
const env = require('./lib/test-env');
const { openViaViewer, openSecretInBrowser } = require('./lib/open-via-viewer');

const VIEWER = env.FILE_STORAGE_URL;
const TIMEOUT = env.scaleTimeout(180000);
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-sab';

const T0 = Date.now();
function log(m) { console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2,'0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch(e) {}
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
        return el ? el.textContent.trim() : 'NOT FOUND';
    });
}
function charCount(s) {
    const m = (s||'').match(/(\d+) characters/);
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

async function typeAt(page, text) {
    await page.mouse.click(640, 400);
    await sleep(500);
    for (const ch of text) {
        await page.keyboard.type(ch, { delay: 50 });
        await sleep(1500);
    }
}

(async () => {
    log('=== Regression: per-tab browser-context isolation ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const { browser, cleanup } = await launch();

    try {
        // ──────────────────────────────────────────────────────────
        // GOOD path: openSecretInBrowser with isolatedContext: true.
        // ──────────────────────────────────────────────────────────
        log('\n--- Scenario A: isolatedContext = true (the fix) ---');
        const docName = 'sab-good-' + Date.now() + '.txt';
        const bytes = Buffer.from('Hello', 'utf8');     // 5 chars

        const upGoodA = await openViaViewer(browser, VIEWER, docName, bytes,
            { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
              isolatedContext: true });
        await waitForCharCount(upGoodA.editorFrame, 5, TIMEOUT);
        log(`[GOOD-A] Loaded: "${await getStatus(upGoodA.editorFrame)}"`);
        await sleep(8000);

        const upGoodB = await openSecretInBrowser(browser, VIEWER, upGoodA.b64urlSecret,
            { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
              isolatedContext: true });
        await waitForCharCount(upGoodB.editorFrame, 5, TIMEOUT);
        log(`[GOOD-B] Loaded: "${await getStatus(upGoodB.editorFrame)}"`);
        await sleep(15000);

        await snap(upGoodA.page, 'iso_A_initial');
        await snap(upGoodB.page, 'iso_B_initial');

        log('[GOOD-A] Typing "XYZ"');
        await typeAt(upGoodA.page, 'XYZ');
        // Wait up to 30s for B to converge — relay propagation can lag
        // on cold-start runs against wasm-viewer-test.
        await waitForCharCount(upGoodB.editorFrame, 8, 30000);
        const isoFinalA = charCount(await getStatus(upGoodA.editorFrame));
        const isoFinalB = charCount(await getStatus(upGoodB.editorFrame));
        await snap(upGoodA.page, 'iso_A_after_xyz');
        await snap(upGoodB.page, 'iso_B_after_xyz');
        log(`Separate contexts: A=${isoFinalA} B=${isoFinalB} (expected 8 = "Hello"+XYZ)`);
        check('Separate contexts: A reaches 8 chars', isoFinalA === 8, 'A=' + isoFinalA);
        check('Separate contexts: B converges to A',
              isoFinalA === 8 && isoFinalB === 8, `A=${isoFinalA} B=${isoFinalB}`);

        await upGoodA.page.close();
        await upGoodB.page.close();
        if (upGoodA.context) await upGoodA.context.close();
        if (upGoodB.context) await upGoodB.context.close();

        // ──────────────────────────────────────────────────────────
        // BAD path: two openSecretInBrowser calls SHARING the default
        // browser context. They share localStorage; the viewer
        // derives the same client identity from it, so the relay
        // dedups A and B as one client. A's typing does NOT show up
        // on A's own status bar (relay doesn't echo back); B's shows
        // a stale value from the shared localStorage.
        // ──────────────────────────────────────────────────────────
        log('\n--- Scenario B: shared context (the bug) ---');
        const docNameBad = 'sab-bad-' + Date.now() + '.txt';

        const upBadA = await openViaViewer(browser, VIEWER, docNameBad, bytes,
            { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000) });
            // ^ no isolatedContext — falls into default browser context
        await waitForCharCount(upBadA.editorFrame, 5, TIMEOUT);
        log(`[BAD-A] Loaded: "${await getStatus(upBadA.editorFrame)}"`);
        await sleep(8000);

        const upBadB = await openSecretInBrowser(browser, VIEWER, upBadA.b64urlSecret,
            { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000) });
            // ^ no isolatedContext — same default browser context as A
        await waitForCharCount(upBadB.editorFrame, 5, TIMEOUT);
        log(`[BAD-B] Loaded: "${await getStatus(upBadB.editorFrame)}"`);
        await sleep(15000);

        await snap(upBadA.page, 'shared_A_initial');
        await snap(upBadB.page, 'shared_B_initial');

        log('[BAD-A] Typing "XYZ"');
        await typeAt(upBadA.page, 'XYZ');
        // Same 30s budget as Scenario A so a slow relay doesn't fake a
        // win for the bug. If sharing the context broke things, A=8/B=8
        // will not happen within 30s either.
        await waitForCharCount(upBadA.editorFrame, 8, 30000);
        const badFinalA = charCount(await getStatus(upBadA.editorFrame));
        const badFinalB = charCount(await getStatus(upBadB.editorFrame));
        await snap(upBadA.page, 'shared_A_after_xyz');
        await snap(upBadB.page, 'shared_B_after_xyz');
        log(`Shared context: A=${badFinalA} B=${badFinalB}`);

        // The bug manifests as A and B NOT converging to 8 (the
        // relay-dedup symptom we saw during the initial helper bring-up).
        const sharedBroken = !(badFinalA === 8 && badFinalB === 8);
        check('Shared context: co-edit is broken (proof the contrast matters)',
              sharedBroken,
              `A=${badFinalA} B=${badFinalB}`);

        await upBadA.page.close();
        await upBadB.page.close();

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
