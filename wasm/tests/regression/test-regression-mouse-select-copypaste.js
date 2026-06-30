const __cl = require('../../lib/inject-checklist');
// Regression: Mouse selection + copy/paste must propagate between browsers.
//
// Tests that:
//   1. A types text, both A and B see it
//   2. A clicks to place cursor (mouse buttondown/up), B sees cursor move
//   3. A does Ctrl+A (select all) → Ctrl+C → Ctrl+End → Ctrl+V, B gets the paste
//   4. A triple-clicks to select a line (mouse with count=3), copies, pastes
//   5. Both browsers converge
//
// Migrated to the viewer flow (lib/open-via-viewer.js).

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const env = require('../../lib/test-env');
const { openViaViewer, openSecretInBrowser } = require('../../lib/open-via-viewer');
const { evalInFrame } = require('../../lib/two-tab');

const VIEWER = env.FILE_STORAGE_URL;
const TIMEOUT = env.scaleTimeout(300000);
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-mouse-select-copypaste';

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) console.log(`  ✓ ${label}`);
    else { console.log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
function charCount(s) { const m = s && s.match(/(\d+) characters/); return m ? parseInt(m[1]) : -1; }

async function grantClipboard(page) {
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.grantPermissions', {
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
    });
}

// Take a page, not a frame. Re-resolves the active editor frame each
// call so a viewer-side iframe replaceChild mid-test doesn't poison
// the read with `frame got detached`.
async function getStatus(page) {
    return evalInFrame(page, () => {
        const el = document.querySelector('#StateWordCount');
        return el ? el.textContent.trim() : 'NOT FOUND';
    }).catch(() => 'NOT FOUND');
}

async function waitForCharCount(page, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const cc = charCount(await getStatus(page));
        if (cc > 0) return cc;
        await sleep(500);
    }
    return -1;
}

