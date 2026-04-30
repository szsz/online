const __cl = require('./lib/inject-checklist');
// Regression: Bug 1 — font-size dropdown shows only one option.
//
// User-reported: in Notebookbar mode, when the font-size dropdown
// (#fontsizecombobox) is opened, only one entry ("12 pt") is visible
// instead of the typical list (6, 7, 8, 9, 10, 10.5, 11, 12, 13, ...).
//
// Suspected root cause (read-only inspection of the source):
//
// • Control.NotebookbarWriter.js:701-714 hardcodes the fontsizecombobox
//   widget definition with a single-element entries list:
//
//      { id: 'fontsizecombobox', type: 'combobox',
//        text: '12 pt', entries: ['12 pt'], … }
//
//   This is the same bug pattern as the previously-fixed fontnamecombobox
//   (line 691: entries: ['Carlito']), which was repaired by calling
//   map.createFontSelector('fontnamecombobox') in Control.NotebookbarBase
//   onAdd (line 52). createFontSelector pulls font names from the
//   .uno:CharFontName toolbarcommandvalues.
//
// • Compact toolbar (Control.TopToolbar.js:154) ships the proper static
//   list: entries: ['6','7','8','9','10','10.5','11','12','13','14',...].
//   onDocLayerInit also calls createFontSizeSelector('fontsizecombobox')
//   (line 432) to wire commandstate updates — but createFontSizeSelector
//   in Toolbar.js:83 does NOT populate entries from a command (sizes
//   come from the static array on the compact side).
//
// • NotebookbarBase.onAdd never calls createFontSizeSelector AND
//   never replaces entries[] — so the user only ever sees the single
//   '12 pt' that was hardcoded as the placeholder.
//
// This test reproduces the bug by opening the dropdown and counting
// visible entries. We assert ≥ 5 entries; the bug shows 1.

const { launch, sleep } = require('./lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-fontsize-dropdown';
const DOC_NAME = 'fontsize-dropdown-' + Date.now() + '.docx';
const DOC_PATH = path.join(__dirname, '..', 'test', 'data', 'new.docx');

const T0 = Date.now();
function log(m) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch (e) {}
    log(`[snap] ${f}`);
}

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

async function getEditorFrame(page, fileId) {
    return page.frames().find(f =>
        f.url().includes('cool.html') && (!fileId || f.url().includes(fileId)));
}

async function getStatus(frame) {
    if (!frame) return '';
    try {
        return await frame.evaluate(() =>
            document.querySelector('#StateWordCount')?.textContent?.trim() || '');
    } catch (e) { return ''; }
}

