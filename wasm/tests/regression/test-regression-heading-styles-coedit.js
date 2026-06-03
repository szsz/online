const __cl = require('./lib/inject-checklist');
// Regression: Bug 2 — heading-style picker change in 2-browser co-edit.
//
// Companion to test-regression-heading-styles.js (single-browser).
// Verifies that when A applies "Heading 1" via the notebookbar styles
// iconview, the style change reaches B over the relay so that B's DOM
// reflects "Heading 1" as the active style when B's caret is in the
// styled paragraph. All input via real keyboard / mouse.
//
// Steps:
//   1. Both A and B open the same docx via the viewer.
//   2. A types "HEADING_TEXT" on a fresh paragraph at end of doc, selects it.
//   3. A clicks the Heading 1 entry in the #stylesview iconview (UI click,
//      same selectors as test-regression-heading-styles.js).
//   4. Wait 5 s for relay forwarding.
//   5. B clicks into the canvas, Ctrl+End to land caret in the heading.
//   6. Assert on B that the styles widget shows Heading 1 selected
//      (DOM check on iconview entry's active class / text).
//   7. Assert canvas pixel-hash on B differs from baseline.

const { launch, sleep } = require('./lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');
const crypto = require('crypto');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-heading-styles-coedit';
const DOC_NAME = 'heading-coedit-' + Date.now() + '.docx';
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
        f.url().includes('cool.html') && f.url().includes(fileId));
}
async function getStatus(frame) {
    if (!frame) return '';
    try {
        return await frame.evaluate(() =>
            document.querySelector('#StateWordCount')?.textContent?.trim() || '');
    } catch (e) { return ''; }
}

async function openInViewer(browser, label, fileId, b64urlSecret) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    page.on('pageerror', e => log(`[${label} pageerror] ${e.message}`));
    await page.goto(VIEWER + '/?planc=1#file=' + b64urlSecret,
        { waitUntil: 'domcontentloaded', timeout: 90000 });
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
        const fr = await getEditorFrame(page, fileId);
        if (fr) {
            const st = await getStatus(fr);
            if (/\d+\s+character/i.test(st)) {
                log(`[${label}] Loaded: "${st}"`);
                return page;
            }
        }
        await sleep(500);
    }
    throw new Error(`[${label}] never loaded`);
}