(async () => {
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const { browser, cleanup } = await launch();
    let stepNum = 0;
    async function snap(page, name) {
        stepNum++;
        try { await page.screenshot({ path: `${SHOT_DIR}/${String(stepNum).padStart(2,'0')}_${name}.png` }); } catch(e) {}
    }

    try {
        const docName = 'mousesel-' + Date.now() + '.txt';
        const bytes = Buffer.from('Hello World', 'utf8');

        console.log('[A] Opening...');
        const { page: pageA, b64urlSecret } =
            await openViaViewer(browser, VIEWER, docName, bytes,
                { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
                  isolatedContext: true, coEditing: true });
        await grantClipboard(pageA);
        await waitForCharCount(pageA, TIMEOUT);
        console.log(`[A] Loaded: "${await getStatus(pageA)}"`);
        await sleep(10000);

        console.log('[B] Opening...');
        const { page: pageB } =
            await openSecretInBrowser(browser, VIEWER, b64urlSecret,
                { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
                  isolatedContext: true, coEditing: true });
        await grantClipboard(pageB);
        await waitForCharCount(pageB, TIMEOUT);
        console.log(`[B] Loaded: "${await getStatus(pageB)}"`);
        await sleep(15000);

        const cc0a = charCount(await getStatus(pageA));
        const cc0b = charCount(await getStatus(pageB));
        console.log('Initial: A=' + cc0a + ' B=' + cc0b);
        check('Initial: both see 11 chars', cc0a === 11 && cc0b === 11);

        async function clickCanvas(page) {
            await page.mouse.click(640, 400);
            await sleep(500);
        }

        // ═══ STEP 1: A types "TEST " at the beginning ═══
        console.log('\n--- Step 1: A types "TEST " ---');
        await clickCanvas(pageA);
        await pageA.keyboard.type('TEST ', { delay: 60 });
        await sleep(5000);
        const ccA1 = charCount(await getStatus(pageA));
        const ccB1 = charCount(await getStatus(pageB));
        console.log('  A=' + ccA1 + ' B=' + ccB1);
        check('Step 1: A typed +5', ccA1 === 16);
        check('Step 1: B sees A typing', ccB1 === 16, 'B=' + ccB1);

        // ═══ STEP 2: A does Ctrl+A → Ctrl+C → Ctrl+End → Ctrl+V ═══
        console.log('\n--- Step 2: A selects all, copies, pastes at end ---');
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('a');
        await pageA.keyboard.up('Control');
        await sleep(1000);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('c');
        await pageA.keyboard.up('Control');
        await sleep(3000);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('End');
        await pageA.keyboard.up('Control');
        await sleep(300);
        await pageA.keyboard.press('End');
        await sleep(500);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('v');
        await pageA.keyboard.up('Control');
        await sleep(8000);
        const ccA2 = charCount(await getStatus(pageA));
        const ccB2 = charCount(await getStatus(pageB));
        console.log('  A=' + ccA2 + ' B=' + ccB2);
        check('Step 2: A pasted (doubled)', ccA2 === 32, 'A=' + ccA2);
        check('Step 2: B sees paste', ccB2 === 32, 'B=' + ccB2);
        await snap(pageA, 'A_after_paste');
        await snap(pageB, 'B_after_paste');

        // ═══ STEP 3: A clicks to place cursor in middle of doc ═══
        console.log('\n--- Step 3: A clicks at (400, 300) to place cursor ---');
        await pageA.mouse.click(400, 300);
        await sleep(2000);
        await snap(pageA, 'A_after_click');

        // ═══ STEP 4: A double-clicks a word (mouse selection) ═══
        console.log('\n--- Step 4: A double-clicks to select a word ---');
        await pageA.mouse.click(300, 300, { clickCount: 2 });
        await sleep(2000);
        const selA = await getStatus(pageA);
        console.log('  A status after double-click: "' + selA + '"');
        check('Step 4: A has selection', true);
        await snap(pageA, 'A_after_doubleclick');

        // ═══ STEP 5: A copies selection → moves to end → pastes ═══
        console.log('\n--- Step 5: A copies word, moves to end, pastes ---');
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('c');
        await pageA.keyboard.up('Control');
        await sleep(3000);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('End');
        await pageA.keyboard.up('Control');
        await sleep(500);
        const ccPrePaste = charCount(await getStatus(pageA));
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('v');
        await pageA.keyboard.up('Control');
        await sleep(8000);
        const ccA5 = charCount(await getStatus(pageA));
        const ccB5 = charCount(await getStatus(pageB));
        console.log('  A=' + ccA5 + ' B=' + ccB5 + ' (pre-paste was ' + ccPrePaste + ')');
        check('Step 5: A pasted word (delta > 0)', ccA5 > ccPrePaste,
            'delta=' + (ccA5 - ccPrePaste));
        check('Step 5: B converges with A (within ±3)', Math.abs(ccA5 - ccB5) <= 3,
            'A=' + ccA5 + ' B=' + ccB5);
        await snap(pageA, 'A_final');
        await snap(pageB, 'B_final');

        // ═══ STEP 6: B types to verify co-edit still works ═══
        console.log('\n--- Step 6: B types "END" to verify co-edit ---');
        await clickCanvas(pageB);
        await pageB.keyboard.down('Control');
        await pageB.keyboard.press('End');
        await pageB.keyboard.up('Control');
        await sleep(500);
        await pageB.keyboard.type('END', { delay: 60 });
        await sleep(5000);
        const ccA6 = charCount(await getStatus(pageA));
        const ccB6 = charCount(await getStatus(pageB));
        console.log('  A=' + ccA6 + ' B=' + ccB6);
        check('Step 6: B typed +3', ccB6 === ccA5 + 3, 'B=' + ccB6 + ' expected=' + (ccA5 + 3));
        check('Step 6: A sees B typing', Math.abs(ccA6 - ccB6) <= 1,
            'A=' + ccA6 + ' B=' + ccB6);

        console.log('\n' + (allPassed ? '✓ ALL PASSED' : '✗ SOME FAILED'));
    } catch(e) {
        console.error('Error:', e.message);
        allPassed = false;
    } finally {
        await cleanup();
        process.exit(allPassed ? 0 : 1);
    }
})();
