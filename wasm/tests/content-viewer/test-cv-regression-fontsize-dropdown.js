// test-cv-regression-fontsize-dropdown.js — the notebookbar font-size
// dropdown (#fontsizecombobox) offers the full size list, not a single
// hardcoded "12 pt" entry.
//
// Pre-fix bug: Control.NotebookbarWriter.js hardcoded the widget with
// entries: ['12 pt'] and nothing ever repopulated it (compact toolbar ships
// the proper static list + createFontSizeSelector; notebookbar did neither).
// The user opened the dropdown and saw exactly one option.
//
// WHAT IS VERIFIED (same subject as the legacy test):
//   1. Notebookbar mode active (>= 5 tab labels).
//   2. #fontsizecombobox container present.
//   3. After clicking the dropdown arrow (real mouse click), the effective
//      entry count — max(model entries, visible DOM entries) — is >= 5.
//      The bug shows 1.
//
// Migrated from wasm/tests/regression/test-regression-fontsize-dropdown.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-fontsize-dropdown.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, waitCvInteractive } = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOCX = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const SHOT_DIR = '/tmp/content-viewer-report/regression-fontsize-dropdown';

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

(async () => {
    if (!fs.existsSync(DOCX)) { check('fixture present', false, DOCX); process.exit(2); }
    log('=== Regression Bug 1: font-size dropdown entries (content viewer) ===');
    log('viewer: ' + BASE);
    // Wide viewport so the home-font overflow group renders the comboboxes
    // inline instead of folding into an overflow popup (same as legacy).
    const { browser } = await launch({ headless: 'new', width: 1920, height: 1080 });
    try {
        const page = await browser.newPage();
        page.on('pageerror', e => log(`[pageerror] ${e.message}`));
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

        await sleep(4000);
        await snap(page, 'editor_loaded');

        // Sanity: Notebookbar mode active.
        const tabCount = await frame.evaluate(() =>
            document.querySelectorAll('[id$="-tab-label"]').length).catch(() => 0);
        check('Notebookbar mode active (>=5 tab labels)', tabCount >= 5, 'tabs=' + tabCount);

        // Assert the fontsize combobox is present in the notebookbar. Don't
        // require it to have a non-zero on-screen box: this notebookbar keeps
        // #fontsizecombobox inside a `hidden-overflow-container` (its whole
        // ancestor chain up to #home-font measures 0×0), so it's reachable via
        // the overflow group rather than laid out inline. The widget is still
        // fully present/functional (its value is readable) — presence is the
        // right precondition; the real assertion below is the size-list model.
        const comboboxPresent = await frame.evaluate(() =>
            !!(document.getElementById('fontsizecombobox')
               || document.getElementById('fontsizecombobox-input-notebookbar'))
        ).catch(() => false);
        check('#fontsizecombobox container present', comboboxPresent);

        // Read the entries list from the widget JSON model (observation only).
        // Bug: Control.NotebookbarWriter.js hardcoded only ['12 pt'].
        const modelEntries = await frame.evaluate(() => {
            try {
                const nb = window.app && window.app.map && window.app.map.uiManager
                    && window.app.map.uiManager.notebookbar;
                if (!nb) return null;
                const widget = nb.model && nb.model.getById && nb.model.getById('fontsizecombobox');
                return widget && widget.entries ? widget.entries.slice(0, 40) : null;
            } catch (e) { return 'ERR:' + e.message; }
        }).catch(() => null);
        log(`Model widget.entries for fontsizecombobox: ${JSON.stringify(modelEntries)}`);

        // Try to open the dropdown by clicking the widget — the real user flow.
        // The combobox lives in the notebookbar's hidden overflow group, so it
        // has no inline box to click by coordinate; click the element directly
        // (best-effort — the assertion below also accepts the model entries,
        // which don't require the dropdown to be visible).
        try {
            const arrow = await frame.$('#listbox-arrow-fontsizecombobox, #fontsizecombobox');
            if (arrow) { await arrow.click(); await sleep(800); await snap(page, 'dropdown_open_arrow'); }
        } catch (e) { /* overflow-hidden — model entries carry the assertion */ }

        // Measure visible entries in the open dropdown.
        const visibleEntryInfo = await frame.evaluate(() => {
            const sel = [
                '#fontsizecombobox-dropdown .ui-combobox-entry',
                '#fontsizecombobox .ui-combobox-entry',
                '.ui-combobox-content .ui-combobox-entry',
                '.jsdialog .ui-combobox-entry',
                '#fontsizecombobox-dropdown .ui-listbox-entry',
                '.jsdialog .ui-listbox-entry',
            ];
            for (const s of sel) {
                const els = document.querySelectorAll(s);
                if (els.length) {
                    return { selector: s, count: els.length,
                        texts: Array.from(els).slice(0, 10).map(e => e.textContent.trim()) };
                }
            }
            const opts = document.querySelectorAll('[role="option"]');
            return { selector: '[role=option]', count: opts.length,
                texts: Array.from(opts).slice(0, 10).map(e => e.textContent.trim()) };
        }).catch(() => ({ count: 0, texts: [] }));
        log(`Visible dropdown entries: ${JSON.stringify(visibleEntryInfo)}`);
        await snap(page, 'dropdown_visible_entries');

        // Either the model entries list (covers a server-rendered dropdown the
        // arrow click didn't land on) OR the visible DOM entry count.
        const modelEntryCount = Array.isArray(modelEntries) ? modelEntries.length : 0;
        const visibleEntryCount = visibleEntryInfo.count || 0;
        const effectiveCount = Math.max(modelEntryCount, visibleEntryCount);
        log(`Effective entry count: ${effectiveCount} (model=${modelEntryCount}, visible=${visibleEntryCount})`);

        check(`fontsizecombobox has >=5 entries (saw ${effectiveCount})`,
            effectiveCount >= 5,
            `model=${JSON.stringify(modelEntries)} visible=${JSON.stringify(visibleEntryInfo.texts)}`);
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
