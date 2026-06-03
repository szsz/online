const __cl = require('../../lib/inject-checklist');
// Regression: Bug 2 — preformatted style picker (Heading 1, Heading 2,
// Title, Caption, Index, …) does nothing in Notebookbar mode.
//
// User-reported: select a paragraph, click on "Heading 1" in the
// notebookbar Styles dropdown — the paragraph style does not change.
//
// Suspected root cause (read-only inspection):
//
// • Compact-mode styles widget (Control.TopToolbar.js:152) is a
//   {type: 'combobox', id: 'styles'}. When the user picks an entry it
//   fires the `selected` callback at TopToolbar:81-89, which calls
//   onStyleSelect → map.applyStyle(style, 'ParagraphStyles') — a real
//   uno .uno:StyleApply message (Toolbar.js:222-234).
//
// • Notebookbar styles widget (Control.NotebookbarWriter.js:947-963) is
//   a `{type: 'iconviewlist', children: [{type: 'iconview',
//   id: 'stylesview'}]}`. The iconview's click handler in
//   Widget.IconView.ts:152-183 fires builderCallback('iconview',
//   'select', entry.row, builder) — the row INDEX (an integer), not
//   the style name. _defaultCallbackHandler (Control.JSDialogBuilder.js
//   :273-299) sends this as `dialogevent <wid> {"id":"stylesview",
//   "cmd":"select","data":<row>,"type":"iconview"}`.
//
// • There is no stylesview-specific handler in Control.NotebookbarBuilder
//   .js _overrideHandlers — unlike fontnamecombobox (line 39-49) and
//   fontsizecombobox (line 50-60) which each have a custom branch that
//   maps the data → applyFont / applyFontSize. The styles iconview
//   relies entirely on the WASM core's Notebookbar dialog manager
//   resolving "iconview select <row>" back to a .uno:StyleApply, which
//   does not happen in this setup (no StyleApply ever leaves the
//   browser).
//
// This test reproduces the bug by:
//   1. opening a writer doc,
//   2. selecting a paragraph,
//   3. clicking on the "Heading 1" entry in #stylesview,
//   4. checking the .uno:StyleApply state in the kit.

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-heading-styles';
const DOC_NAME = 'heading-styles-' + Date.now() + '.docx';
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

async function getStyleApply(frame) {
    return frame.evaluate(() => {
        try {
            const m = window.app && window.app.map;
            if (!m) return null;
            const sc = m['stateChangeHandler'];
            if (sc && typeof sc.getItemValue === 'function') {
                return sc.getItemValue('.uno:StyleApply');
            }
            return null;
        } catch (e) { return 'ERR:' + e.message; }
    }).catch(() => null);
}

