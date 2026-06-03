const __cl = require('./lib/inject-checklist');
// Regression: Writer "insert shape + change its area colour" must not crash
// the kit, AND the shape-picker must offer rounded-square / rounded-rectangle.
//
// User report 2026-06-01: in Writer (any docx) the user opens the Insert
// notebookbar tab → Shapes menu and finds the "Rounded Rectangle" /
// "Rounded Square" entries MISSING from the popup grid (Bug A). After
// inserting any shape (triangle / rectangle), right-click → Area →
// pick a colour → OK traps the WASM kit with
//
//   Pthread 0x... sent an error!
//   Uncaught RuntimeError: memory access out of bounds
//     $func... → browserIterationFunc → Browser_mainLoop_runner
//   COOL Error: jserror {"message":"Uncaught [object ErrorEvent]", ...}
//
// (Bug B). The Impress equivalent (test-regression-impress-area-dialog.js)
// has the identical trap signature; both are explained by the
// StartExecuteAsync raw-pointer capture pattern. In Writer the dispatch
// site is sw/source/uibase/shells/drawdlg.cxx:121 (SwDrawShell::ExecDrawDlg,
// SID_ATTRIBUTES_AREA), which captures pSh + pView by raw pointer.
//
// Bug A diagnosis from the wiring of the shape grid:
//   - LO core publishes round-rectangle (index 1) + round-quadrat
//     (index 3) via svx/source/sidebar/shapes/ShapesUtil.cxx.
//   - The COOL-side shape menu (Control.Toolbar.js:362 var shapes) DOES
//     include both rounded entries in the "Basic Shapes" group (lines 366
//     + 368), with img: 'basicshapes_round-rectangle' / 'basicshapes_round-quadrat'.
//   - The CSS in toolbar.css lines 560 + 562 maps those classes to
//     lc_rect_rounded.svg + lc_basicshapes.round-quadrat.svg (both exist).
//   - So if the grid still hides them, the bug is either (a) a runtime
//     filter we haven't found yet, (b) the popup truncates rows at a
//     fixed row count (insertShapes loops by `rows = ceil(len/width)`),
//     or (c) the rounded entries fail an unrelated guard further down.
//
// This test:
//   1. Opens a small docx via the viewer.
//   2. Clicks the Insert tab in the notebookbar via real puppeteer mouse.
//   3. Clicks the Shapes menubutton (#insert-insert-shapes); the popup
//      should render an .insertshape-grid filled with .col tiles.
//   4. Reads every tile's data-uno + aria-label and asserts the grid
//      contains BOTH .uno:BasicShapes.round-rectangle AND
//      .uno:BasicShapes.round-quadrat.        ── Bug A reproduces
//      if either is missing.
//   5. Clicks a real rounded-rectangle tile (Bug A revised — user report:
//      shape body does not render after drag, only the dashed selection
//      marker appears). Test captures #document-canvas pixel hash before
//      vs. after the drag and asserts the hash MUST change (proves the
//      shape body actually drew).
//   6. Clicks on the canvas at the expected drop position.
//   7. Right-clicks the inserted shape → clicks "Area..." in the context
//      menu via real mouse click.
//   8. In the dialog, clicks the Color sub-tab + a colour swatch + OK.
//   9. Waits 5 s for the async callback + Browser_mainLoop tick.
//  10. Assert: no memory-OOB pageerror, no Pthread error, no WASM_ABORT,
//      no unreachable trap, window.app + Module.HEAP8 still alive,
//      doc-status indicator still rendering.
//
// 3 deterministic cycles total. Pre-fix expectation: SOME assertions
// FAIL (Bug A misses rounded-square / rounded-rectangle, and/or Bug B
// trips the OOB trap).

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');

