// test-cv-regression-font-change-ui.js — changing the font of a selected
// word via the notebookbar font-name combobox works end-to-end.
//
// Pre-fix bug: the notebookbar's #fontnamecombobox was statically defined
// with a single hardcoded "Carlito" entry and never populated from
// .uno:CharFontName toolbarcommandvalues, nor synced from
// commandstatechanged — typing a font + Enter did nothing. Fix: call
// map.createFontSelector('fontnamecombobox') in NotebookbarBase.onAdd.
//
// WHAT IS VERIFIED (same subject as the legacy test):
//   1. Notebookbar mode active (>= 5 tab labels); #fontnamecombobox exists.
//   2. A non-empty selection is made (word-select via keyboard, Ctrl+A
//      fallback — legacy accepted any non-empty selection).
//   3. The font list is populated from .uno:CharFontName (>1 entry) —
//      pre-fix this was the single-element ['Carlito'].
//   4. Typing "Liberation Serif" + Enter into the combobox updates the
//      .uno:CharFontName state (stateChangeHandler) AND the visible
//      combobox input reflects the new font.
//
// Harness changes vs legacy: the old viewer's editor iframe was cross-origin,
// so the legacy test selected the word via TheFakeWebSocket LOK mouse frames
// with a sendUnoCommand SelectAll fallback. The content-viewer iframe is
// SAME-ORIGIN, so we drive real input only: click into the doc, Ctrl+Home,
// Ctrl+Shift+ArrowRight to select the first word (Ctrl+A fallback). The
// legacy map.applyFont() fallback is dropped — the combobox keystroke path
// is the surface under test; instead we retry the real keystroke sequence
// once.
//
// Migrated from wasm/tests/regression/test-regression-font-change-ui.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-font-change-ui.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, waitCvInteractive } = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOCX = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const SHOT_DIR = '/tmp/content-viewer-report/regression-font-change-ui';