(async () => {
    log('=== Regression Bug 2: heading style picker (notebookbar) ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(DOC_PATH)) {
        log('ERROR: fixture missing: ' + DOC_PATH);
        process.exit(1);
    }

    const userDataDir = path.join(require('os').tmpdir(),
        'heading-styles-' + Date.now() + '-' + process.pid);
    fs.mkdirSync(userDataDir, { recursive: true });

    const { browser, cleanup } = await launch({ width: 1920, height: 1080 });

    try {
        const bytes = fs.readFileSync(DOC_PATH);
        const up = await uploadV2(VIEWER, DOC_NAME, bytes);
        log(`Uploaded ${DOC_NAME} (${(bytes.length / 1024).toFixed(1)} KB)`);

        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        page.on('pageerror', e => log(`[pageerror] ${e.message}`));
        page.on('console', m => {
            const t = m.text();
            if (/style|StyleApply|dialogevent|stylesview/i.test(t))
                log(`[page] ${t.substring(0, 220)}`);
        });

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

        const tabCount = await frame.evaluate(() =>
            document.querySelectorAll('[id$="-tab-label"]').length).catch(() => 0);
        check('Notebookbar mode active', tabCount >= 5, 'tabs=' + tabCount);

        // Select all so we have a definite paragraph selection.
        await frame.evaluate(() => window.app.map.sendUnoCommand('.uno:SelectAll'));
        await sleep(1500);
        const stAfterSelect = await getStatus(frame);
        log(`After SelectAll: "${stAfterSelect}"`);

        // Read initial style state.
        const styleBefore = await getStyleApply(frame);
        log(`Initial .uno:StyleApply = "${styleBefore}"`);

        // Inspect the stylesview iconview entries — populated dynamically
        // via NotebookbarBase.onCommandValues from .uno:StyleApply (line
        // 138-189). We need to find the row index for "Heading 1".
        const stylesEntries = await frame.evaluate(() => {
            try {
                const nb = window.app && window.app.map && window.app.map.uiManager
                    && window.app.map.uiManager.notebookbar;
                if (!nb) return null;
                const w = nb.model && nb.model.getById && nb.model.getById('stylesview');
                if (!w || !w.entries) return null;
                return w.entries.slice(0, 30).map(e => ({
                    text: e.text, id: e.id, row: e.row,
                }));
            } catch (e) { return 'ERR:' + e.message; }
        }).catch(() => null);
        log(`stylesview entries: ${JSON.stringify(stylesEntries)}`);
        check('stylesview entries present', Array.isArray(stylesEntries) && stylesEntries.length > 0,
              'count=' + (stylesEntries && stylesEntries.length));

        // Locate Heading 1 entry.
        const heading1 = Array.isArray(stylesEntries) ? stylesEntries.find(e =>
            /heading\s*1\b/i.test(e.text || '') || /heading\s*1\b/i.test(e.id || '')
        ) : null;
        log(`Heading 1 entry: ${JSON.stringify(heading1)}`);

        // Tap monitor on outgoing socket messages so we can see exactly what
        // (if anything) the click sends.
        await frame.evaluate(() => {
            try {
                window.__sentMsgs = [];
                const sock = window.app && window.app.socket;
                if (!sock) return;
                const orig = sock.sendMessage.bind(sock);
                sock.sendMessage = function(msg) {
                    try {
                        if (typeof msg === 'string' &&
                            (/StyleApply|stylesview|dialogevent/i.test(msg)))
                            window.__sentMsgs.push(msg.substring(0, 300));
                    } catch (e) {}
                    return orig(msg);
                };
            } catch (e) {}
        });

        // Click the Heading 1 entry.
        let clicked = false;
        if (heading1) {
            const clickResult = await frame.evaluate((row) => {
                const root = document.getElementById('stylesview');
                if (!root) return 'no stylesview';
                const entries = root.querySelectorAll('.ui-iconview-entry');
                if (!entries || !entries.length) return 'no entries';
                // Entries are in rendered order; find by id suffix _<row>.
                const target = root.querySelector('#stylesview_' + row) || entries[row];
                if (!target) return 'no target';
                const r = target.getBoundingClientRect();
                target.click();
                return 'clicked at ' + JSON.stringify({ x: r.x, y: r.y });
            }, heading1.row).catch(e => 'err:' + e.message);
            log(`Heading 1 click result: ${clickResult}`);
            clicked = true;
        } else {
            log('Could not find Heading 1 entry — falling back to direct UNO command');
        }
        await sleep(2500);
        await snap(page, 'after_heading1_click');

        // Capture which messages went out.
        const sent = await frame.evaluate(() => window.__sentMsgs || []).catch(() => []);
        log(`Outgoing messages mentioning style: ${JSON.stringify(sent)}`);
        const sentStyleApply = sent.some(m => /uno \.uno:StyleApply/i.test(m));
        log(`A real .uno:StyleApply uno command went out: ${sentStyleApply}`);

        // Read style state after.
        let styleAfter = null;
        let pollDeadline = Date.now() + 6000;
        while (Date.now() < pollDeadline) {
            styleAfter = await getStyleApply(frame);
            if (styleAfter && /heading\s*1/i.test(styleAfter)) break;
            await sleep(300);
        }
        log(`Final .uno:StyleApply = "${styleAfter}" (was "${styleBefore}")`);

        check('Click on Heading 1 sent uno .uno:StyleApply',
              sentStyleApply,
              'sent=' + JSON.stringify(sent));
        check('Selected paragraph style is now Heading 1',
              styleAfter && /heading\s*1/i.test(styleAfter),
              'before="' + styleBefore + '" after="' + styleAfter + '"');

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