async function clickCanvas(page) {
    const frameEl = await page.$('iframe#editor-frame');
    if (frameEl) {
        const box = await frameEl.boundingBox();
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    await sleep(400);
}

async function canvasHash(page) {
    const buf = await page.screenshot({ type: 'png' });
    return crypto.createHash('sha256').update(buf).digest('hex').substring(0, 12);
}

(async () => {
    log('=== Regression Bug 2 (co-edit): Heading style propagates ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(DOC_PATH)) {
        log('ERROR: fixture missing: ' + DOC_PATH);
        process.exit(1);
    }

    const { browser, cleanup } = await launch({ width: 1920, height: 1080 });

    try {
        const bytes = fs.readFileSync(DOC_PATH);
        const up = await uploadV2(VIEWER, DOC_NAME, bytes);
        log(`Uploaded ${DOC_NAME} (${(bytes.length / 1024).toFixed(1)} KB)`);

        const pageA = await openInViewer(browser, 'A', up.fileId, up.b64urlSecret);
        await sleep(8000);
        const pageB = await openInViewer(browser, 'B', up.fileId, up.b64urlSecret);
        await sleep(15000);

        const frA = await getEditorFrame(pageA, up.fileId);
        const frB = await getEditorFrame(pageB, up.fileId);
        check('A and B both have editor frames', !!frA && !!frB);

        await snap(pageA, 'A_setup');
        await snap(pageB, 'B_initial');

        // ── A types "HEADING_TEXT" on a fresh paragraph, selects it ──
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('End');
        await pageA.keyboard.up('Control');
        await sleep(500);
        await pageA.keyboard.press('Enter');
        await sleep(400);
        await pageA.keyboard.type('HEADING_TEXT', { delay: 60 });
        await sleep(1500);

        // Select the line: Home, then Shift+End.
        await pageA.keyboard.press('Home');
        await sleep(300);
        await pageA.keyboard.down('Shift');
        await pageA.keyboard.press('End');
        await pageA.keyboard.up('Shift');
        await sleep(800);
        await snap(pageA, 'A_typed_and_selected');

        // Let the typed text reach B before the style change.
        await sleep(3000);
        const baselineB = await canvasHash(pageB);
        log(`B canvas hash baseline: ${baselineB}`);
        await snap(pageB, 'B_before_style_change');

        // ── A clicks the Heading 1 entry in the #stylesview iconview ──
        // Read the model entries to find the row index for "Heading 1".
        const stylesEntries = await frA.evaluate(() => {
            try {
                const nb = window.app && window.app.map && window.app.map.uiManager
                    && window.app.map.uiManager.notebookbar;
                if (!nb || !nb.model || !nb.model.getById) return null;
                const w = nb.model.getById('stylesview');
                if (!w || !w.entries) return null;
                return w.entries.slice(0, 30).map(e => ({
                    text: e.text, id: e.id, row: e.row,
                }));
            } catch (e) { return 'ERR:' + e.message; }
        }).catch(() => null);
        log(`A stylesview entries: ${JSON.stringify(stylesEntries)}`);

        const heading1 = Array.isArray(stylesEntries) ? stylesEntries.find(e =>
            /heading\s*1\b/i.test(e.text || '') || /heading\s*1\b/i.test(e.id || '')
        ) : null;
        log(`A: Heading 1 entry: ${JSON.stringify(heading1)}`);
        check('A: stylesview model has a Heading 1 entry',
              !!heading1, JSON.stringify(stylesEntries));

        // Locate the rendered DOM element and click it via real mouse on its rect.
        if (heading1) {
            const rect = await frA.evaluate((row) => {
                const root = document.getElementById('stylesview');
                if (!root) return null;
                const target = root.querySelector('#stylesview_' + row)
                    || root.querySelectorAll('.ui-iconview-entry')[row];
                if (!target) return null;
                const r = target.getBoundingClientRect();
                return { x: r.x, y: r.y, w: r.width, h: r.height };
            }, heading1.row).catch(() => null);
            log(`A: Heading 1 rect: ${JSON.stringify(rect)}`);
            check('A: Heading 1 entry rendered in iconview',
                  rect && rect.w > 0, JSON.stringify(rect));

            if (rect && rect.w > 0) {
                const iframeEl = await pageA.$('iframe#editor-frame');
                const ifBox = await iframeEl.boundingBox();
                await pageA.mouse.click(
                    ifBox.x + rect.x + rect.w / 2,
                    ifBox.y + rect.y + rect.h / 2);
                await sleep(2000);
                await snap(pageA, 'A_after_pick_heading1');
            }
        }

        // ── Wait for relay forwarding to B ──
        log('Waiting 5s for relay to forward style change to B...');
        await sleep(5000);

        // ── On B: caret into the heading paragraph (Ctrl+End suffices,
        //   the new heading paragraph is at end of document). ──
        await clickCanvas(pageB);
        await pageB.keyboard.down('Control');
        await pageB.keyboard.press('End');
        await pageB.keyboard.up('Control');
        await sleep(2500);
        await snap(pageB, 'B_after_propagation');

        // ── DOM-only assertion on B: the active stylesview entry / the
        //    visible "Paragraph Style" combobox should be Heading 1.
        //    Poll up to 30 s — the kit forwards .uno:StyleApply state-change
        //    events asynchronously after the canvas re-paints, so the
        //    iconview's `.selected` class lags the canvas pixel-hash flip.
        //    A one-shot read after a fixed sleep is timing-fragile; polling
        //    catches real bugs (if 30 s isn't enough, the propagation is
        //    actually broken). ──
        const probeStyle = async () => frB.evaluate(() => {
            const out = { activeText: null, comboInput: null, comboLabel: null };
            const root = document.getElementById('stylesview');
            if (root) {
                const sel = root.querySelector(
                    '.ui-iconview-entry.selected, .ui-iconview-entry.active, ' +
                    '.ui-iconview-entry[aria-selected="true"]');
                if (sel) out.activeText = (sel.textContent || '').trim();
            }
            const candidates = ['applystyle', 'paragraphstyles', 'styles'];
            for (const id of candidates) {
                const w = document.getElementById(id);
                if (!w) continue;
                const inp = w.querySelector('input');
                if (inp && (inp.value || '').trim()) {
                    out.comboInput = inp.value.trim();
                    break;
                }
                const lbl = w.querySelector('.ui-combobox-content');
                if (lbl) {
                    const t = (lbl.textContent || '').trim()
                        || lbl.value || '';
                    if (t) { out.comboLabel = t; break; }
                }
            }
            return out;
        }).catch(() => ({}));
        let styleOnB = {};
        const stylePollDeadline = Date.now() + 30000;
        while (Date.now() < stylePollDeadline) {
            styleOnB = await probeStyle();
            const text = `${styleOnB.activeText || ''} ${styleOnB.comboInput || ''} ${styleOnB.comboLabel || ''}`;
            if (/heading\s*1/i.test(text)) break;
            await sleep(1000);
        }
        log(`B style readout: ${JSON.stringify(styleOnB)}`);

        const allText = `${styleOnB.activeText || ''} ${styleOnB.comboInput || ''} ${styleOnB.comboLabel || ''}`;
        check('B: visible style picker shows Heading 1 active',
              /heading\s*1/i.test(allText),
              JSON.stringify(styleOnB));

        // ── Pixel-hash check on B ──
        const afterB = await canvasHash(pageB);
        log(`B canvas hash after propagation: ${afterB} (was ${baselineB})`);
        check('B canvas pixel-hash differs from baseline (Heading 1 visible)',
              afterB !== baselineB,
              `before=${baselineB} after=${afterB}`);

        log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    } catch (e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        await cleanup();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
