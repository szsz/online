// test-cv-regression-writer-shape-area-oom.js — Writer right-click → "Area..."
// on an inserted shape must not crash the WASM kit with an OOM abort
// ("Cannot enlarge memory arrays") — content-viewer harness.
//
// History: WASM was pinned at TOTAL_MEMORY=1GB with no ALLOW_MEMORY_GROWTH;
// the SvxAreaTabDialog ctor allocated past the cap →
//   Aborted(Cannot enlarge memory arrays to size ... (OOM) ...)
//   COOL Error: jserror "Uncaught RuntimeError: unreachable"
//
// Repro: open a Writer doc, insert a rectangle (Insert → Shapes →
// BasicShapes.rectangle, drag), right-click the shape, click "Area..." in
// the context menu, wait 15 s.
//
// Asserts (identical to the legacy test):
//   - no OOM / abort / unreachable console or pageerror line after Area click
//   - window.app still defined, Module.HEAP8 still alive
//
// Migrated from wasm/tests/regression/test-regression-writer-shape-area-oom.js
// — legacy version retired.
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, waitCvInteractive, cvEditorFrame } =
    require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/regression-writer-shape-area-oom';
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

// Click a context-menu item whose label matches `labelRegex` via real mouse.
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

// Click the Writer notebookbar's Insert tab.
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

// Real-click a specific shape tile (by data-uno) in the .insertshape-grid.
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

