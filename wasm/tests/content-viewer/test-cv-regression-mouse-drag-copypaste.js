// test-cv-regression-mouse-drag-copypaste.js — mouse-drag selection →
// Ctrl+C → Ctrl+End → Ctrl+V actually pastes the dragged text at
// end-of-doc, through the Tresorit content-viewer (/collabora-tester).
//
// Isolates the kit-side drag-select + clipboard chain. Known failure mode
// (per copy-paste-master): drag coords must be computed BEFORE any Ctrl+End
// scroll, otherwise the drag lands in the wrong place — hence drag at the
// top, Ctrl+End ONLY after Ctrl+C.
//
// Shape (real puppeteer mouse + keyboard — no sendUnoCommand, no
// app.dispatcher.dispatch, no page.evaluate(()=>el.click())):
//   1. Open a fresh new.docx via the tester upload (single-user mode).
//   2. Wait for editor ready.
//   3. Click into the doc body to place caret. Type "drag-target".
//   4. Ctrl+Home to position the caret at the top (deterministic starting
//      Y for the drag).
//   5. Mouse-drag horizontally across part of the typed phrase.
//   6. Ctrl+C → Ctrl+End → Ctrl+V.
//   7. Assert StateWordCount grew (text was pasted).
//
// Smoke: doesn't pin the exact text, just that some text was pasted.
//
// Migrated from wasm/tests/regression/test-regression-mouse-drag-copypaste.js
// — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-mouse-drag-copypaste.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const {
    openBytesViaContentViewer, waitCvInteractive, cvEditorFrame,
    cvCharCount, waitCvCharCount,
} = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/regression-mouse-drag-copypaste';
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
    log('=== Regression: mouse-drag select → copy → ctrl-end → paste ===');
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
            'drag-cp-' + Date.now() + '.docx', bytes, { page, iframeTimeout: 60000 });
        check('editor became interactive (Save enabled)', await waitCvInteractive(page, LOAD_BUDGET));
        const baseChars = await waitCvCharCount(page, c => c >= 0, 60000);
        log('Editor ready, baseline chars=' + baseChars);
        await sleep(3000);
        await snap(page, 'editor_ready');

        // Click into the canvas, then type a deterministic phrase.
        const iframeEl = await page.$('iframe');
        const ifBox = await iframeEl.boundingBox();
        const clickX = ifBox.x + ifBox.width / 2;
        const clickY = ifBox.y + Math.min(ifBox.height * 0.55, 450);
        await page.mouse.click(clickX, clickY);
        await sleep(1000);

        const PHRASE = 'drag-target';
        for (const ch of PHRASE) {
            await page.keyboard.type(ch);
            await sleep(30);
        }
        const targetChars = baseChars >= 0 ? baseChars + PHRASE.length : PHRASE.length;
        const afterType = await waitCvCharCount(page, c => c >= targetChars, 20000);
        log('after-type chars=' + afterType);
        check('Typed "drag-target"', afterType >= targetChars,
            'expected≥' + targetChars + ' got=' + afterType);
        await snap(page, 'after_type');

        // Ctrl+Home so the caret + the typed text are reachable at a known Y
        // for the drag — the doc fits on screen at this point.
        await pressCtrl(page, 'Home');
        await sleep(1000);

        // Drag-select a horizontal span across the FIRST LINE of text.
        // GEOMETRY (2026-06-12 root cause): in a near-blank doc the typed
        // text lands at the document TOP — a drag at mid-page crosses empty
        // space and selects nothing. After the Ctrl+Home above, the visible
        // blinking cursor sits at the start of the first line; drag
        // rightwards from it across the text.
        const fr = cvEditorFrame(page);
        const cursorBox = fr ? await fr.evaluate(() => {
            const el = document.querySelector('.blinking-cursor');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, h: r.height };
        }).catch(() => null) : null;
        check('Blinking cursor visible after Ctrl+Home', !!cursorBox,
            cursorBox ? '' : 'no .blinking-cursor element');
        const dragY = cursorBox ? ifBox.y + cursorBox.y + cursorBox.h / 2 : clickY;
        const dragStartX = cursorBox ? ifBox.x + cursorBox.x + 2 : clickX - 40;
        const dragEndX = dragStartX + 80;
        await page.mouse.move(dragStartX, dragY);
        await page.mouse.down();
        // Let kit register the press before the drag begins — under
        // contention a fast move can outpace the click-down handler and the
        // kit never sees a drag-start.
        await sleep(400);
        await page.mouse.move(dragEndX, dragY, { steps: 30 });
        await page.mouse.up();
        await sleep(1000);
        await snap(page, 'after_drag');

        // Copy → Ctrl+End → paste.
        await pressCtrl(page, 'c');
        await sleep(800);
        await page.keyboard.down('Control');
        await page.keyboard.press('End');
        await page.keyboard.up('Control');
        await sleep(600);
        const beforePaste = await cvCharCount(page);
        log('before-paste chars=' + beforePaste);
        await pressCtrl(page, 'v');
        const finalChars = await waitCvCharCount(page, c => c >= beforePaste + 1, 20000);
        log('after-paste chars=' + finalChars);
        await snap(page, 'after_paste');

        check('Paste after mouse-drag grew the character count',
            finalChars >= beforePaste + 1,
            'before=' + beforePaste + ' after=' + finalChars);
    } catch (e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        try { await (cleanup ? cleanup() : browser.close()); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
