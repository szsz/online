// test-cv-regression-area-palette.js — the Area dialog's Colors tab must show
// real palettes (content-viewer harness).
//
// History: the emscripten fs-image preload list packaged colorpage.ui but
// not share/palette/*.soc, so PaletteManager loaded zero built-in palettes:
// the "Palette:" dropdown listed only the 3 dynamic entries (Custom / Theme
// colors / Document colors) and the colour grid was blank.
//
// Flow (pure visible-UI E2E): open new.docx, insert a rectangle
// (Insert tab → Shapes → rectangle, drag), right-click → Area..., then:
//   ASSERT palette dropdown has more than the 3 dynamic palettes AND at
//          least one recognizable built-in (standard/libreoffice/html/
//          material/tonal/chart/breeze/freecolour).
//   ASSERT selecting a built-in palette + clicking a swatch in the grid
//          changes the "New" colour (grid painted real, clickable colours).
//
// Migrated from wasm/tests/regression/test-regression-area-palette.js
// — legacy version retired.
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, waitCvInteractive, cvEditorFrame } =
    require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/regression-area-palette';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  PASS: ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}`, fullPage: false }); } catch (_) {}
}

// ── repro helpers ───────────────────────────────────────────────────────
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
    log('=== CV Regression: Area dialog Colors tab shows real palettes ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    if (!fs.existsSync(FIXTURE)) { log(`SKIP: fixture missing: ${FIXTURE}`); process.exit(2); }
    log('viewer: ' + BASE);

    const { browser } = await launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        await openViaContentViewer(browser, BASE, FIXTURE,
            { page, viewport: { width: 1400, height: 900 }, iframeTimeout: 60000 });
        if (!(await waitCvInteractive(page, LOAD_BUDGET)))
            throw new Error('doc never became interactive in content viewer');
        const frame = cvEditorFrame(page);
        if (!frame) throw new Error('editor frame never loaded');
        await frame.waitForFunction(() => {
            const wc = document.querySelector('#StateWordCount')?.textContent || '';
            const pp = document.querySelector('#StatusDocPos')?.textContent || '';
            return wc.length > 0 || pp.length > 0;
        }, { timeout: 150000 });
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
        // The color grid is an iconview (#coloriconview + coloriconview_N cells)
        // and the palette dropdown is #paletteselector-input — this build's
        // jsdialog ids (the old #colorset-img canvas id no longer exists).
        let dialogUp = false;
        for (let i = 0; i < 60 && !dialogUp; i++) {
            dialogUp = await frame.evaluate(() =>
                !!document.querySelector('#coloriconview, [id^="coloriconview"], #paletteselector-input'))
                .catch(() => false);
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
        // "New" colour must change. Snapshot every colour field (the "New"
        // side is the editable *_custom-input; *_preset-input is the constant
        // "Active" colour, which must NOT be what we assert on). ──
        const snapColour = () => frame.evaluate(() => {
            const v = id => (document.querySelector('#' + id) || {}).value || '';
            return { hexC: v('hex_custom-input'), hexP: v('hex_preset-input'),
                     rC: v('R_custom-input'), gC: v('G_custom-input'), bC: v('B_custom-input') };
        });
        const before = await snapColour();
        const builtinOpt = opts.find(o => BUILTIN_RE.test(o.t) && !DYNAMIC_RE.test(o.t));
        if (builtinOpt) {
            try { await frame.select('#paletteselector-input', builtinOpt.v); }
            catch (e) { log('frame.select failed: ' + e.message); }
            await sleep(1500); // colorset grid (re)paints
            await snap(page, 'palette_selected');
            // Click a colour cell via its element handle (puppeteer scrolls it
            // into view + clicks its centre — more reliable on the jsdialog
            // IconView than a computed page-coordinate). Cells 0..N are swatches.
            let clicked = false;
            for (const sel of ['#coloriconview_8', '#coloriconview_3', '#coloriconview_0',
                               '[id^="coloriconview_"]']) {
                const cell = await frame.$(sel);
                if (cell) { try { await cell.click(); clicked = true; } catch (_) {} break; }
            }
            await sleep(1500);
            await snap(page, 'swatch_clicked');
            const after = await snapColour();
            log(`clicked=${clicked} New before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
            // A live grid updates the editable "New" (_custom) colour on click.
            const changed = (after.hexC && after.hexC !== before.hexC)
                || (after.rC && (after.rC !== before.rC))
                || (after.gC && after.gC !== before.gC)
                || (after.bC && after.bC !== before.bC);
            check('clicking a palette swatch changes the New colour (grid is live)', changed,
                  `custom hex ${before.hexC}->${after.hexC} rgb ${before.rC},${before.gC},${before.bC}->${after.rC},${after.gC},${after.bC}`);
        } else {
            check('clicking a palette swatch changes the New colour (grid is live)', false,
                  'no built-in palette option to select');
        }

        log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 200));
    } finally {
        try { await browser.close(); } catch (_) {}
    }
    process.exit(allPassed ? 0 : 1);
})();