(async () => {
    log('=== Regression Bug 1: font-size dropdown entries (notebookbar) ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(DOC_PATH)) {
        log('ERROR: fixture missing: ' + DOC_PATH);
        process.exit(1);
    }

    const userDataDir = path.join(require('os').tmpdir(),
        'fontsize-dropdown-' + Date.now() + '-' + process.pid);
    fs.mkdirSync(userDataDir, { recursive: true });

    const { browser, cleanup } = await launch({ width: 1920, height: 1080 });

    try {
        const bytes = fs.readFileSync(DOC_PATH);
        const up = await uploadV2(VIEWER, DOC_NAME, bytes);
        log(`Uploaded ${DOC_NAME} (${(bytes.length / 1024).toFixed(1)} KB)`);

        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        page.on('pageerror', e => log(`[pageerror] ${e.message}`));

        const url = VIEWER + '/?singleuser&planc=1#file=' + up.b64urlSecret;
        log(`Navigating to ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

        let frame = null;
        const deadline = Date.now() + 240000;
        while (Date.now() < deadline) {
            await sleep(500);
            frame = await getEditorFrame(page, up.fileId);
            if (!frame) continue;
            const st = await getStatus(frame);
            if (/\d+\s+character/i.test(st)) break;
        }
        check('Editor frame loaded', frame && /\d+\s+character/i.test(await getStatus(frame)));
        if (!frame) throw new Error('editor frame never loaded');

        await sleep(4000);
        await snap(page, 'editor_loaded');

        // Sanity: Notebookbar mode active.
        const tabCount = await frame.evaluate(() =>
            document.querySelectorAll('[id$="-tab-label"]').length).catch(() => 0);
        check('Notebookbar mode active (>=5 tab labels)', tabCount >= 5, 'tabs=' + tabCount);

        // Locate the fontsizecombobox container.
        const comboboxRect = await frame.evaluate(() => {
            const root = document.getElementById('fontsizecombobox');
            if (!root) return null;
            const r = root.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
        }).catch(() => null);
        log(`#fontsizecombobox rect: ${JSON.stringify(comboboxRect)}`);
        check('#fontsizecombobox container present', comboboxRect && comboboxRect.w > 0);

        // Read the static entries list defined in the widget JSON model.
        // Bug: Control.NotebookbarWriter.js hardcodes only ['12 pt'].
        const modelEntries = await frame.evaluate(() => {
            try {
                // jsdialog model is reachable via the notebookbar component.
                const nb = window.app && window.app.map && window.app.map.uiManager
                    && window.app.map.uiManager.notebookbar;
                if (!nb) return null;
                const widget = nb.model && nb.model.getById && nb.model.getById('fontsizecombobox');
                return widget && widget.entries ? widget.entries.slice(0, 40) : null;
            } catch (e) { return 'ERR:' + e.message; }
        }).catch(() => null);
        log(`Model widget.entries for fontsizecombobox: ${JSON.stringify(modelEntries)}`);

        // Open the dropdown by clicking the arrow — most accurate reproduction
        // of the user flow.
        const iframeEl = await page.$('iframe#editor-frame');
        const ifBox = await iframeEl.boundingBox();
        if (comboboxRect) {
            // Click near the right edge (the dropdown arrow).
            const ax = ifBox.x + comboboxRect.x + comboboxRect.w - 10;
            const ay = ifBox.y + comboboxRect.y + comboboxRect.h / 2;
            await page.mouse.click(ax, ay);
            await sleep(800);
            await snap(page, 'dropdown_open_arrow');
        }

        // Measure visible entries in the open dropdown.
        // jsdialog combobox renders entries inside an .ui-combobox-content
        // / .ui-listbox-entry list portaled into a wrapper near the input.
        const visibleEntryInfo = await frame.evaluate(() => {
            // Possible selectors used by the jsdialog combobox dropdown.
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
            // Fallback: anything labeled with role=option in the page.
            const opts = document.querySelectorAll('[role="option"]');
            return { selector: '[role=option]', count: opts.length,
                     texts: Array.from(opts).slice(0, 10).map(e => e.textContent.trim()) };
        }).catch(() => ({ count: 0, texts: [] }));
        log(`Visible dropdown entries: ${JSON.stringify(visibleEntryInfo)}`);

        await snap(page, 'dropdown_visible_entries');

        // Capture either the model entries list size (preferred — covers the
        // case where the dropdown is rendered server-side via jsdialog and the
        // open-arrow click doesn't land), OR the visible DOM entry count.
        const modelEntryCount = Array.isArray(modelEntries) ? modelEntries.length : 0;
        const visibleEntryCount = visibleEntryInfo.count || 0;
        const effectiveCount = Math.max(modelEntryCount, visibleEntryCount);
        log(`Effective entry count: ${effectiveCount} (model=${modelEntryCount}, visible=${visibleEntryCount})`);

        check(`fontsizecombobox has >=5 entries (saw ${effectiveCount})`,
              effectiveCount >= 5,
              `model=${JSON.stringify(modelEntries)} visible=${JSON.stringify(visibleEntryInfo.texts)}`);

        log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    } catch (e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        await cleanup();
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
