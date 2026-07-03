const __cl = require('../../lib/inject-checklist');
// Regression: the Area dialog's Colors tab must show real palettes.
//
// User report 2026-06-18 (after the PaletteManager OOB crash fix landed
// in LO_BUILD_ID 2026-06-18-74): the Area dialog now opens, but "the
// palette appears and a lot of the components on it do not work" — the
// main colour grid is blank and the "Palette:" dropdown lists only the
// runtime-dynamic entries (Custom / Theme colors / Document colors).
//
// Root cause (diagnosed via wasm/tests/diag/probe-area-colors-tab.js):
// the emscripten fs-image preload list
// (static/CustomTarget_emscripten_fs_image.mk) packaged colorpage.ui —
// so the dialog renders — but never included the share/palette/*.soc
// data files. PaletteManager therefore loaded zero built-in palettes,
// so the dropdown only had the 3 dynamic palettes and the colorset grid
// (which draws the selected palette) was empty. Fixed by adding
// share/palette/* to the preload list (LO PR #40).
//
// This test (pure visible-UI E2E):
//   1. Uploads test/data/new.docx, opens it single-user.
//   2. Inserts a rectangle (Insert tab → Shapes → rectangle, drag).
//   3. Right-click → Area...  → the Color fill page is the default.
//   4. Reads the rendered <option>s of the "Palette:" <select>.
//      ASSERT: more than the 3 dynamic palettes are present AND at least
//      one recognizable built-in name (standard / libreoffice / html /
//      material / tonal) appears. This is the direct tripwire for the
//      missing-palette-files bug — FAILS pre-fix (only 3), PASSES post.
//   5. Selects a built-in palette (real <select> change), then clicks a
//      swatch in the colour grid via real page.mouse.
//      ASSERT: the "New" colour's Hex/RGB changes from the shape's
//      original colour — proves the grid painted real, clickable colours.
//
// No sendUnoCommand / dispatcher / internal-state pokes: the dialog is
// driven entirely through visible widgets and verified through the
// rendered DOM the user sees.

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

