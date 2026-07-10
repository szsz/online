// test-cv-regression-plaintext-paste.js — pasting UNFORMATTED plain text
// into a Writer document through the Tresorit content-viewer
// (/collabora-tester).
//
// Scenario the user reported: copy plain text from a terminal / Notepad
// (no HTML on the clipboard), Ctrl+V into the WASM COOL Writer doc, and
// nothing appears — paste silently fails. This test exercises every
// plain-text paste path:
//   A. Clipboard text/plain ONLY → Ctrl+V                     → +12
//   B. Clipboard text/html + text/plain → Ctrl+V (control)    → +12
//   C. Clipboard text/plain ONLY again (consistency)          → +12
//   D. Real keyboard typing as baseline                       → +12
//   E. Clipboard rich HTML + text/plain → Ctrl+V              → +12
//   F. Clipboard text/html ONLY (no text/plain) → Ctrl+V      → +12
//
// Migrated from wasm/tests/regression/test-regression-plaintext-paste.js —
// legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-plaintext-paste.js [base-url]

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
const SHOT_DIR = '/tmp/content-viewer-report/regression-plaintext-paste';
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

async function clickCanvas(page) {
    const el = await page.$('iframe');
    const box = el && await el.boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(300);
}
async function ctrlEnd(page) {
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    await sleep(500);
}
// Set clipboard content (ClipboardItem blobs, one per mime type) and paste
// via a real Ctrl+V. Falls back to the editor frame if the parent write is
// rejected.
async function setClipboardAndPaste(page, clipboardItems) {
    const writer = target => target.evaluate(async (items) => {
        const blobItems = {};
        for (const k in items) blobItems[k] = new Blob([items[k]], { type: k });
        await navigator.clipboard.write([new ClipboardItem(blobItems)]);
    }, clipboardItems);
    try { await writer(page); } catch (e) {
        const fr = cvEditorFrame(page);
        if (!fr) throw e;
        await writer(fr);
    }
    await clickCanvas(page);
    await page.keyboard.down('Control');
    await page.keyboard.press('v');
    await page.keyboard.up('Control');
}

(async () => {
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
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
        } catch (e) {}

        log('open writer via /collabora-tester');
        const bytes = fs.readFileSync(FIXTURE);
        await openBytesViaContentViewer(browser, BASE,
            'plaintext-paste-' + Date.now() + '.docx', bytes, { page, iframeTimeout: 60000 });
        check('editor became interactive (Save enabled)', await waitCvInteractive(page, LOAD_BUDGET));
        await waitCvCharCount(page, c => c >= 0, 60000);
        await sleep(5000);

        // === STEP 0: Initial state ===
        log('=== STEP 0: Initial state ===');
        const cc0 = await cvCharCount(page);
        log(`  [Initial] ${cc0} chars`);
        await snap(page, 'initial');

        // === TEST A: Clipboard text/plain ONLY -> Ctrl+V ===
        log('=== TEST A: Clipboard text/plain ONLY -> Ctrl+V (12 chars: "PLAIN_TEXT_A") ===');
        await clickCanvas(page);
        await ctrlEnd(page);
        const ccPreA = await cvCharCount(page);
        await setClipboardAndPaste(page, { 'text/plain': 'PLAIN_TEXT_A' });
        const ccA = await waitCvCharCount(page, c => c - ccPreA === 12, 16000);
        check('TEST-A: text/plain-only clipboard paste adds 12 chars', ccA - ccPreA === 12,
            'delta=' + (ccA - ccPreA));
        await snap(page, 'after_paste_text_plain_only');

        // === TEST B: Clipboard text/html + text/plain -> Ctrl+V (control) ===
        log('=== TEST B: Clipboard text/html + text/plain -> Ctrl+V (control, 12 chars: "HTML_TEXT_BB") ===');
        await clickCanvas(page);
        await ctrlEnd(page);
        const ccPreB = await cvCharCount(page);
        await setClipboardAndPaste(page, {
            'text/html': '<p>HTML_TEXT_BB</p>',
            'text/plain': 'HTML_TEXT_BB',
        });
        const ccB = await waitCvCharCount(page, c => c - ccPreB === 12, 16000);
        check('TEST-B: text/html+text/plain clipboard paste adds 12 chars (control)', ccB - ccPreB === 12,
            'delta=' + (ccB - ccPreB));
        await snap(page, 'after_paste_text_html_plus_plain');

        // === TEST C: Clipboard text/plain ONLY again (consistency check) ===
        log('=== TEST C: Clipboard text/plain ONLY again (12 chars: "PLAIN_STR_CC") ===');
        await clickCanvas(page);
        await ctrlEnd(page);
        const ccPreC = await cvCharCount(page);
        await setClipboardAndPaste(page, { 'text/plain': 'PLAIN_STR_CC' });
        const ccC = await waitCvCharCount(page, c => c - ccPreC === 12, 16000);
        check('TEST-C: text/plain-only clipboard paste adds 12 chars (consistency)', ccC - ccPreC === 12,
            'delta=' + (ccC - ccPreC));
        await snap(page, 'after_paste_text_plain_only_2');

        // === TEST D: Type via real keyboard as baseline ===
        log('=== TEST D: Type via real keyboard as baseline (12 chars: "TEXTINPUT_DD") ===');
        await clickCanvas(page);
        await ctrlEnd(page);
        const ccPreD = await cvCharCount(page);
        await clickCanvas(page);
        await page.keyboard.type('TEXTINPUT_DD', { delay: 50 });
        const ccD = await waitCvCharCount(page, c => c - ccPreD === 12, 16000);
        check('TEST-D: keyboard type adds 12 chars (baseline)', ccD - ccPreD === 12,
            'delta=' + (ccD - ccPreD));
        await snap(page, 'after_keyboard_type_fallback');

        // === TEST E: Clipboard with rich HTML + text/plain -> Ctrl+V ===
        log('=== TEST E: Clipboard rich HTML + text/plain -> Ctrl+V (12 chars: "ONLY_PLAIN_E") ===');
        await clickCanvas(page);
        await ctrlEnd(page);
        const ccPreE = await cvCharCount(page);
        await setClipboardAndPaste(page, {
            'text/html': '<html><body><b>ONLY_PLAIN_E</b></body></html>',
            'text/plain': 'ONLY_PLAIN_E',
        });
        const ccE = await waitCvCharCount(page, c => c - ccPreE === 12, 16000);
        check('TEST-E: rich HTML clipboard paste adds 12 chars', ccE - ccPreE === 12,
            'delta=' + (ccE - ccPreE));
        await snap(page, 'after_clipboard_rich_html_paste');

        // === TEST F: Clipboard text/html ONLY (no text/plain companion) -> Ctrl+V ===
        log('=== TEST F: Clipboard text/html ONLY -> Ctrl+V (12 chars: "BOTH_MIME_FF") ===');
        await clickCanvas(page);
        await ctrlEnd(page);
        const ccPreF = await cvCharCount(page);
        await setClipboardAndPaste(page, { 'text/html': '<p>BOTH_MIME_FF</p>' });
        const ccF = await waitCvCharCount(page, c => c - ccPreF === 12, 16000);
        check('TEST-F: text/html-only clipboard paste adds 12 chars (control)', ccF - ccPreF === 12,
            'delta=' + (ccF - ccPreF));
        await snap(page, 'after_clipboard_html_only');
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        try { await (cleanup ? cleanup() : browser.close()); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
