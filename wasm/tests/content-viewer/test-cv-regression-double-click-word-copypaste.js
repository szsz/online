// test-cv-regression-double-click-word-copypaste.js — double-click word →
// Ctrl+C → Ctrl+End → Ctrl+V actually pastes the selected word at
// end-of-doc, through the Tresorit content-viewer (/collabora-tester).
//
// Isolates the kit-side word-select + clipboard chain from multi-case runs
// where prior cases pre-populate the clipboard. Shape (real puppeteer mouse
// + keyboard — no sendUnoCommand, no app.dispatcher.dispatch, no
// page.evaluate(()=>el.click())):
//   1. Open a fresh new.docx via the tester upload.
//   2. Wait for the editor to be ready.
//   3. Click into the doc body to place caret. Type "hello world".
//   4. Wait for the StateWordCount to reflect the typed chars.
//   5. Double-click on a word in the canvas to select it (two DISCRETE
//      clicks 80 ms apart — COOL counts click events, it never sees
//      detail=2, so puppeteer's clickCount:2 idiom does not word-select).
//   6. Ctrl+C → Ctrl+End → Ctrl+V.
//   7. Assert StateWordCount has grown by at least 1 char.
//
// Smoke: doesn't pin the exact word, just that some text was pasted.
//
// Migrated from wasm/tests/regression/test-regression-double-click-word-copypaste.js
// — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-double-click-word-copypaste.js [base-url]

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
const SHOT_DIR = '/tmp/content-viewer-report/regression-double-click-word-copypaste';
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
    log('=== Regression: double-click word → copy → ctrl-end → paste ===');
    if (!fs.existsSync(FIXTURE)) { log('ERROR: fixture missing: ' + FIXTURE); process.exit(1); }
    log('viewer: ' + BASE);
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    const { browser, cleanup } = await launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        // Grant clipboard permissions browser-wide via CDP. Without this
        // Ctrl+V hits "Paste: empty clipboard — ignored" in the wasm-loader's
        // paste handler.
        const cdp = await page.target().createCDPSession();
        try {
            await cdp.send('Browser.grantPermissions', {
                permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
            });
        } catch (e) { /* older Chrome */ }

        log('open writer via /collabora-tester');
        const bytes = fs.readFileSync(FIXTURE);
        await openBytesViaContentViewer(browser, BASE,
            'dclick-word-cp-' + Date.now() + '.docx', bytes, { page, iframeTimeout: 60000 });
        check('editor became interactive (Save enabled)', await waitCvInteractive(page, LOAD_BUDGET));
        const baseChars = await waitCvCharCount(page, c => c >= 0, 60000);
        log('Editor ready, baseline chars=' + baseChars);
        await sleep(3000);
        await snap(page, 'editor_ready');

        // Click into the doc canvas to place the caret — aim well below the
        // toolbar.
        const iframeEl = await page.$('iframe');
        const ifBox = await iframeEl.boundingBox();
        const clickX = ifBox.x + ifBox.width / 2;
        const clickY = ifBox.y + Math.min(ifBox.height * 0.55, 450);
        await page.mouse.click(clickX, clickY);
        await sleep(1000);

        // Type a deterministic phrase. The double-click below selects a word
        // inside this phrase.
        const PHRASE = 'hello world';
        for (const ch of PHRASE) {
            await page.keyboard.type(ch);
            await sleep(20);
        }
        const targetChars = baseChars >= 0 ? baseChars + PHRASE.length : PHRASE.length;
        const after = await waitCvCharCount(page, c => c >= targetChars, 40000);
        log('after-type chars=' + after);
        check('Typing "hello world" added characters',
            after >= targetChars, 'expected≥' + targetChars + ' got=' + after);
        await snap(page, 'after_type');

        // Double-click on a word. Two pitfalls (2026-06-12 root cause):
        // 1. GEOMETRY: in a near-blank doc the typed text lands at the
        //    document TOP regardless of where we clicked, so aim at the
        //    visible blinking-cursor marker — it sits right after the text
        //    we just typed.
        // 2. IDIOM: puppeteer's click({clickCount:2}) dispatches ONE
        //    press/release pair; COOL's MouseControl.onClick COUNTS discrete
        //    click events inside a 250 ms window, so simulate a real double-
        //    click as two discrete clicks 80 ms apart.
        const fr = cvEditorFrame(page);
        const cursorBox = fr ? await fr.evaluate(() => {
            const el = document.querySelector('.blinking-cursor');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, h: r.height };
        }).catch(() => null) : null;
        check('Blinking cursor visible after typing', !!cursorBox,
            cursorBox ? '' : 'no .blinking-cursor element');
        const dcX = ifBox.x + (cursorBox ? cursorBox.x - 20 : clickX - 30);
        const dcY = cursorBox ? ifBox.y + cursorBox.y + cursorBox.h / 2 : clickY;
        await page.mouse.click(dcX, dcY);
        await sleep(80);
        await page.mouse.click(dcX, dcY);
        // MouseControl's click-counter timer fires 250 ms after the second
        // click; give it room before copying.
        await sleep(1500);
        await snap(page, 'word_double_clicked');

        // Copy → ctrl-end → paste.
        await pressCtrl(page, 'c');
        await sleep(800);
        await page.keyboard.down('Control');
        await page.keyboard.press('End');
        await page.keyboard.up('Control');
        await sleep(600);
        const beforePaste = await cvCharCount(page);
        log('before-paste chars=' + beforePaste);
        await pressCtrl(page, 'v');
        // Paste round-trips to kit; allow time for the state-update.
        const finalChars = await waitCvCharCount(page, c => c >= beforePaste + 1, 20000);
        log('after-paste chars=' + finalChars);
        await snap(page, 'after_paste');

        check('Paste after double-click-word grew the character count',
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
