// test-cv-e2e-copypaste.js — E2E copy/paste through the Tresorit
// content-viewer (/collabora-tester), ALL interactions via real keyboard
// and mouse.
//
// Full copy/paste ladder in one session:
//   STEP 1  type "HELLO "                          → +6 exactly
//   STEP 2  Ctrl+A → Ctrl+C                        → count unchanged, system
//                                                    clipboard populated
//   STEP 3  Ctrl+End → End → Ctrl+V (internal)     → delta > 0
//   STEP 4  external text/plain-only paste         → +12 exactly, no double
//   STEP 5  external text/html paste               → +9 exactly
//   STEP 6  internal copy+paste AFTER external     → delta > 0
//   STEP 7  external image (1x1 PNG) paste         → |text delta| <= 2
//
// Migrated from wasm/tests/misc/test-e2e-copypaste.js — legacy version
// retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-e2e-copypaste.js [base-url]

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
const SHOT_DIR = '/tmp/content-viewer-report/e2e-copypaste';
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

async function clickEditor(page) {
    const el = await page.$('iframe');
    const box = el && await el.boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(500);
}
async function ctrl(page, key) {
    await page.keyboard.down('Control');
    await page.keyboard.press(key);
    await page.keyboard.up('Control');
    await sleep(200);
}
// Poll the char count until pred holds (or the budget elapses), then return
// the last value. Replaces fixed post-paste sleeps — the paste round-trip
// (keyboard → kit → canvas → #StateWordCount) can outrun any fixed sleep.
async function settleCc(page, pred, budgetMs = 40000) {
    return waitCvCharCount(page, pred, budgetMs);
}
// Write ClipboardItem payloads; falls back to the editor frame if the parent
// page write is rejected (focus/permission quirks in headless).
async function writeClipItems(page, items) {
    const writer = target => target.evaluate(async (its) => {
        const blobItems = {};
        for (const k in its) blobItems[k] = new Blob([its[k]], { type: k });
        await navigator.clipboard.write([new ClipboardItem(blobItems)]);
    }, items);
    try { await writer(page); } catch (e) {
        const fr = cvEditorFrame(page);
        if (!fr) throw e;
        await writer(fr);
    }
    await sleep(500);
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
            'e2e-cp-' + Date.now() + '.docx', bytes, { page, iframeTimeout: 60000 });
        check('editor became interactive (Save enabled)', await waitCvInteractive(page, LOAD_BUDGET));
        await waitCvCharCount(page, c => c >= 0, 60000);
        await sleep(5000);
        await clickEditor(page);

        // ═══ STEP 0: Initial state ═══
        const cc0 = await cvCharCount(page);
        log(`[Initial] ${cc0} chars`);
        await snap(page, 'initial');

        // ═══ STEP 1: Type "HELLO " via real keyboard ═══
        log('--- STEP 1: Type "HELLO " ---');
        await clickEditor(page);
        await page.keyboard.type('HELLO ', { delay: 80 });
        const cc1 = await settleCc(page, cc => cc - cc0 === 6, 24000);
        check('STEP1 type: +6', cc1 - cc0 === 6, 'delta=' + (cc1 - cc0));
        await snap(page, 'after_type');

        // ═══ STEP 2: Select All (Ctrl+A) → Copy (Ctrl+C) ═══
        log('--- STEP 2: Ctrl+A → Ctrl+C ---');
        await clickEditor(page);
        await ctrl(page, 'a');
        await sleep(1000);
        await ctrl(page, 'c');
        await sleep(3000);
        const cc2 = await cvCharCount(page);
        check('STEP2 copy: count unchanged', cc2 === cc1);
        await snap(page, 'after_copy');

        // Verify the system clipboard was populated (read-only probe).
        const fr = cvEditorFrame(page);
        const clipAfterCopy = await (fr || page).evaluate(async () => {
            try {
                const items = await navigator.clipboard.read();
                const types = [];
                for (const it of items) for (const t of it.types) types.push(t);
                return { types };
            } catch (e) { return { error: e.message }; }
        }).catch(e => ({ error: String(e) }));
        check('STEP2 clipboard populated', clipAfterCopy.types && clipAfterCopy.types.length > 0,
            'types=' + JSON.stringify(clipAfterCopy.types || []));

        // ═══ STEP 3: Deselect → End → Ctrl+V (internal paste) ═══
        log('--- STEP 3: Ctrl+End → Ctrl+V (internal paste) ---');
        await clickEditor(page);
        await ctrl(page, 'End');
        await sleep(300);
        await page.keyboard.press('End'); // plain End deselects and stays at end
        await sleep(500);
        const ccPre3 = await cvCharCount(page);
        await ctrl(page, 'v');
        const cc3 = await settleCc(page, cc => cc > ccPre3);
        check('STEP3 internal paste: delta > 0', cc3 > ccPre3, 'delta=' + (cc3 - ccPre3));
        await snap(page, 'after_internal_paste');

        // ═══ STEP 4: External plain text paste (from "Notepad") ═══
        log('--- STEP 4: External text paste ---');
        // Plain text only (no HTML) — simulates copying from a terminal
        // or a plain text editor.
        await writeClipItems(page, { 'text/plain': 'FROM_NOTEPAD' });
        await clickEditor(page);
        await ctrl(page, 'End');
        await sleep(500);
        const ccPre4 = await cvCharCount(page);
        await ctrl(page, 'v');
        const cc4 = await settleCc(page, cc => cc - ccPre4 === 12);
        check('STEP4 external text: +12', cc4 - ccPre4 === 12, 'delta=' + (cc4 - ccPre4));
        check('STEP4 no double paste', cc4 - ccPre4 <= 20, 'delta=' + (cc4 - ccPre4));
        await snap(page, 'after_external_text_paste');

        // ═══ STEP 5: External HTML paste (from "Word") ═══
        log('--- STEP 5: External HTML paste ---');
        await writeClipItems(page, {
            'text/html': '<b>BOLD_TEXT</b>',
            'text/plain': 'BOLD_TEXT',
        });
        await clickEditor(page);
        await ctrl(page, 'End');
        await sleep(500);
        const ccPre5 = await cvCharCount(page);
        await ctrl(page, 'v');
        const cc5 = await settleCc(page, cc => cc - ccPre5 === 9);
        check('STEP5 external HTML: +9', cc5 - ccPre5 === 9, 'delta=' + (cc5 - ccPre5));
        await snap(page, 'after_external_html_paste');

        // ═══ STEP 6: Internal copy+paste AFTER external paste ═══
        log('--- STEP 6: Internal copy+paste after external ---');
        await clickEditor(page);
        await ctrl(page, 'Home');
        await sleep(500);
        // Select first word (Ctrl+Shift+Right)
        await page.keyboard.down('Control');
        await page.keyboard.down('Shift');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.up('Shift');
        await page.keyboard.up('Control');
        await sleep(500);
        await ctrl(page, 'c');
        await sleep(3000);
        await ctrl(page, 'End');
        await sleep(500);
        const ccPre6 = await cvCharCount(page);
        await ctrl(page, 'v');
        const cc6 = await settleCc(page, cc => cc > ccPre6);
        check('STEP6 internal paste after external: delta > 0', cc6 > ccPre6, 'delta=' + (cc6 - ccPre6));
        await snap(page, 'after_internal_paste_after_ext');

        // ═══ STEP 7: External image paste (from "Paint") ═══
        log('--- STEP 7: External image paste ---');
        await clickEditor(page);
        await ctrl(page, 'End');
        await sleep(500);
        const ccPre7 = await cvCharCount(page);
        // 1x1 PNG on the system clipboard (with empty text to clear any
        // leftover text from previous clipboard writes).
        const writeImage = target => target.evaluate(async () => {
            const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
            const raw = atob(b64);
            const bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
            await navigator.clipboard.write([new ClipboardItem({
                'image/png': new Blob([bytes], { type: 'image/png' }),
                'text/plain': new Blob([''], { type: 'text/plain' }),
            })]);
        });
        try { await writeImage(page); } catch (e) {
            const fr7 = cvEditorFrame(page);
            if (fr7) await writeImage(fr7);
        }
        await sleep(500);
        await ctrl(page, 'v');
        await sleep(16000);
        const cc7 = await cvCharCount(page);
        check('STEP7 image paste: no text double-paste', Math.abs(cc7 - ccPre7) <= 2,
            'delta=' + (cc7 - ccPre7));
        await snap(page, 'after_image_paste');
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        try { await (cleanup ? cleanup() : browser.close()); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
