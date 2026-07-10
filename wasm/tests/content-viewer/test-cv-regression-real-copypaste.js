// test-cv-regression-real-copypaste.js — REAL Ctrl+C / Ctrl+V flow through
// the Tresorit content-viewer (/collabora-tester).
//
// Validates the clipboard wiring end-to-end with real user input: type text,
// Ctrl+A → Ctrl+C, verify the SYSTEM clipboard received COOL-generated HTML
// (with the COOL origin marker the paste handler keys off), then Ctrl+End →
// Ctrl+V and verify the paste grew the document.
//
// The legacy test drove the flow through TheFakeWebSocket + synthetic
// dispatched events; this port drives the exact same subject through real
// page.keyboard input (the flow the legacy test was *simulating*). The four
// subject assertions are unchanged:
//   - typing added the 6 typed chars
//   - system clipboard has COOL HTML after copy
//   - clipboard HTML carries the COOL origin marker
//   - paste added chars at doc end
//
// Migrated from wasm/tests/regression/test-regression-real-copypaste.js —
// legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-real-copypaste.js [base-url]

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
const SHOT_DIR = '/tmp/content-viewer-report/regression-real-copypaste';
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

async function focusDoc(page) {
    const el = await page.$('iframe');
    const box = el && await el.boundingBox();
    if (!box) return false;
    await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.55, 450));
    await sleep(300);
    return true;
}
async function ctrl(page, key) {
    await page.keyboard.down('Control');
    await page.keyboard.press(key);
    await page.keyboard.up('Control');
    await sleep(200);
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
            'real-cp-' + Date.now() + '.docx', bytes, { page, iframeTimeout: 60000 });
        check('editor became interactive (Save enabled)', await waitCvInteractive(page, LOAD_BUDGET));
        const base = await waitCvCharCount(page, c => c >= 0, 60000);
        check('char count readable after open', base >= 0, 'base=' + base);
        await sleep(2500);
        await snap(page, 'opened');

        // ═══ STEP 0: Type "ABCDEF" so we have content to copy ═══
        log('STEP 0: type "ABCDEF" via real keyboard');
        await focusDoc(page);
        await ctrl(page, 'End');
        await page.keyboard.type('ABCDEF', { delay: 60 });
        const cc0 = await waitCvCharCount(page, c => c >= base + 6, 20000);
        check('STEP0: typed 6 chars', cc0 >= base + 6, 'base=' + base + ' cc=' + cc0);
        await snap(page, 'after_type');

        // ═══ STEP 1: Select All (real Ctrl+A) ═══
        log('STEP 1: Ctrl+A select all');
        await ctrl(page, 'a');
        await sleep(1000);
        await snap(page, 'after_selectall');

        // ═══ STEP 2: COPY (real Ctrl+C) — verify SYSTEM clipboard ═══
        log('STEP 2: Ctrl+C, then read the system clipboard');
        await ctrl(page, 'c');
        await sleep(3000);

        const fr = cvEditorFrame(page);
        const clipAfterCopy = await (fr || page).evaluate(async () => {
            const diag = {};
            try {
                const items = await navigator.clipboard.read();
                diag.clipboardTypes = [];
                for (const it of items) {
                    for (const t of it.types) {
                        const b = await it.getType(t);
                        const txt = await b.text();
                        diag.clipboardTypes.push(t);
                        diag['clip_' + t.replace('/', '_')] = txt.substring(0, 200);
                    }
                }
            } catch (e) { diag.clipboardError = e.message; }
            return diag;
        }).catch(e => ({ clipboardError: String(e) }));
        log('  Clipboard after copy: ' + JSON.stringify(clipAfterCopy).slice(0, 300));
        await snap(page, 'after_copy');

        const hasCoolHtml = clipAfterCopy.clip_text_html &&
            (clipAfterCopy.clip_text_html.includes('coolorigin')
                || clipAfterCopy.clip_text_html.includes('meta-origin'));
        check('STEP2: system clipboard has COOL HTML after copy',
            !!clipAfterCopy.clip_text_html,
            'html=' + (clipAfterCopy.clip_text_html || 'EMPTY').substring(0, 40));
        check('STEP2: clipboard HTML has COOL origin marker', hasCoolHtml,
            'marker=' + (hasCoolHtml ? 'found' : 'MISSING'));

        // ═══ STEP 3: Ctrl+End to collapse the selection at doc end ═══
        // After Select All the selection is still active — paste would
        // replace it (delta=0 because clipboard==selection by definition).
        // Ctrl+End collapses to doc end so paste appends.
        log('STEP 3: Ctrl+End to position cursor at doc end');
        await ctrl(page, 'End');
        await sleep(1000);
        const ccPrePaste = await cvCharCount(page);

        // ═══ STEP 4: PASTE (real Ctrl+V) ═══
        log('STEP 4: Ctrl+V paste');
        await ctrl(page, 'v');
        const cc4 = await waitCvCharCount(page, c => c > ccPrePaste, 20000);
        check('STEP4: paste added chars', cc4 > ccPrePaste, 'delta=' + (cc4 - ccPrePaste));
        await snap(page, 'after_paste');
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        try { await (cleanup ? cleanup() : browser.close()); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
