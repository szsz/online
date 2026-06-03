const __cl = require('../../lib/inject-checklist');
// Test: 2-browser PPTX (Impress) co-editing
// Verifies both browsers load the same pptx via relay and both have Impress UI.
// ALL input via real keyboard/mouse — no TheFakeWebSocket.send() calls.
//
// Migrated to the viewer flow (lib/open-via-viewer.js).
const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { openViaViewer, openSecretInBrowser } = require('../../lib/open-via-viewer');

const VIEWER = env.FILE_STORAGE_URL;
const TIMEOUT = env.scaleTimeout(300000);
const SHOT_DIR = '/tmp/static-deploy/public/shots-pptx-coedit';
const DOC_NAME = 'testdoc.pptx';
const DOC_PATH = path.join(__dirname, '..', 'test', 'data', DOC_NAME);

const T0 = Date.now();
function log(m) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const filename = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${filename}` }); } catch(e) {}
    log(`[snap] ${filename}`);
}

let allPassed = true;
function check(label, condition) { __cl.recordCheck(label, condition);
    if (condition) { log(`  ✓ ${label}`); }
    else { log(`  ✗ FAIL: ${label}`); allPassed = false; }
}

async function clickCanvas(page) {
    await page.mouse.click(640, 400);
    await sleep(500);
}

async function waitForImpress(frame, label) {
    log(`[${label}] Waiting for Impress...`);
    try {
        await frame.waitForFunction(() => {
            var overlay = document.getElementById('wasm-loading-overlay');
            if (overlay && overlay.style.opacity !== '0') return false;
            var nav = document.querySelector('nav.main-nav') || document.querySelector('#content-keeper');
            if (nav && nav.textContent && nav.textContent.includes('Slide Show')) return true;
            var thumbs = document.querySelectorAll('#slide-sorter img, #slide-sorter canvas');
            if (thumbs.length > 0) return true;
            return false;
        }, { timeout: TIMEOUT });
        await sleep(5000); // Let tiles render
        log(`[${label}] Impress loaded`);
        return true;
    } catch (e) {
        log(`[${label}] Timeout: ${e.message}`);
        return false;
    }
}

(async () => {
    log('=== PPTX 2-Browser Co-editing Test ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(DOC_PATH)) {
        log('ERROR: ' + DOC_PATH + ' not found');
        process.exit(1);
    }

    const { browser, cleanup } = await launch();

    try {
        const bytes = fs.readFileSync(DOC_PATH);

        log('\n--- Browser A ---');
        const upA = await openViaViewer(browser, VIEWER, DOC_NAME, bytes,
            { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
              isolatedContext: true });
        const pageA = upA.page, frameA = upA.editorFrame;
        const loadedA = await waitForImpress(frameA, 'A');
        check('Browser A: Impress loaded', loadedA);
        await snap(pageA, 'A_loaded');

        await sleep(5000);

        log('\n--- Browser B ---');
        const upB = await openSecretInBrowser(browser, VIEWER, upA.b64urlSecret,
            { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
              isolatedContext: true });
        const pageB = upB.page, frameB = upB.editorFrame;
        const loadedB = await waitForImpress(frameB, 'B');
        check('Browser B: Impress loaded', loadedB);
        await snap(pageB, 'B_loaded');

        log('\n--- Settling ---');
        await sleep(15000);

        log('\n--- Browser A: typing ---');
        await clickCanvas(pageA);
        await pageA.mouse.click(640, 400, { clickCount: 2 });
        await sleep(3000);

        for (const ch of 'AAA') {
            await pageA.keyboard.type(ch, { delay: 50 });
            await sleep(1000);
        }
        log('[A] Typed AAA');
        await sleep(5000);
        await snap(pageA, 'A_after_AAA');
        await snap(pageB, 'B_after_AAA');

        log('\n--- Browser B: typing ---');
        await clickCanvas(pageB);
        await pageB.mouse.click(640, 400, { clickCount: 2 });
        await sleep(3000);

        for (const ch of 'BBB') {
            await pageB.keyboard.type(ch, { delay: 50 });
            await sleep(1000);
        }
        log('[B] Typed BBB');
        await sleep(5000);
        await snap(pageA, 'A_after_BBB');
        await snap(pageB, 'B_after_BBB');

        // Final check - both still have Impress UI
        const uiA = await frameA.evaluate(() => {
            var el = document.querySelector('nav.main-nav') || document.querySelector('#content-keeper');
            return el && el.textContent && el.textContent.includes('Slide Show');
        });
        const uiB = await frameB.evaluate(() => {
            var el = document.querySelector('nav.main-nav') || document.querySelector('#content-keeper');
            return el && el.textContent && el.textContent.includes('Slide Show');
        });
        check('A: Impress UI intact', uiA);
        check('B: Impress UI intact', uiB);

        await snap(pageA, 'A_final');
        await snap(pageB, 'B_final');

        log('\n' + (allPassed ? '✓ ALL PPTX CO-EDITING CHECKS PASSED' : '✗ SOME CHECKS FAILED'));

    } catch (e) {
        log('Error: ' + e.message);
        allPassed = false;
    } finally {
        await cleanup();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