// A font actually present in the deployed soffice.data (Carlito +
// Liberation Sans/Serif/Mono ship with the WASM bundle).
const TARGET_FONT = 'Liberation Serif';

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
const editorFrame = page => page.frames().find(f => (f.url() || '').includes('cool.html'));
let shotN = 0;
async function snap(page, name) {
    try { fs.mkdirSync(SHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${SHOT_DIR}/${String(++shotN).padStart(2, '0')}_${name}.png` }); } catch (e) {}
}
async function getStatus(frame) {
    try {
        return await frame.evaluate(() =>
            document.querySelector('#StateWordCount')?.textContent?.trim() || '');
    } catch (e) { return ''; }
}
async function getCharFontName(frame) {
    return frame.evaluate(() => {
        try {
            const m = window.app && window.app.map;
            if (!m) return null;
            const sc = m['stateChangeHandler'];
            if (sc && typeof sc.getItemValue === 'function') {
                const v = sc.getItemValue('.uno:CharFontName');
                if (v) return v;
            }
            return null;
        } catch (e) { return 'ERR:' + e.message; }
    }).catch(() => null);
}
async function getComboboxInputValue(frame) {
    return frame.evaluate(() => {
        const root = document.getElementById('fontnamecombobox');
        if (!root) return null;
        const input = root.querySelector('input');
        return input ? input.value : null;
    }).catch(() => null);
}

(async () => {
    if (!fs.existsSync(DOCX)) { check('fixture present', false, DOCX); process.exit(2); }
    log('=== Regression: font change via notebookbar combobox (content viewer) ===');
    log('viewer: ' + BASE);
    // Wide viewport keeps fontnamecombobox inline (not folded into the
    // overflow "Font" popup) — same as legacy.
    const { browser } = await launch({ headless: 'new', width: 1920, height: 1080 });
    try {
        const page = await browser.newPage();
        page.on('pageerror', e => log(`[pageerror] ${e.message}`));
        page.on('console', m => {
            const t = m.text();
            if (/CharFontName|combobox/i.test(t)) log(`[page] ${t.substring(0, 200)}`);
        });
        await openViaContentViewer(browser, BASE, DOCX, {
            page, viewport: { width: 1920, height: 1080 }, iframeTimeout: 60000,
        });
        check('editor interactive', await waitCvInteractive(page, LOAD_BUDGET));
        const frame = editorFrame(page);
        if (!frame) throw new Error('editor frame never loaded');
        await frame.waitForFunction(() => {
            const wc = document.querySelector('#StateWordCount');
            return !!(wc && /\d+\s+character/i.test(wc.textContent || ''));
        }, { timeout: 60000 });
        log(`Initial status: "${await getStatus(frame)}"`);

        // Notebookbar render + createFontSelector wiring settle.
        await sleep(4000);
        await snap(page, 'editor_loaded');

        const tabCount = await frame.evaluate(() =>
            document.querySelectorAll('[id$="-tab-label"]').length).catch(() => 0);
        check('Notebookbar mode active (>=5 tab labels)', tabCount >= 5, 'tabs=' + tabCount);

        const comboboxExists = await frame.evaluate(() =>
            !!document.getElementById('fontnamecombobox')).catch(() => false);
        check('#fontnamecombobox container exists in iframe DOM', comboboxExists);

        const fontBefore = await getCharFontName(frame);
        log(`Initial .uno:CharFontName = "${fontBefore}"`);

        // ── Select the first word via REAL keyboard input ────────────────
        // Click into the doc to focus, Ctrl+Home to the doc start, then
        // Ctrl+Shift+ArrowRight selects the first word ("baseline"). Same
        // subject as the legacy LOK double-click: a non-empty selection.
        const ifEl = await page.$('iframe');
        const ifBox = await ifEl.boundingBox();
        await page.mouse.click(ifBox.x + ifBox.width / 2,
            ifBox.y + Math.min(ifBox.height * 0.5, 400));
        await sleep(500);
        await page.keyboard.down('Control');
        await page.keyboard.press('Home');
        await page.keyboard.up('Control');
        await sleep(300);
        await page.keyboard.down('Control');
        await page.keyboard.down('Shift');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.up('Shift');
        await page.keyboard.up('Control');

        let selected = false;
        let stAfter = '';
        const selDeadline = Date.now() + 8000;
        while (Date.now() < selDeadline) {
            stAfter = await getStatus(frame);
            if (/Selected:\s*\d+\s+word/i.test(stAfter)) { selected = true; break; }
            await sleep(300);
        }
        log(`  after word-select → "${stAfter}"`);

        // Fallback: select-all via real Ctrl+A (legacy accepted any
        // non-empty selection; its fallback was sendUnoCommand SelectAll).
        if (!selected) {
            log('  keyboard word-select missed — falling back to Ctrl+A');
            await page.keyboard.down('Control');
            await page.keyboard.press('a');
            await page.keyboard.up('Control');
            await sleep(1500);
            stAfter = await getStatus(frame);
            log(`  after Ctrl+A → "${stAfter}"`);
            if (/Selected:\s*\d+\s+word/i.test(stAfter) || /\d+\s+word/i.test(stAfter)) {
                selected = true;
            }
        }
        await snap(page, 'after_selection');
        check('A non-empty selection exists (keyboard word-select or Ctrl+A fallback)',
            selected, stAfter);

        // ── Font list populated from .uno:CharFontName (observation) ─────
        // Pre-fix this was the single-element ['Carlito'].
        const fontEntries = await frame.evaluate(() => {
            try {
                const m = window.app && window.app.map;
                if (!m || !m._docLayer) return null;
                const v = m._docLayer._toolbarCommandValues['.uno:CharFontName'];
                if (!v) return null;
                if (Array.isArray(v)) return v.slice(0, 5);
                if (typeof v === 'object') return Object.keys(v).slice(0, 5);
                return null;
            } catch (e) { return null; }
        }).catch(() => null);
        log(`Top-5 font entries from _toolbarCommandValues: ${JSON.stringify(fontEntries)}`);
        check('Font list populated from .uno:CharFontName (>1 entry)',
            !!(fontEntries && fontEntries.length > 1),
            'entries=' + JSON.stringify(fontEntries));

        // ── Drive the font change through the combobox input (real input) ──
        log(`--- Changing font to "${TARGET_FONT}" via combobox input ---`);
        async function typeFontIntoCombobox() {
            const inputRect = await frame.evaluate(() => {
                const root = document.getElementById('fontnamecombobox');
                if (!root) return null;
                const input = root.querySelector('input');
                if (!input) return null;
                const r = input.getBoundingClientRect();
                return { x: r.x, y: r.y, w: r.width, h: r.height };
            }).catch(() => null);
            if (!inputRect || inputRect.w <= 0) return null;
            const ix = ifBox.x + inputRect.x + inputRect.w / 2;
            const iy = ifBox.y + inputRect.y + inputRect.h / 2;
            await page.mouse.click(ix, iy);
            await sleep(500);
            await page.mouse.click(ix, iy, { clickCount: 3 });   // select existing value
            await sleep(300);
            await page.keyboard.press('Backspace');
            await sleep(200);
            await page.keyboard.type(TARGET_FONT, { delay: 60 });
            await sleep(300);
            await snap(page, 'typed_font_name');
            await page.keyboard.press('Enter');
            log('Pressed Enter to commit font change');
            await sleep(3000);
            return inputRect;
        }
        const inputRect = await typeFontIntoCombobox();
        check('#fontnamecombobox input is present', !!inputRect);
        await snap(page, 'after_font_change');

        // ── Verify: the createFontSelector state-change wiring must pick up
        //    the .uno:CharFontName commandstatechanged from core.
        async function pollFont(ms) {
            const d = Date.now() + ms;
            let v = null;
            while (Date.now() < d) {
                v = await getCharFontName(frame);
                if (v && v.toLowerCase().includes(TARGET_FONT.toLowerCase())) return v;
                await sleep(300);
            }
            return v;
        }
        let fontAfter = await pollFont(8000);

        // One retry of the REAL keystroke sequence (jsdialog can re-render
        // the input mid-typing under load and eat the chain). No internal
        // API fallback — the keystroke path is the surface under test.
        if (!fontAfter || !fontAfter.toLowerCase().includes(TARGET_FONT.toLowerCase())) {
            log('  combobox keystroke path did not propagate — retrying the real input sequence once');
            await typeFontIntoCombobox();
            fontAfter = await pollFont(8000);
        }

        log(`Final .uno:CharFontName = "${fontAfter}" (was "${fontBefore}")`);
        check(`UNO CharFontName state updated to "${TARGET_FONT}" (createFontSelector wiring)`,
            !!(fontAfter && fontAfter.toLowerCase().includes(TARGET_FONT.toLowerCase())),
            `before="${fontBefore}" after="${fontAfter}"`);

        const inputAfter = await getComboboxInputValue(frame);
        log(`combobox input value after change: "${inputAfter}"`);
        check(`Combobox input reflects "${TARGET_FONT}"`,
            !!(inputAfter && inputAfter.toLowerCase().includes(TARGET_FONT.toLowerCase())),
            'input="' + inputAfter + '"');
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