const VIEWER  = env.FILE_STORAGE_URL;
const FIXTURE = path.join(__dirname, '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-writer-insert-shape-area';

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
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}`, fullPage: false }); }
    catch (_) {}
}

// Click a context-menu item with text matching `labelRegex` via real mouse.
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

// Click OK / Apply in any visible jsdialog.
async function realClickDialogOk(page, frame, ifr) {
    let bbox = null;
    for (let i = 0; i < 50; i++) {
        bbox = await frame.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll(
                '.jsdialog button, .modaldialog button, .ui-dialog button'));
            const find = (predicate) => buttons.find(b => {
                const visible = b.offsetWidth > 0 && b.offsetHeight > 0;
                return visible && predicate(b);
            });
            const byId = find(b => b.id === 'ok');
            const byLabel = byId || find(b => /^\s*(OK|Apply)\s*$/i.test(b.textContent || ''));
            const target = byId || byLabel;
            if (!target) return null;
            const r = target.getBoundingClientRect();
            return {
                x: r.left, y: r.top, w: r.width, h: r.height,
                label: (target.textContent || '').trim().substring(0, 40),
                id: target.id || '',
            };
        });
        if (bbox && bbox.w > 0 && bbox.h > 0) break;
        await sleep(150);
    }
    if (!bbox) return { ok: false, why: 'OK button not found' };
    await page.mouse.click(bbox.x + bbox.w / 2 + ifr.left, bbox.y + bbox.h / 2 + ifr.top);
    return { ok: true, label: bbox.label, id: bbox.id };
}

// Pick the first visible coloured swatch inside the dialog.
async function realClickFirstColorTile(page, frame, ifr) {
    let bbox = null;
    for (let i = 0; i < 80; i++) {
        bbox = await frame.evaluate(() => {
            const candidates = Array.from(document.querySelectorAll(
                '[style*="background-color"]'));
            const tiles = candidates.filter(t => {
                if (!t.offsetParent) return false;
                const r = t.getBoundingClientRect();
                if (r.width < 6 || r.height < 6) return false;
                if (r.width > 60 || r.height > 60) return false;
                if (r.top < 50) return false;
                const bg = t.style.backgroundColor || '';
                if (!bg || /rgba?\(255,\s*255,\s*255/.test(bg) || /transparent/.test(bg)) return false;
                return true;
            });
            if (!tiles.length) return null;
            const found = tiles[Math.floor(tiles.length / 2)];
            const r = found.getBoundingClientRect();
            return {
                x: r.left, y: r.top, w: r.width, h: r.height,
                bg: found.style.backgroundColor || '',
                total: tiles.length,
            };
        });
        if (bbox) break;
        await sleep(200);
    }
    if (!bbox) return { ok: false, why: 'no colour tile found' };
    await page.mouse.click(bbox.x + bbox.w / 2 + ifr.left, bbox.y + bbox.h / 2 + ifr.top);
    return { ok: true, bg: bbox.bg, total: bbox.total };
}

// Open the Insert tab in the notebookbar via real mouse click.
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

// Click the shape menubutton in the Insert tab. The DOM id is derived
// from 'insert-insert-shapes:InsertShapesMenu' in the Writer notebookbar
// (Control.NotebookbarWriter.js:1310) but the COOL menubutton-id transform
// drops the ':InsertShapesMenu' suffix and appends a numeric uid, so the
// runtime DOM id is `insert-insert-shapes<N>` (container) +
// `insert-insert-shapes<N>-button` (icon button) + a sibling .unolabel
// span + a sibling .arrowbackground (dropdown wedge). ANY of those three
// pieces, clicked, opens the .insertshape-grid popup empirically — so we
// click the icon button (which the user is most likely to click).
async function clickShapesMenubutton(page, frame, ifr) {
    let bbox = null;
    for (let i = 0; i < 40; i++) {
        bbox = await frame.evaluate(() => {
            // Prefer the inner <button id="insert-insert-shapes<N>-button">.
            // Fall back to the container if the button id pattern changes.
            const sel = [
                '[id^="insert-insert-shapes"][id$="-button"]',
                '[id^="insert-insert-shapes"]:not([id$="-button"])',
                '[id*="InsertShapesMenu"]',
            ];
            for (const s of sel) {
                const el = document.querySelector(s);
                if (el && el.offsetParent) {
                    const r = el.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0)
                        return { x: r.left, y: r.top, w: r.width, h: r.height, sel: s };
                }
            }
            return null;
        }).catch(() => null);
        if (bbox) break;
        await sleep(200);
    }
    if (!bbox) return { ok: false, why: 'shapes menubutton not found' };
    await page.mouse.click(bbox.x + bbox.w / 2 + ifr.left, bbox.y + bbox.h / 2 + ifr.top);
    return { ok: true, sel: bbox.sel };
}

// Inspect the open shapes popup, returning the list of visible tiles
// keyed by data-uno.
async function readShapeTiles(frame) {
    return frame.evaluate(() => {
        const grid = document.querySelector('.insertshape-grid');
        if (!grid) return { ok: false, why: 'no .insertshape-grid' };
        const tiles = Array.from(grid.querySelectorAll('.col'));
        const items = tiles.map(t => ({
            uno: t.dataset.uno || '',
            label: t.getAttribute('aria-label') || '',
            visible: !!t.offsetParent,
        }));
        return { ok: true, total: items.length, items };
    }).catch(e => ({ ok: false, why: e.message }));
}

// Click a specific tile in the shapes popup.
async function clickShapeTile(page, frame, ifr, unoCmd) {
    const bbox = await frame.evaluate((target) => {
        const grid = document.querySelector('.insertshape-grid');
        if (!grid) return null;
        const tile = Array.from(grid.querySelectorAll('.col'))
            .find(t => (t.dataset.uno || '') === target);
        if (!tile) return null;
        const r = tile.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
    }, unoCmd).catch(() => null);
    if (!bbox || bbox.w === 0) return { ok: false, why: `tile ${unoCmd} missing` };
    await page.mouse.click(bbox.x + bbox.w / 2 + ifr.left, bbox.y + bbox.h / 2 + ifr.top);
    return { ok: true };
}

// One full cycle: open Shapes popup, sample the entries, insert a
// rectangle, right-click → Area → colour → OK.
async function runOneCycle(page, frame, canvasXY, ifr, runIdx, evidence) {
    log(`--- cycle ${runIdx}: starting Writer insert-shape + Area repro ---`);

    // Make sure no stray popup is open.
    await page.keyboard.press('Escape');
    await sleep(300);
    await page.keyboard.press('Escape');
    await sleep(300);
    // Click into the doc to focus it.
    await page.mouse.click(canvasXY.x, canvasXY.y);
    await sleep(400);

    // ── Step 1: open the Insert tab ──
    const ins = await clickInsertTab(page, frame, ifr);
    log(`  cycle ${runIdx}: Insert tab click → ok=${ins.ok} ${ins.why || ''}`);
    await sleep(600);
    await snap(page, `c${runIdx}_insert_tab`);

    // ── Step 2: open the shapes popup ──
    const sm = await clickShapesMenubutton(page, frame, ifr);
    log(`  cycle ${runIdx}: shapes menubutton click → ok=${sm.ok} sel=${sm.sel || ''} ${sm.why || ''}`);
    await sleep(800);
    await snap(page, `c${runIdx}_shapes_popup`);

    // ── Step 3: enumerate tiles, record for Bug A assertion ──
    const tiles = await readShapeTiles(frame);
    log(`  cycle ${runIdx}: shapes popup tiles ok=${tiles.ok} total=${tiles.total || 0}${tiles.why ? ' why=' + tiles.why : ''}`);
    if (tiles.ok) {
        const unos = (tiles.items || []).map(t => t.uno).filter(u => u);
        const hasRoundRect = unos.includes('BasicShapes.round-rectangle');
        const hasRoundQuad = unos.includes('BasicShapes.round-quadrat');
        // Count this cycle as a real Bug A REPRO only if the popup
        // rendered but the rounded entries are absent. A popup that
        // failed to open at all is recorded separately
        // (popupNeverAppeared) since that can be a knock-on from a kit
        // crash in a PRIOR cycle, not Bug A.
        if (!hasRoundRect) evidence.roundRectMissingCycles.push(runIdx);
        if (!hasRoundQuad) evidence.roundQuadMissingCycles.push(runIdx);
        evidence.bugAEvaluatedCycles.push(runIdx);
        log(`  cycle ${runIdx}: round-rectangle present=${hasRoundRect}, round-quadrat present=${hasRoundQuad}`);
        // Diagnostic: dump first 12 tile UNOs.
        log(`  cycle ${runIdx}: first 12 tile UNOs: ${JSON.stringify(unos.slice(0, 12))}`);
        evidence.lastTilesSeen = tiles.items.slice(0, 30);
    } else {
        // Popup didn't render — this cycle is INCONCLUSIVE for Bug A;
        // record but don't count it as a hard reproduction.
        evidence.popupNeverAppeared.push(runIdx);
    }

    // ── Step 4: insert the user-reported shape (rounded-rectangle, the
    // shape the user said does not render). Drag-insert and capture canvas
    // pixel hash before vs. after to assert SOMETHING actually drew.
    //
    // Bug A (revised, 2026-06-01): the user reports that after picking the
    // rounded-rectangle entry, drag-inserting on the canvas yields ONLY
    // the dashed selection marker — no shape body. We verify by:
    //   (a) computing a sampled hash of #document-canvas before the drag.
    //   (b) running the real-mouse drag from canvas (300,300) to (450,400).
    //   (c) re-hashing after 3 s settle. A change proves rendering occurred.
    // We also try a plain rectangle as a control case (next test does it).
    let inserted = false;
    let shapeCenter = { x: canvasXY.x + 60, y: canvasXY.y + 40 };
    let canvasHashBefore = null;
    let canvasHashAfter  = null;
    const SHAPE_UNO = 'BasicShapes.round-rectangle';
    if (tiles.ok) {
        // Capture canvas hash BEFORE picking the tile.
        canvasHashBefore = await frame.evaluate(() => {
            const c = document.querySelector('#document-canvas');
            if (!c) return null;
            try {
                const ctx = c.getContext('2d');
                const w = Math.min(c.width, 800);
                const h = Math.min(c.height, 600);
                const data = ctx.getImageData(0, 0, w, h).data;
                let acc = 0;
                for (let i = 0; i < data.length; i += 64) acc = (acc * 31 + data[i]) | 0;
                return acc;
            } catch (e) { return null; }
        }).catch(() => null);

        const tile = await clickShapeTile(page, frame, ifr, SHAPE_UNO);
        log(`  cycle ${runIdx}: clicked tile [${SHAPE_UNO}] → ok=${tile.ok} ${tile.why || ''}`);
        await sleep(500);
        await snap(page, `c${runIdx}_shape_armed`);
        if (tile.ok) {
            // Writer enters "draw mode" after picking a shape; a click+drag
            // drops a fixed-size shape at the drag rectangle. Drag a
            // generous (200×140) region so subsequent right-click on the
            // drag-rect centre lands clearly inside the shape body.
            const startX = canvasXY.x;
            const startY = canvasXY.y;
            const endX   = canvasXY.x + 200;
            const endY   = canvasXY.y + 140;
            await page.mouse.move(startX, startY);
            await page.mouse.down();
            await page.mouse.move(endX, endY, { steps: 8 });
            await page.mouse.up();
            shapeCenter = { x: (startX + endX) / 2, y: (startY + endY) / 2 };
            await sleep(1200);
            await sleep(2000); // total 3.2 s settle per Bug A (revised) spec
            await snap(page, `c${runIdx}_shape_placed`);
            inserted = true;

            // Capture canvas hash AFTER drag.
            canvasHashAfter = await frame.evaluate(() => {
                const c = document.querySelector('#document-canvas');
                if (!c) return null;
                try {
                    const ctx = c.getContext('2d');
                    const w = Math.min(c.width, 800);
                    const h = Math.min(c.height, 600);
                    const data = ctx.getImageData(0, 0, w, h).data;
                    let acc = 0;
                    for (let i = 0; i < data.length; i += 64) acc = (acc * 31 + data[i]) | 0;
                    return acc;
                } catch (e) { return null; }
            }).catch(() => null);
            log(`  cycle ${runIdx}: canvas hash before=${canvasHashBefore} after=${canvasHashAfter} changed=${canvasHashBefore !== canvasHashAfter}`);

            evidence.canvasHashCycles.push({
                cycle: runIdx,
                shape: SHAPE_UNO,
                before: canvasHashBefore,
                after:  canvasHashAfter,
                changed: canvasHashBefore != null && canvasHashAfter != null
                         && canvasHashBefore !== canvasHashAfter,
            });
        }
    }

    // After the drag, the shape is selected by default in Writer (selection
    // handles visible). Do NOT press Escape here — Escape would deselect it
    // and reset the notebookbar back to Home, sending the right-click into
    // bare-text mode (which the kit reports as a 1-item "Comment" context
    // menu, NOT the shape's Area-bearing menu).
    await snap(page, `c${runIdx}_shape_selected`);

    // ── Step 5: right-click the shape body ──
    if (!inserted) {
        log(`  cycle ${runIdx}: no shape inserted — skipping Area dispatch`);
        return;
    }
    log(`  cycle ${runIdx}: right-clicking shape body at (${shapeCenter.x},${shapeCenter.y})`);
    await page.mouse.click(shapeCenter.x, shapeCenter.y, { button: 'right' });
    let menuVisible = false;
    for (let i = 0; i < 30 && !menuVisible; i++) {
        menuVisible = await frame.evaluate(() =>
            !!document.querySelector('.context-menu-list, .on-the-fly-context-menu')
        ).catch(() => false);
        if (!menuVisible) await sleep(150);
    }
    await snap(page, `c${runIdx}_context_menu`);
    if (!menuVisible) {
        log(`  cycle ${runIdx}: no context menu — skipping Area dispatch`);
        return;
    }
    const itemsDump = await frame.evaluate(() => Array.from(
        document.querySelectorAll('.context-menu-item')).map(el =>
            (el.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 50)));
    log(`  cycle ${runIdx}: context-menu items (${itemsDump.length}): ${JSON.stringify(itemsDump.slice(0, 14))}`);

    // ── Step 6: click "Area..." in the context menu ──
    const area = await realClickMenuItem(page, frame, /^\s*Area/i, ifr);
    log(`  cycle ${runIdx}: clicked context-menu item "${area.item || area.why || ''}"`);
    if (!area.ok) return;

    // ── Step 7: dialog should open; switch to Color tab, pick a colour, OK ──
    let dialogVisible = false;
    for (let i = 0; i < 80 && !dialogVisible; i++) {
        dialogVisible = await frame.evaluate(() => {
            const dlg = document.querySelector(
                '.jsdialog .ui-dialog, .lokdialog, .modaldialog');
            if (dlg && dlg.offsetWidth > 0) return true;
            const titles = Array.from(document.querySelectorAll(
                '.jsdialog .ui-dialog-title, .lokdialog-titlebar'));
            return titles.some(t => /Area/i.test(t.textContent || ''));
        }).catch(() => false);
        if (!dialogVisible) await sleep(200);
    }
    await snap(page, `c${runIdx}_area_dialog`);
    log(`  cycle ${runIdx}: area dialog visible? ${dialogVisible}`);
    if (!dialogVisible) {
        evidence.dialogNeverAppeared.push(runIdx);
    } else {
        try { await frame.click('#btncolor-button'); } catch (_) {}
        await sleep(1200);
        try {
            await frame.focus('#btncolor-button');
            await sleep(150);
            await page.keyboard.press('Enter');
        } catch (_) {}
        await sleep(1200);
        await snap(page, `c${runIdx}_color_tab`);

        const tile = await realClickFirstColorTile(page, frame, ifr);
        log(`  cycle ${runIdx}: color swatch click → ok=${tile.ok} bg=${tile.bg || ''} ${tile.why || ''}`);
        await sleep(600);
        await snap(page, `c${runIdx}_color_picked`);

        const ok = await realClickDialogOk(page, frame, ifr);
        log(`  cycle ${runIdx}: OK click → ok=${ok.ok} id=${ok.id || ''} label="${ok.label || ''}" ${ok.why || ''}`);
    }

    // ── Step 8: settle ≥ 5 s for async callback + Browser_mainLoop tick ──
    await sleep(2500);
    await snap(page, `c${runIdx}_after_ok_2s`);
    await sleep(3000);
    await snap(page, `c${runIdx}_after_ok_5s`);

    // Nudge the kit with a benign mouse move so its tick runs.
    await page.mouse.move(canvasXY.x + 5, canvasXY.y + 5);
    await sleep(300);
    await page.mouse.move(canvasXY.x, canvasXY.y);
    await sleep(2000);
    await snap(page, `c${runIdx}_after_jitter`);
}

(async () => {
    log('=== Regression: Writer insert-shape + Area must not crash kit ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(FIXTURE)) {
        log(`SKIP: fixture missing: ${FIXTURE}`);
        process.exit(2);
    }

    const bytes = fs.readFileSync(FIXTURE);
    const name  = `writer-shape-area-${Date.now()}.docx`;
    const up    = await uploadV2(VIEWER, name, bytes);
    log(`uploaded ${name}`);

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 900 });

        const evidence = {
            wasmAborts:               [],
            pthreadErrors:            [],
            memoryOOB:                [],
            unreachable:              [],
            pageErrors:               [],
            jserrors:                 [],
            wasmStackFuncs:           new Set(),
            popupNeverAppeared:       [],
            roundRectMissingCycles:   [],
            roundQuadMissingCycles:   [],
            bugAEvaluatedCycles:      [],  // cycles where the popup DID open
            dialogNeverAppeared:      [],
            lastTilesSeen:            [],
            cycleRan:                 0,
            // Bug A (revised) — rendering of rounded-rectangle on canvas.
            // Each entry: { cycle, shape, before, after, changed }. The
            // baselineHash is captured once at startup BEFORE any shape is
            // inserted; the post-cycle-1 hash must differ from it.
            canvasHashCycles:         [],
            baselineCanvasHash:       null,
        };

        page.on('console', m => {
            const t = m.text();
            if (/WASM_ABORT|Assertion failed|Aborted\(/.test(t))
                evidence.wasmAborts.push(t.substring(0, 300));
            if (/Pthread.*sent an error/i.test(t))
                evidence.pthreadErrors.push(t.substring(0, 300));
            if (/memory access out of bounds/i.test(t))
                evidence.memoryOOB.push(t.substring(0, 300));
            if (/unreachable/i.test(t))
                evidence.unreachable.push(t.substring(0, 300));
            if (/COOL Error.*jserror|jserror.*Uncaught/i.test(t))
                evidence.jserrors.push(t.substring(0, 300));
            const funcMatch = t.match(/\$func\d+/g);
            if (funcMatch) funcMatch.forEach(f => evidence.wasmStackFuncs.add(f));
        });
        page.on('pageerror', e => {
            const msg = e.message || String(e);
            evidence.pageErrors.push(msg.substring(0, 400));
            if (/memory access out of bounds/i.test(msg))
                evidence.memoryOOB.push(msg.substring(0, 400));
            if (/unreachable/i.test(msg))
                evidence.unreachable.push(msg.substring(0, 400));
            const funcMatch = msg.match(/\$func\d+/g);
            if (funcMatch) funcMatch.forEach(f => evidence.wasmStackFuncs.add(f));
        });

        await page.goto(`${VIEWER}/?singleuser#file=${up.b64urlSecret}`,
            { waitUntil: 'domcontentloaded',
              timeout: env.scaleTimeout(120000) });

        // Locate the editor iframe + canvas + writer's StatusDocPos
        // indicator (Writer uses #StatusDocPos, not #SlideStatus).
        let frame = null;
        for (let i = 0; i < 90 && !frame; i++) {
            frame = page.frames().find(f => f.url().includes('cool.html'));
            if (frame && !(await frame.$('#document-canvas').catch(() => null))) frame = null;
            if (!frame) await sleep(1000);
        }
        if (!frame) throw new Error('editor frame never loaded');
        await frame.waitForFunction(
            () => window.__wasmInitialDocLoaded === true,
            { timeout: env.scaleTimeout(90000) });
        // Writer status: wait for either Word Count or Page status.
        await frame.waitForFunction(
            () => {
                const wc = document.querySelector('#StateWordCount')?.textContent || '';
                const pp = document.querySelector('#StatusDocPos')?.textContent || '';
                return wc.length > 0 || pp.length > 0;
            },
            { timeout: env.scaleTimeout(45000) });
        await sleep(2500);
        await snap(page, 'loaded');

        // Capture the empty-canvas baseline hash BEFORE any cycles run.
        // Bug A (revised): after cycle 1's drag-insert, the post-drag hash
        // MUST differ from this baseline — proves a shape body actually
        // drew (not just a dashed selection marker, which renders as DOM
        // SVG overlay paths separate from #document-canvas pixels).
        evidence.baselineCanvasHash = await frame.evaluate(() => {
            const c = document.querySelector('#document-canvas');
            if (!c) return null;
            try {
                const ctx = c.getContext('2d');
                const w = Math.min(c.width, 800);
                const h = Math.min(c.height, 600);
                const data = ctx.getImageData(0, 0, w, h).data;
                let acc = 0;
                for (let i = 0; i < data.length; i += 64) acc = (acc * 31 + data[i]) | 0;
                return acc;
            } catch (e) { return null; }
        }).catch(() => null);
        log(`baseline canvas hash (no shapes): ${evidence.baselineCanvasHash}`);

        // Canvas centre — use the upper-left quadrant since shapes are
        // dropped near the cursor.
        const canvasXY = await frame.evaluate(() => {
            const c = document.querySelector('#document-canvas');
            if (!c) return null;
            const r = c.getBoundingClientRect();
            return {
                x: Math.round(r.left + r.width * 0.5),
                y: Math.round(r.top + r.height * 0.45),
                cw: Math.round(r.width),
                ch: Math.round(r.height),
                rx: Math.round(r.left),
                ry: Math.round(r.top),
            };
        });
        if (!canvasXY) throw new Error('document canvas missing');
        log(`canvas viewport rect: top-left=(${canvasXY.rx},${canvasXY.ry}) size=(${canvasXY.cw}x${canvasXY.ch})`);

        const ifr = await page.evaluate(() => {
            const f = document.querySelector('iframe');
            if (!f) return null;
            const r = f.getBoundingClientRect();
            return { left: Math.round(r.left), top: Math.round(r.top) };
        });
        if (!ifr) throw new Error('viewer iframe missing');
        log(`iframe offset in viewer page: (${ifr.left},${ifr.top})`);
        const clickXY = { x: canvasXY.x + ifr.left, y: canvasXY.y + ifr.top };
        log(`canvas page-mouse click coords: (${clickXY.x},${clickXY.y})`);

        for (let i = 1; i <= 3; i++) {
            evidence.cycleRan = i;
            await runOneCycle(page, frame, clickXY, ifr, i, evidence);
            // Cleanup BETWEEN cycles: the previously-inserted shape stays
            // SELECTED after the Area dialog closes, which forces the
            // notebookbar to the context-sensitive "Shape" tab — and the
            // Insert tab is unreachable from there. To clear state we:
            //   1. Escape any open dialog.
            //   2. Click far OUTSIDE the canvas (in the toolbar area, but
            //      not on a tab) to dismiss the shape selection.
            //   3. Wait for the context tab to swap back to a non-Shape tab.
            await page.keyboard.press('Escape');
            await sleep(250);
            await page.keyboard.press('Escape');
            await sleep(250);
            // Click at top-left of the document (well away from any shape
            // on the right) to put the caret in plain text — deselects
            // the shape. The clickXY is at (canvas-centre,~0.45h); the
            // shape was placed in the right half, so a click at
            // (canvasXY.x - canvasXY.cw/3, canvasXY.y) lands well to the
            // left of the shape.
            const leftClickX = Math.max(clickXY.x - 350, ifr.left + 200);
            const leftClickY = clickXY.y - 200;
            await page.mouse.click(leftClickX, leftClickY);
            await sleep(600);
            // Confirm Shape tab is no longer the active context. If the
            // shape is still selected, press Escape twice more — that
            // forces draw mode to exit even when click-outside doesn't.
            for (let j = 0; j < 3; j++) {
                const shapeStillActive = await frame.evaluate(() => {
                    const t = document.querySelector('#Shape-tab-label');
                    if (!t) return false;
                    // Hidden class on the tab label means context is NOT Shape.
                    return !t.className.includes('hidden');
                }).catch(() => false);
                if (!shapeStillActive) break;
                await page.keyboard.press('Escape');
                await sleep(400);
            }
            // Final settle.
            await sleep(400);
        }

        // ============ Hard assertions ============

        // ── Bug A: rounded-square + rounded-rectangle entries present ──
        // These checks are only meaningful on cycles where the popup
        // actually rendered (bugAEvaluatedCycles). If the popup never
        // opened on any cycle, log it but don't fail Bug A — the failure
        // mode is "the kit died before we could check", which is a Bug B
        // knock-on, not Bug A.
        check(`Shapes popup opened on at least one cycle (Bug A evaluable on ${evidence.bugAEvaluatedCycles.length}/${evidence.cycleRan})`,
              evidence.bugAEvaluatedCycles.length > 0,
              `popup-never-opened=[${evidence.popupNeverAppeared.join(',')}]`);
        check('Shapes popup contains .uno:BasicShapes.round-rectangle entry on every cycle where it opened',
              evidence.roundRectMissingCycles.length === 0,
              `missing cycles=[${evidence.roundRectMissingCycles.join(',')}] evaluated=[${evidence.bugAEvaluatedCycles.join(',')}]`);
        check('Shapes popup contains .uno:BasicShapes.round-quadrat (Rounded Square) entry on every cycle where it opened',
              evidence.roundQuadMissingCycles.length === 0,
              `missing cycles=[${evidence.roundQuadMissingCycles.join(',')}] evaluated=[${evidence.bugAEvaluatedCycles.join(',')}]`);

        // ── Bug A (revised): rounded-rectangle drag-insert must render ──
        // User report 2026-06-01: after picking the rounded-rectangle entry
        // and drag-inserting on the canvas, only the dashed selection
        // marker appears — no shape body.
        //
        // We catch this by comparing the canvas hash AFTER cycle 1's drag
        // against the BASELINE captured at startup (empty doc, no shapes).
        // Bug B downstream wedges cycles 2-3, so cycle 1 is the only cycle
        // where the kit reliably responds; once the LO bug is fixed the
        // baseline-comparison naturally widens to all cycles.
        //
        // Pre-fix expectation if Bug A (revised) repros: canvas hash AFTER
        // cycle 1 == baseline (no body drew).
        // Empirical: hash changes (~1940012517 → 260961492), shape renders.
        const c1 = evidence.canvasHashCycles.find(c => c.cycle === 1);
        const c1RenderedShape = c1 && c1.after != null
            && evidence.baselineCanvasHash != null
            && c1.after !== evidence.baselineCanvasHash;
        check('Cycle-1 canvas hash differs from empty baseline after rounded-rectangle drag (Bug A revised — body must render, not just dashed marker)',
              !!c1RenderedShape,
              `baseline=${evidence.baselineCanvasHash} cycle1.after=${c1?.after} ` +
              `samples=${JSON.stringify(evidence.canvasHashCycles.map(c => ({c:c.cycle, b:c.before, a:c.after})))}`);

        // Auxiliary: at least ONE cycle's drag-insert produced a visible
        // canvas change (changed=true). Catches the case where multiple
        // cycles repeatedly insert at the same coord — bug-A-revised would
        // imply NO cycle ever changes the canvas.
        const anyRender = evidence.canvasHashCycles.some(c => c.changed === true);
        check('At least one drag-insert cycle changed the canvas (rules out total render-fail)',
              !!anyRender,
              `cycles=${JSON.stringify(evidence.canvasHashCycles.map(c => ({c:c.cycle, ch:c.changed})))}`);

        // ── Bug B: no fatal WASM events after Area dialog Apply ──
        check('no "memory access out of bounds" event after insert-shape + Area Apply',
              evidence.memoryOOB.length === 0,
              evidence.memoryOOB[0]?.substring(0, 140) || '');
        check('no Pthread "sent an error" console line',
              evidence.pthreadErrors.length === 0,
              evidence.pthreadErrors[0]?.substring(0, 140) || '');
        check('no WASM_ABORT / Aborted( console line',
              evidence.wasmAborts.length === 0,
              evidence.wasmAborts[0]?.substring(0, 140) || '');
        check('no "unreachable" trap',
              evidence.unreachable.length === 0,
              evidence.unreachable[0]?.substring(0, 140) || '');

        // ── liveness: kit still functional after 3 cycles ──
        const alive = await frame.evaluate(() => ({
            hasApp:    !!window.app,
            hasMap:    !!window.app?.map,
            hasModule: !!(window.Module && window.Module.HEAP8),
            wordcount: document.querySelector('#StateWordCount')?.textContent || '',
            statepos:  document.querySelector('#StatusDocPos')?.textContent || '',
        }));
        check('window.app still defined after 3 cycles',
              alive.hasApp === true);
        check('window.Module still healthy (HEAP8 present) after 3 cycles',
              alive.hasModule === true,
              `app=${alive.hasApp} map=${alive.hasMap}`);
        check('Writer status (word count or page pos) still rendering after 3 cycles',
              alive.wordcount.length > 0 || alive.statepos.length > 0,
              `wc="${alive.wordcount}" pos="${alive.statepos}"`);

        // ============ Diagnostic dump ============
        log('');
        log('=== Evidence dump ===');
        log(`cycles ran:                ${evidence.cycleRan}`);
        log(`popup-never-appeared:      [${evidence.popupNeverAppeared.join(',')}]`);
        log(`round-rect missing:        [${evidence.roundRectMissingCycles.join(',')}]`);
        log(`round-quadrat missing:     [${evidence.roundQuadMissingCycles.join(',')}]`);
        log(`memory-OOB events:         ${evidence.memoryOOB.length}`);
        log(`pthread errors:            ${evidence.pthreadErrors.length}`);
        log(`WASM_ABORT events:         ${evidence.wasmAborts.length}`);
        log(`unreachable traps:         ${evidence.unreachable.length}`);
        log(`pageerrors total:          ${evidence.pageErrors.length}`);
        log(`jserror lines:             ${evidence.jserrors.length}`);
        log(`dialog-no-show cycles:     [${evidence.dialogNeverAppeared.join(',')}]`);
        log(`baseline canvas hash:      ${evidence.baselineCanvasHash}`);
        log(`canvas-hash cycles:        ${evidence.canvasHashCycles.length}`);
        evidence.canvasHashCycles.forEach(c =>
            log(`  c${c.cycle} ${c.shape}: before=${c.before} after=${c.after} changed=${c.changed}`));
        log(`unique $funcNNNN ids:      ${evidence.wasmStackFuncs.size}`);
        if (evidence.wasmStackFuncs.size) {
            log(`  funcs: ${Array.from(evidence.wasmStackFuncs).slice(0, 20).join(' ')}`);
        }
        if (evidence.lastTilesSeen.length) {
            log(`last-cycle tiles (first 30):`);
            evidence.lastTilesSeen.forEach((t, i) =>
                log(`  [${i}] uno="${t.uno}" label="${t.label}"`));
        }
        const dumpHead = (label, arr) => {
            if (!arr.length) return;
            log(`--- first ${Math.min(3, arr.length)} ${label} ---`);
            arr.slice(0, 3).forEach((e, i) => log(`  [${i}] ${e.substring(0, 260)}`));
        };
        dumpHead('memory-OOB', evidence.memoryOOB);
        dumpHead('pthread errors', evidence.pthreadErrors);
        dumpHead('WASM_ABORT', evidence.wasmAborts);
        dumpHead('unreachable', evidence.unreachable);
        dumpHead('pageerror', evidence.pageErrors);
        dumpHead('jserror', evidence.jserrors);

        log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    } finally {
        await browser.close();
    }

    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e.stack || e.message);
    process.exit(2);
});