(async () => {
    log('=== CV Regression: Writer right-click → Area must not trigger WASM OOM ===');
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

        // Always-on console + pageerror sinks. Started BEFORE the doc opens
        // so an early abort during init isn't missed; the OOM-specific
        // filter runs against the delta after the Area click.
        const consoleLines = [];
        const pageErrors   = [];
        page.on('console', m => consoleLines.push(m.text()));
        page.on('pageerror', e => pageErrors.push(e.message || String(e)));

        await openViaContentViewer(browser, BASE, FIXTURE,
            { page, viewport: { width: 1400, height: 900 }, iframeTimeout: 60000 });
        if (!(await waitCvInteractive(page, LOAD_BUDGET)))
            throw new Error('doc never became interactive in content viewer');
        const frame = cvEditorFrame(page);
        if (!frame) throw new Error('editor frame never loaded');
        await frame.waitForFunction(
            () => {
                const wc = document.querySelector('#StateWordCount')?.textContent || '';
                const pp = document.querySelector('#StatusDocPos')?.textContent || '';
                return wc.length > 0 || pp.length > 0;
            },
            { timeout: 150000 });
        await sleep(2500);
        await snap(page, 'loaded');

        // Canvas centre + iframe offset (for page.mouse coords).
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

        const ifr = await page.evaluate(() => {
            const f = document.querySelector('iframe');
            if (!f) return null;
            const r = f.getBoundingClientRect();
            return { left: Math.round(r.left), top: Math.round(r.top) };
        });
        if (!ifr) throw new Error('editor iframe missing');
        const clickXY = { x: canvasXY.x + ifr.left, y: canvasXY.y + ifr.top };
        log(`canvas page-mouse click coords: (${clickXY.x},${clickXY.y})`);

        // ── Step 4: open the Insert tab ──
        await page.keyboard.press('Escape');
        await sleep(300);
        await page.mouse.click(clickXY.x, clickXY.y);
        await sleep(400);
        const ins = await clickInsertTab(page, frame, ifr);
        log(`Insert tab click → ok=${ins.ok} ${ins.why || ''}`);
        await sleep(600);
        await snap(page, 'insert_tab');

        // ── Step 5a: open Shapes popup ──
        const sm = await clickShapesMenubutton(page, frame, ifr);
        log(`shapes menubutton click → ok=${sm.ok} sel=${sm.sel || ''} ${sm.why || ''}`);
        await sleep(800);
        await snap(page, 'shapes_popup');

        // ── Step 5b: pick a basic rectangle and drag-insert ──
        const SHAPE_UNO = 'BasicShapes.rectangle';
        const tile = await clickShapeTile(page, frame, ifr, SHAPE_UNO);
        log(`clicked tile [${SHAPE_UNO}] → ok=${tile.ok} ${tile.why || ''}`);
        if (!tile.ok) {
            // Fallback: any tile — we still want the right-click → Area path.
            log('  rect tile missing — trying first available tile');
            const anyTile = await frame.evaluate(() => {
                const grid = document.querySelector('.insertshape-grid');
                if (!grid) return null;
                const t = grid.querySelector('.col');
                if (!t) return null;
                const r = t.getBoundingClientRect();
                return { x: r.left, y: r.top, w: r.width, h: r.height,
                         uno: t.dataset.uno || '' };
            });
            if (anyTile) {
                await page.mouse.click(anyTile.x + anyTile.w / 2 + ifr.left,
                                       anyTile.y + anyTile.h / 2 + ifr.top);
                log(`  fallback tile uno=${anyTile.uno}`);
            } else {
                throw new Error('no shape tile present — cannot drive insert flow');
            }
        }
        await sleep(500);
        await snap(page, 'shape_armed');

        // Drag a 200×140 rectangle. Centre = shape center for right-click.
        const startX = clickXY.x;
        const startY = clickXY.y;
        const endX   = clickXY.x + 200;
        const endY   = clickXY.y + 140;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(endX, endY, { steps: 8 });
        await page.mouse.up();
        const shapeCenter = { x: (startX + endX) / 2, y: (startY + endY) / 2 };
        await sleep(2500);
        await snap(page, 'shape_placed');

        // ── Step 6: right-click on the inserted shape ──
        log(`right-clicking shape at (${shapeCenter.x},${shapeCenter.y})`);
        await page.mouse.click(shapeCenter.x, shapeCenter.y, { button: 'right' });
        let menuVisible = false;
        for (let i = 0; i < 30 && !menuVisible; i++) {
            menuVisible = await frame.evaluate(() =>
                !!document.querySelector('.context-menu-list, .on-the-fly-context-menu')
            ).catch(() => false);
            if (!menuVisible) await sleep(150);
        }
        await snap(page, 'context_menu');
        if (!menuVisible) {
            log('FAIL: no context menu appeared after right-click — cannot reach Area');
            check('context menu visible after right-click on shape', false,
                  'no .context-menu-list / .on-the-fly-context-menu in DOM');
            process.exit(allPassed ? 0 : 1);
        }
        const itemsDump = await frame.evaluate(() => Array.from(
            document.querySelectorAll('.context-menu-item')).map(el =>
                (el.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 50)));
        log(`context-menu items (${itemsDump.length}): ${JSON.stringify(itemsDump.slice(0, 14))}`);

        // ── Step 7: snapshot the sink baselines BEFORE clicking Area ──
        const beforeConsoleLen = consoleLines.length;
        const beforePageErrLen = pageErrors.length;
        log(`pre-Area baseline: ${beforeConsoleLen} console lines, ${beforePageErrLen} pageerrors`);

        // ── Step 8: real-click "Area..." in the context menu ──
        const area = await realClickMenuItem(page, frame, /^\s*Area/i, ifr);
        log(`Area... menu item click → ok=${area.ok} item="${area.item || ''}" ${area.why || ''}`);
        if (!area.ok) {
            log('FAIL: "Area..." menu item not present — cannot drive OOM path');
            log(`menu items present: ${JSON.stringify(itemsDump)}`);
            check('Area... menu item present in shape context menu', false,
                  `items=${JSON.stringify(itemsDump.slice(0, 14))}`);
            process.exit(allPassed ? 0 : 1);
        }
        await snap(page, 'after_area_click_immediate');

        // ── Step 9: wait 15 s for the OOM to fire ──
        await sleep(5000);
        await snap(page, 'after_area_click_5s');
        await sleep(5000);
        await snap(page, 'after_area_click_10s');
        // Nudge the mainloop with a tiny mouse move.
        await page.mouse.move(clickXY.x + 5, clickXY.y + 5);
        await sleep(5000);
        await snap(page, 'after_area_click_15s');

        // ── Step 10: scan the delta sink for OOM signatures ──
        const newConsole = consoleLines.slice(beforeConsoleLen);
        const newPageErr = pageErrors.slice(beforePageErrLen);

        const oomRegex = /Cannot enlarge memory arrays|enlargeMemory|OOM/i;
        const unreachableRegex = /Uncaught RuntimeError: unreachable|unreachable/i;
        const jserrorRegex = /COOL Error.*jserror|jserror.*Uncaught/i;
        const abortRegex   = /Aborted\(|WASM_ABORT/i;

        const abortLines = [];
        for (const line of newConsole) {
            if (oomRegex.test(line) || unreachableRegex.test(line)
             || jserrorRegex.test(line) || abortRegex.test(line)) {
                abortLines.push(line.substring(0, 400));
            }
        }
        for (const err of newPageErr) {
            if (oomRegex.test(err) || unreachableRegex.test(err)
             || abortRegex.test(err)) {
                abortLines.push('[pageerror] ' + err.substring(0, 400));
            }
        }

        log(`post-Area: ${newConsole.length} new console lines, ${newPageErr.length} new pageerrors`);
        log(`detected abort/OOM lines: ${abortLines.length}`);
        abortLines.slice(0, 5).forEach((l, i) => log(`  [${i}] ${l}`));

        // ── Hard assertion ─────────────────────────────────────────
        check('no OOM / abort / unreachable after right-click → Area on inserted shape',
              abortLines.length === 0,
              abortLines[0]?.substring(0, 200) || 'clean');

        // Liveness — kit must still be responsive.
        const alive = await frame.evaluate(() => ({
            hasApp:    !!window.app,
            hasModule: !!(window.Module && window.Module.HEAP8),
            wordcount: document.querySelector('#StateWordCount')?.textContent || '',
            statepos:  document.querySelector('#StatusDocPos')?.textContent || '',
        })).catch(() => ({ hasApp: false, hasModule: false, wordcount: '', statepos: '' }));
        check('window.app still defined after Area click',
              alive.hasApp === true);
        check('window.Module.HEAP8 still alive after Area click',
              alive.hasModule === true,
              `app=${alive.hasApp}`);

        log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 200));
    } finally {
        try { await browser.close(); } catch (_) {}
    }

    process.exit(allPassed ? 0 : 1);
})();
