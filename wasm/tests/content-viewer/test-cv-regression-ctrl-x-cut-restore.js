// test-cv-regression-ctrl-x-cut-restore.js — Ctrl+X on selection → Ctrl+V
// restores the cut content, through the Tresorit content-viewer
// (/collabora-tester).
//
// TRIPWIRE — expected to FAIL while the LO-side .uno:Cut bug is present
// (tracked at ai/proposals/promoted/ctrl-x-isolated-single-user-clipboard.md,
// Bucket A in copy-paste-master). Bug shape: kit's .uno:Cut handler removes
// the selected content from the document but does NOT write it to the OS
// clipboard. In multi-case runs an earlier Ctrl+C leaves valid clipboard
// content and the paste PASSES accidentally; ISOLATED (fresh browser per
// invocation, as here), Ctrl+V has nothing useful on the clipboard and the
// assert fails. Once the LO fix lands, this test auto-passes.
//
// Shape (real puppeteer mouse + keyboard — no sendUnoCommand, no
// app.dispatcher.dispatch, no page.evaluate(()=>el.click())):
//   1. Open new.docx via the tester upload (single-user mode).
//   2. Click into doc body, type "cut-test-abc".
//   3. Ctrl+Home, Shift+ArrowRight ×3 to select 3 chars.
//   4. Ctrl+X — assert character count dropped by ≥3.
//   5. Ctrl+V — assert character count restored to pre-cut state.
//
// Migrated from wasm/tests/regression/test-regression-ctrl-x-cut-restore.js
// — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-ctrl-x-cut-restore.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const {
    openBytesViaContentViewer, waitCvInteractive,
    cvCharCount, waitCvCharCount,
} = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/regression-ctrl-x-cut-restore';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
let shotN = 0;
async function snap(page, name) {
    try {
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${SHOT_DIR}/${String(++shotN).padStart(2, '0')}_${name}.png` });
    } catch (e) {}
}

async function pressCtrl(page, key) {
    await page.keyboard.down('Control');
    await page.keyboard.press(key);
    await page.keyboard.up('Control');
    await sleep(150);
}

(async () => {
    log('=== Regression (TRIPWIRE): Ctrl+X cut → Ctrl+V restores ===');
    if (!fs.existsSync(FIXTURE)) { log('ERROR: fixture missing: ' + FIXTURE); process.exit(1); }
    log('viewer: ' + BASE);
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    const { browser, cleanup } = await launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        const cdp = await page.target().createCDPSession();
        try {
            await cdp.send('Browser.grantPermissions', {
                permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
            });
        } catch (e) { /* older Chrome */ }

        log('open writer via /collabora-tester');
        const bytes = fs.readFileSync(FIXTURE);
        await openBytesViaContentViewer(browser, BASE,
            'ctrl-x-' + Date.now() + '.docx', bytes, { page, iframeTimeout: 60000 });
        check('editor became interactive (Save enabled)', await waitCvInteractive(page, LOAD_BUDGET));
        const baseChars = await waitCvCharCount(page, c => c >= 0, 60000);
        log('Editor ready, baseline chars=' + baseChars);
        await sleep(3000);
        await snap(page, 'editor_ready');

        // Type a deterministic phrase the cut will operate on.
        const iframeEl = await page.$('iframe');
        const ifBox = await iframeEl.boundingBox();
        await page.mouse.click(ifBox.x + ifBox.width / 2,
            ifBox.y + Math.min(ifBox.height * 0.55, 450));
        await sleep(1000);

        const PHRASE = 'cut-test-abc';
        for (const ch of PHRASE) {
            await page.keyboard.type(ch);
            await sleep(30);
        }
        const targetChars = baseChars >= 0 ? baseChars + PHRASE.length : PHRASE.length;
        const afterType = await waitCvCharCount(page, c => c >= targetChars, 20000);
        log('after-type chars=' + afterType);
        check('Typed "' + PHRASE + '"', afterType >= targetChars,
            'expected≥' + targetChars + ' got=' + afterType);
        await snap(page, 'after_type');

        // Ctrl+Home, then Shift+ArrowRight ×3 to select 3 chars.
        await pressCtrl(page, 'Home');
        await sleep(800);
        for (let i = 0; i < 3; i++) {
            await page.keyboard.down('Shift');
            await page.keyboard.press('ArrowRight');
            await page.keyboard.up('Shift');
            await sleep(50);
        }
        await sleep(800);
        await snap(page, 'after_select');

        // NOTE (2026-06-12): with an active selection, #StateWordCount shows
        // "Selected: … N characters", so reading it HERE returns the
        // SELECTION size, not the doc total. Use the after-type total
        // captured above as the authoritative before-cut count.
        const beforeCut = afterType;
        log('before-cut chars=' + beforeCut + ' (from after-type total)');

        // Ctrl+X: cut the selection. The selection collapses, so the status
        // bar shows the doc total again.
        await pressCtrl(page, 'x');
        const afterCut = await waitCvCharCount(page,
            c => c >= 0 && c <= beforeCut - 3, 16000);
        log('after-cut chars=' + afterCut);
        await snap(page, 'after_cut');

        check('Ctrl+X shrank the doc by ≥3 chars',
            afterCut >= 0 && afterCut <= beforeCut - 3,
            'before=' + beforeCut + ' after=' + afterCut);

        // Give the oncut clipboard capture time to settle — the handler
        // polls for the selection content before writing the system
        // clipboard (capture happens BEFORE the cut is applied, but the
        // async navigator.clipboard.write can land just after).
        await sleep(1600);

        // Ctrl+V: paste the cut content back. THIS is the tripwire. If the
        // cut path wrote the OS clipboard, this restores the char count to
        // beforeCut. If the bug is still present, the OS clipboard is
        // stale/empty and the count won't recover.
        await pressCtrl(page, 'v');
        const afterPaste = await waitCvCharCount(page, c => c >= beforeCut, 16000);
        log('after-paste chars=' + afterPaste);
        await snap(page, 'after_paste');

        check('Ctrl+V restored chars to before-cut count (TRIPWIRE)',
            afterPaste >= beforeCut,
            'expected≥' + beforeCut + ' got=' + afterPaste +
            ' → cut path not writing the OS clipboard');
    } catch (e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        try { await (cleanup ? cleanup() : browser.close()); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
