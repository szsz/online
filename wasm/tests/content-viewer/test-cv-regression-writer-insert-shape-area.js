// test-cv-regression-writer-insert-shape-area.js — Writer "insert shape +
// change its area colour" must not crash the kit, AND the shape-picker must
// offer rounded-square / rounded-rectangle (content-viewer harness).
//
// Bug A: Insert → Shapes popup must contain BasicShapes.round-rectangle AND
//        BasicShapes.round-quadrat entries; the rounded-rectangle drag-insert
//        must actually render a shape body (canvas pixel-hash must change vs
//        the empty baseline, not just the dashed selection marker).
// Bug B: right-click → Area → colour → OK on the inserted shape must not
//        trap the kit (memory-OOB / Pthread error / WASM_ABORT / unreachable)
//        — same StartExecuteAsync raw-pointer signature as the Impress case;
//        Writer dispatch site sw/source/uibase/shells/drawdlg.cxx
//        (SwDrawShell::ExecDrawDlg SID_ATTRIBUTES_AREA).
//
// 3 deterministic cycles. All assertions identical to the legacy test.
//
// Migrated from wasm/tests/regression/test-regression-writer-insert-shape-area.js
// — legacy version retired.
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, waitCvInteractive, cvEditorFrame } =
    require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/regression-writer-insert-shape-area';
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

// Click the Shapes menubutton in the Insert tab.
async function clickShapesMenubutton(page, frame, ifr) {
    let bbox = null;
    for (let i = 0; i < 40; i++) {
        bbox = await frame.evaluate(() => {
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

// Inspect the open shapes popup, returning visible tiles keyed by data-uno.
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

// Sampled pixel-hash of #document-canvas (shape-body render detector).
async function canvasHash(frame) {
    return frame.evaluate(() => {
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
}

// One full cycle: open Shapes popup, sample the entries, insert a
// rounded-rectangle, right-click → Area → colour → OK.
async function runOneCycle(page, frame, canvasXY, ifr, runIdx, evidence) {
    log(`--- cycle ${runIdx}: starting Writer insert-shape + Area repro ---`);

    // Make sure no stray popup is open; focus the doc.
    await page.keyboard.press('Escape');
    await sleep(300);
    await page.keyboard.press('Escape');
    await sleep(300);
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
        if (!hasRoundRect) evidence.roundRectMissingCycles.push(runIdx);
        if (!hasRoundQuad) evidence.roundQuadMissingCycles.push(runIdx);
        evidence.bugAEvaluatedCycles.push(runIdx);
        log(`  cycle ${runIdx}: round-rectangle present=${hasRoundRect}, round-quadrat present=${hasRoundQuad}`);
        log(`  cycle ${runIdx}: first 12 tile UNOs: ${JSON.stringify(unos.slice(0, 12))}`);
        evidence.lastTilesSeen = tiles.items.slice(0, 30);
    } else {
        evidence.popupNeverAppeared.push(runIdx);
    }

    // ── Step 4: drag-insert the rounded-rectangle; canvas hash before/after ──
    let inserted = false;
    let shapeCenter = { x: canvasXY.x + 60, y: canvasXY.y + 40 };
    let canvasHashBefore = null;
    let canvasHashAfter  = null;
    const SHAPE_UNO = 'BasicShapes.round-rectangle';
    if (tiles.ok) {
        canvasHashBefore = await canvasHash(frame);

        const tile = await clickShapeTile(page, frame, ifr, SHAPE_UNO);
        log(`  cycle ${runIdx}: clicked tile [${SHAPE_UNO}] → ok=${tile.ok} ${tile.why || ''}`);
        await sleep(500);
        await snap(page, `c${runIdx}_shape_armed`);
        if (tile.ok) {
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

            canvasHashAfter = await canvasHash(frame);
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

    // Do NOT press Escape here — it would deselect the shape and send the
    // right-click into bare-text mode (1-item "Comment" menu, no Area).
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

    // ── Step 7: dialog opens; switch to Color tab, pick a colour, OK ──
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
    log('=== CV Regression: Writer insert-shape + Area must not crash kit ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(FIXTURE)) {
        log(`SKIP: fixture missing: ${FIXTURE}`);
        process.exit(2);
    }
    log('viewer: ' + BASE);

    const { browser } = await launch({ headless: 'new' });
    try {
        const page = await browser.newPage();

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

        await openViaContentViewer(browser, BASE, FIXTURE,
            { page, viewport: { width: 1400, height: 900 }, iframeTimeout: 60000 });
        if (!(await waitCvInteractive(page, LOAD_BUDGET)))
            throw new Error('doc never became interactive in content viewer');
        const frame = cvEditorFrame(page);
        if (!frame) throw new Error('editor frame never loaded');
        // Writer status: wait for either Word Count or Page status.
        await frame.waitForFunction(
            () => {
                const wc = document.querySelector('#StateWordCount')?.textContent || '';
                const pp = document.querySelector('#StatusDocPos')?.textContent || '';
                return wc.length > 0 || pp.length > 0;
            },
            { timeout: 150000 });
        await sleep(2500);
        await snap(page, 'loaded');

        // Empty-canvas baseline hash BEFORE any cycles (Bug A revised).
        evidence.baselineCanvasHash = await canvasHash(frame);
        log(`baseline canvas hash (no shapes): ${evidence.baselineCanvasHash}`);

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
        if (!ifr) throw new Error('editor iframe missing');
        log(`iframe offset in tester page: (${ifr.left},${ifr.top})`);
        const clickXY = { x: canvasXY.x + ifr.left, y: canvasXY.y + ifr.top };
        log(`canvas page-mouse click coords: (${clickXY.x},${clickXY.y})`);

        for (let i = 1; i <= 3; i++) {
            evidence.cycleRan = i;
            await runOneCycle(page, frame, clickXY, ifr, i, evidence);
            // Cleanup BETWEEN cycles: deselect the shape so the notebookbar
            // leaves the context-sensitive Shape tab (Insert unreachable
            // from there).
            await page.keyboard.press('Escape');
            await sleep(250);
            await page.keyboard.press('Escape');
            await sleep(250);
            const leftClickX = Math.max(clickXY.x - 350, ifr.left + 200);
            const leftClickY = clickXY.y - 200;
            await page.mouse.click(leftClickX, leftClickY);
            await sleep(600);
            for (let j = 0; j < 3; j++) {
                const shapeStillActive = await frame.evaluate(() => {
                    const t = document.querySelector('#Shape-tab-label');
                    if (!t) return false;
                    return !t.className.includes('hidden');
                }).catch(() => false);
                if (!shapeStillActive) break;
                await page.keyboard.press('Escape');
                await sleep(400);
            }
            await sleep(400);
        }

        // ============ Hard assertions ============

        // ── Bug A: rounded-square + rounded-rectangle entries present ──
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
        const c1 = evidence.canvasHashCycles.find(c => c.cycle === 1);
        const c1RenderedShape = c1 && c1.after != null
            && evidence.baselineCanvasHash != null
            && c1.after !== evidence.baselineCanvasHash;
        check('Cycle-1 canvas hash differs from empty baseline after rounded-rectangle drag (Bug A revised — body must render, not just dashed marker)',
              !!c1RenderedShape,
              `baseline=${evidence.baselineCanvasHash} cycle1.after=${c1?.after} ` +
              `samples=${JSON.stringify(evidence.canvasHashCycles.map(c => ({c:c.cycle, b:c.before, a:c.after})))}`);

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
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 200));
    } finally {
        try { await browser.close(); } catch (_) {}
    }

    process.exit(allPassed ? 0 : 1);
})();