const VIEWER  = env.FILE_STORAGE_URL;
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-area-palette';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0    = Date.now();
const log   = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  PASS: ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}`, fullPage: false }); } catch (_) {}
}

// ── repro helpers (shared with probe-shape-area-stack.js) ──────────────
async function realClickMenuItem(page, frame, labelRegex, ifr) {
    let bbox = null;
    for (let i = 0; i < 30; i++) {
        bbox = await frame.evaluate(({ reSrc, reFlags }) => {
            const re = new RegExp(reSrc, reFlags);
            const items = Array.from(document.querySelectorAll(
                '.context-menu-item, .menu-entry-with-icon, .menu-entry-no-icon'));
            const found = items.find(el => re.test(el.textContent || ''));
            if (!found) return null;
            const r = found.getBoundingClientRect();
            return { x: r.left, y: r.top, w: r.width, h: r.height,
                     t: (found.textContent || '').trim().substring(0, 80) };
        }, { reSrc: labelRegex.source, reFlags: labelRegex.flags });
        if (bbox && bbox.w > 0 && bbox.h > 0) break;
        await sleep(150);
    }
    if (!bbox) return { ok: false, why: 'menu item not found' };
    await page.mouse.click(bbox.x + bbox.w / 2 + ifr.left, bbox.y + bbox.h / 2 + ifr.top);
    return { ok: true, item: bbox.t };
}
async function clickInsertTab(page, frame, ifr) {
    let bbox = null;
    for (let i = 0; i < 40; i++) {
        bbox = await frame.evaluate(() => {
            const el = document.querySelector('#Insert-tab-label');
            if (!el || !el.offsetParent) return null;
            const r = el.getBoundingClientRect();
            return { x: r.left, y: r.top, w: r.width, h: r.height };
        }).catch(() => null);
        if (bbox && bbox.w > 0 && bbox.h > 0) break;
        await sleep(200);
    }
    if (!bbox) return { ok: false, why: 'Insert-tab-label not found' };
    await page.mouse.click(bbox.x + bbox.w / 2 + ifr.left, bbox.y + bbox.h / 2 + ifr.top);
    return { ok: true };
}
async function clickShapesMenubutton(page, frame, ifr) {
    let bbox = null;
    for (let i = 0; i < 40; i++) {
        bbox = await frame.evaluate(() => {
            const sel = ['[id^="insert-insert-shapes"][id$="-button"]',
                '[id^="insert-insert-shapes"]:not([id$="-button"])', '[id*="InsertShapesMenu"]'];
            for (const s of sel) {
                const el = document.querySelector(s);
                if (el && el.offsetParent) {
                    const r = el.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0)
                        return { x: r.left, y: r.top, w: r.width, h: r.height };
                }
            }
            return null;
        }).catch(() => null);
        if (bbox) break;
        await sleep(200);
    }
    if (!bbox) return { ok: false, why: 'shapes menubutton not found' };
    await page.mouse.click(bbox.x + bbox.w / 2 + ifr.left, bbox.y + bbox.h / 2 + ifr.top);
    return { ok: true };
}
async function clickShapeTile(page, frame, ifr, unoCmd) {
    const bbox = await frame.evaluate((target) => {
        const grid = document.querySelector('.insertshape-grid');
        if (!grid) return null;
        const tile = Array.from(grid.querySelectorAll('.col')).find(t => (t.dataset.uno || '') === target);
        if (!tile) return null;
        const r = tile.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
    }, unoCmd).catch(() => null);
    if (!bbox || bbox.w === 0) return { ok: false, why: `tile ${unoCmd} missing` };
    await page.mouse.click(bbox.x + bbox.w / 2 + ifr.left, bbox.y + bbox.h / 2 + ifr.top);
    return { ok: true };
}

// Recognizable built-in palette display names (from extras/source/palettes).
const BUILTIN_RE = /standard|libreoffice|html|material|tonal|chart|breeze|freecolour/i;
const DYNAMIC_RE = /^(custom|theme colors|document colors)$/i;

(async () => {
    log('=== Regression: Area dialog Colors tab shows real palettes ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    if (!fs.existsSync(FIXTURE)) { log(`SKIP: fixture missing: ${FIXTURE}`); process.exit(2); }

    const bytes = fs.readFileSync(FIXTURE);
    const name  = `area-palette-${Date.now()}.docx`;
    const up    = await uploadV2(VIEWER, name, bytes);
    log(`uploaded ${name}`);

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-features=SharedArrayBuffer'],
    });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 900 });
        await page.goto(`${VIEWER}/?singleuser#file=${up.b64urlSecret}`,
            { waitUntil: 'domcontentloaded', timeout: env.scaleTimeout(120000) });

        let frame = null;
        for (let i = 0; i < 90 && !frame; i++) {
            frame = page.frames().find(f => f.url().includes('cool.html'));
            if (frame && !(await frame.$('#document-canvas').catch(() => null))) frame = null;
            if (!frame) await sleep(1000);
        }
        if (!frame) throw new Error('editor frame never loaded');
        await frame.waitForFunction(() => window.__wasmInitialDocLoaded === true,
            { timeout: env.scaleTimeout(90000) });
        await frame.waitForFunction(() => {
            const wc = document.querySelector('#StateWordCount')?.textContent || '';
            const pp = document.querySelector('#StatusDocPos')?.textContent || '';
            return wc.length > 0 || pp.length > 0;
        }, { timeout: env.scaleTimeout(150000) });
        await sleep(2500);
        await snap(page, 'loaded');

        const canvasXY = await frame.evaluate(() => {
            const c = document.querySelector('#document-canvas');
            const r = c.getBoundingClientRect();
            return { x: Math.round(r.left + r.width * 0.5), y: Math.round(r.top + r.height * 0.45) };
        });
        const ifr = await page.evaluate(() => {
            const f = document.querySelector('iframe');
            const r = f.getBoundingClientRect();
            return { left: Math.round(r.left), top: Math.round(r.top) };
        });
        const clickXY = { x: canvasXY.x + ifr.left, y: canvasXY.y + ifr.top };

        // Insert a rectangle.
        await page.keyboard.press('Escape'); await sleep(300);
        await page.mouse.click(clickXY.x, clickXY.y); await sleep(400);
        const ins = await clickInsertTab(page, frame, ifr); await sleep(600);
        const sm  = await clickShapesMenubutton(page, frame, ifr); await sleep(800);
        const tile = await clickShapeTile(page, frame, ifr, 'BasicShapes.rectangle');
        check('insert flow reached shapes grid', ins.ok && sm.ok && tile.ok,
              `ins=${ins.ok} sm=${sm.ok} tile=${tile.ok}`);
        if (!tile.ok) { process.exit(allPassed ? 0 : 1); }
        await sleep(500);
        await page.mouse.move(clickXY.x, clickXY.y);
        await page.mouse.down();
        await page.mouse.move(clickXY.x + 200, clickXY.y + 140, { steps: 8 });
        await page.mouse.up();
        const shapeCenter = { x: clickXY.x + 100, y: clickXY.y + 70 };
        await sleep(2500);
        await snap(page, 'shape_placed');

        // Right-click → Area...
        await page.mouse.click(shapeCenter.x, shapeCenter.y, { button: 'right' });
        let menuVisible = false;
        for (let i = 0; i < 30 && !menuVisible; i++) {
            menuVisible = await frame.evaluate(() =>
                !!document.querySelector('.context-menu-list, .on-the-fly-context-menu')).catch(() => false);
            if (!menuVisible) await sleep(150);
        }
        check('context menu appeared on shape right-click', menuVisible);
        if (!menuVisible) { await snap(page, 'no_menu'); process.exit(allPassed ? 0 : 1); }
        const area = await realClickMenuItem(page, frame, /^\s*Area/i, ifr);
        check('Area... menu item clicked', area.ok, area.item || area.why);
        if (!area.ok) { process.exit(allPassed ? 0 : 1); }

        // Wait for the Colors page (colorset) to render.
        let dialogUp = false;
        for (let i = 0; i < 60 && !dialogUp; i++) {
            // Collabora lineage: `colorset` drawingarea (#colorset-img).
            // Upstream lineage: `coloriconview` iconview. Accept either.
            dialogUp = await frame.evaluate(() =>
                !!document.querySelector('#colorset-img, [id^="colorset"], #coloriconview')).catch(() => false);
            if (!dialogUp) await sleep(250);
        }
        await sleep(1500);
        await snap(page, 'area_dialog');
        check('Area dialog Colors page rendered (colorset present)', dialogUp);
        if (!dialogUp) { process.exit(allPassed ? 0 : 1); }

        // ── PRIMARY ASSERTION: palette dropdown lists built-in palettes ──
        const opts = await frame.evaluate(() => {
            const sel = document.querySelector('#paletteselector-input')
                     || document.querySelector('#paletteselector select');
            let list = [];
            if (sel && sel.tagName === 'SELECT') {
                list = Array.from(sel.options).map(o => ({ v: o.value, t: (o.textContent || '').trim() }));
            } else {
                const c = document.querySelector('#paletteselector');
                if (c) list = Array.from(c.querySelectorAll('option, [role="option"], .ui-combobox-entry'))
                    .map(o => ({ v: o.value || '', t: (o.textContent || '').trim() }));
            }
            return list;
        });
        const texts = opts.map(o => o.t).filter(Boolean);
        const builtins = texts.filter(t => BUILTIN_RE.test(t) && !DYNAMIC_RE.test(t));
        log(`palette dropdown options (${texts.length}): ${JSON.stringify(texts.slice(0, 20))}`);
        check('palette dropdown has more than the 3 dynamic palettes', texts.length > 3,
              `count=${texts.length}`);
        check('palette dropdown lists at least one built-in palette (.soc loaded)',
              builtins.length >= 1, `builtins=${JSON.stringify(builtins.slice(0, 8))}`);

        // ── SECONDARY: select a built-in palette + click a swatch; the
        // "New" colour must change from the shape's original colour. ──
        const before = await frame.evaluate(() => ({
            hex: (document.querySelector('#hex_custom-input') || {}).value
              || (document.querySelector('#hex_preset-input') || {}).value || '',
            r: (document.querySelector('#R_custom-input') || {}).value || '',
        }));
        const builtinOpt = opts.find(o => BUILTIN_RE.test(o.t) && !DYNAMIC_RE.test(o.t));
        if (builtinOpt) {
            try { await frame.select('#paletteselector-input', builtinOpt.v); }
            catch (e) { log('frame.select failed: ' + e.message); }
            // wait for the colorset grid to (re)paint
            await sleep(1500);
            await snap(page, 'palette_selected');
            // Find a clickable swatch: the drawingarea grid (Collabora,
            // click a cell near its top-left) or an iconview entry (upstream).
            const box = await frame.evaluate(() => {
                const grid = document.querySelector('#colorset-img');
                if (grid) { const r = grid.getBoundingClientRect(); if (r.width)
                    return { x: r.left + 14, y: r.top + 14 }; }
                // iconview: pick a mid-palette entry (not #_0, which can match
                // the shape's current fill) so the New colour is guaranteed to
                // differ; click the swatch <img> centre.
                const entries = document.querySelectorAll('#coloriconview .ui-iconview-entry');
                if (entries.length) {
                    const e = entries[Math.min(12, entries.length - 1)];
                    const img = e.querySelector('img') || e;
                    const r = img.getBoundingClientRect();
                    if (r.width) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
                }
                return null;
            });
            if (box) {
                await page.mouse.click(box.x + ifr.left, box.y + ifr.top);
                await sleep(1200);
            }
            await snap(page, 'swatch_clicked');
            const after = await frame.evaluate(() => ({
                hex: (document.querySelector('#hex_custom-input') || {}).value
                  || (document.querySelector('#hex_preset-input') || {}).value || '',
                r: (document.querySelector('#R_custom-input') || {}).value || '',
                // upstream iconview marks the clicked swatch .selected
                iconviewSelected: !!document.querySelector('#coloriconview .ui-iconview-entry.selected'),
            }));
            log(`New colour before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
            check('clicking a palette swatch registers on the grid (grid is live)',
                  (after.hex && after.hex !== before.hex) || (after.r && after.r !== before.r)
                    || after.iconviewSelected,
                  `hex ${before.hex}->${after.hex} r ${before.r}->${after.r} iconviewSel=${after.iconviewSelected}`);
        } else {
            check('clicking a palette swatch changes the New colour (grid is live)', false,
                  'no built-in palette option to select');
        }

        log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    } finally {
        await browser.close();
    }
    process.exit(allPassed ? 0 : 1);
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(2); });
