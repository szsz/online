const __cl = require('../../lib/inject-checklist');
// Regression: Bug 1 — font-size dropdown change in 2-browser co-edit.
//
// Companion to test-regression-fontsize-dropdown.js (single-browser).
// Verifies that when A picks "24" from the font-size combobox, the size
// change propagates over the relay so that B's DOM reflects "24" when
// B's caret enters the resized region. All input via real keyboard /
// mouse — no `evaluate()` shortcuts that bypass the UI.
//
// Steps:
//   1. Both A and B open same docx via the viewer.
//   2. A types "SIZED_TEXT", selects it (Ctrl+A).
//   3. A clicks the #fontsizecombobox arrow, picks the entry "24".
//   4. Wait 5 s for relay forwarding.
//   5. B clicks into the canvas to land its caret in the SIZED region.
//   6. Assert on B that the visible font-size widget reads "24" / "24 pt".
//   7. Assert canvas pixel-hash on B differs from baseline (size visible).

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');
const crypto = require('crypto');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-fontsize-coedit';
const DOC_NAME = 'fontsize-coedit-' + Date.now() + '.docx';
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
    // Hash a snapshot of the visible page so we can detect pixel change.
    const buf = await page.screenshot({ type: 'png' });
    return crypto.createHash('sha256').update(buf).digest('hex').substring(0, 12);
}

(async () => {
    log('=== Regression Bug 1 (co-edit): font-size dropdown change propagates ===');
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

        // ── A types "SIZED_TEXT" at end of doc, selects it ──
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('End');
        await pageA.keyboard.up('Control');
        await sleep(500);
        await pageA.keyboard.press('Enter');
        await sleep(400);
        await pageA.keyboard.type('SIZED_TEXT', { delay: 60 });
        await sleep(1500);

        // Select all so the font-size apply has a definite range.
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('a');
        await pageA.keyboard.up('Control');
        await sleep(800);
        await snap(pageA, 'A_typed_and_selected');

        // Capture B's canvas hash BEFORE the size change for diff later.
        await sleep(3000); // let the typed text show on B first
        const baselineB = await canvasHash(pageB);
        log(`B canvas hash baseline: ${baselineB}`);
        await snap(pageB, 'B_before_size_change');

        // ── A clicks the fontsizecombobox dropdown arrow, picks "24" ──
        const comboboxRect = await frA.evaluate(() => {
            const root = document.getElementById('fontsizecombobox');
            if (!root) return null;
            const r = root.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
        }).catch(() => null);
        log(`A #fontsizecombobox rect: ${JSON.stringify(comboboxRect)}`);
        check('A: #fontsizecombobox container present',
              comboboxRect && comboboxRect.w > 0,
              JSON.stringify(comboboxRect));

        const iframeEl = await pageA.$('iframe#editor-frame');
        const ifBox = await iframeEl.boundingBox();
        if (comboboxRect) {
            // Click near the right edge (the dropdown arrow).
            const ax = ifBox.x + comboboxRect.x + comboboxRect.w - 10;
            const ay = ifBox.y + comboboxRect.y + comboboxRect.h / 2;
            await pageA.mouse.click(ax, ay);
            await sleep(800);
            await snap(pageA, 'A_dropdown_open');
        }

        // Find the "24" entry and click it via real mouse on its rect.
        const targetRect = await frA.evaluate(() => {
            const sels = [
                '#fontsizecombobox-dropdown .ui-combobox-entry',
                '#fontsizecombobox .ui-combobox-entry',
                '.ui-combobox-content .ui-combobox-entry',
                '.jsdialog .ui-combobox-entry',
                '.jsdialog .ui-listbox-entry',
                '[role="option"]',
            ];
            for (const s of sels) {
                const els = document.querySelectorAll(s);
                for (const el of els) {
                    const txt = (el.textContent || '').trim();
                    if (txt === '24' || txt === '24 pt') {
                        const r = el.getBoundingClientRect();
                        return { x: r.x, y: r.y, w: r.width, h: r.height, text: txt };
                    }
                }
            }
            return null;
        }).catch(() => null);
        log(`A: '24' entry rect: ${JSON.stringify(targetRect)}`);
        check('A: dropdown shows a "24" entry',
              targetRect && targetRect.w > 0,
              JSON.stringify(targetRect));

        if (targetRect) {
            await pageA.mouse.click(
                ifBox.x + targetRect.x + targetRect.w / 2,
                ifBox.y + targetRect.y + targetRect.h / 2);
            await sleep(1500);
            await snap(pageA, 'A_after_pick_24');
        }

        // ── Wait for relay forwarding to B ──
        log('Waiting 5s for relay to forward font-size change to B...');
        await sleep(5000);

        // ── On B: move caret into the SIZED_TEXT (Ctrl+End is enough,
        //   the typed text is the last paragraph). Use mouse click on
        //   canvas first to ensure focus, then Ctrl+End.
        await clickCanvas(pageB);
        await pageB.keyboard.down('Control');
        await pageB.keyboard.press('End');
        await pageB.keyboard.up('Control');
        await sleep(2500);
        await snap(pageB, 'B_after_propagation');

        // ── DOM-only assertion on B: font-size widget shows "24" ──
        // Try the visible combobox text input first, then the model entry.
        const sizeOnB = await frB.evaluate(() => {
            const out = { input: null, hidden: null };
            // The combobox renders as <div id="fontsizecombobox">
            //   <input class="ui-combobox-content" value="..."> ...
            const root = document.getElementById('fontsizecombobox');
            if (root) {
                const inp = root.querySelector('input');
                if (inp) out.input = inp.value || inp.getAttribute('value') || null;
                // Sometimes the combobox shows a span / text node label.
                const lbl = root.querySelector('.ui-combobox-content');
                if (lbl) out.hidden = (lbl.textContent || '').trim()
                    || lbl.value || null;
            }
            return out;
        }).catch(() => ({ input: null, hidden: null }));
        log(`B fontsizecombobox readout: ${JSON.stringify(sizeOnB)}`);

        const bSizeStr = `${sizeOnB.input || ''} ${sizeOnB.hidden || ''}`;
        check('B: visible #fontsizecombobox shows "24"',
              /\b24\b/.test(bSizeStr),
              JSON.stringify(sizeOnB));

        // ── Pixel-hash check: B's canvas should have changed ──
        const afterB = await canvasHash(pageB);
        log(`B canvas hash after propagation: ${afterB} (was ${baselineB})`);
        check('B canvas pixel-hash differs from baseline (visual change)',
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
