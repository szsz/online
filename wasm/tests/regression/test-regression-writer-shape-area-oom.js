const __cl = require('../../lib/inject-checklist');
// Regression: Writer right-click → "Area..." on an inserted shape must not
// crash the WASM kit with an OOM abort ("Cannot enlarge memory arrays").
//
// User report 2026-06-02 (internal build editor `2026-06-02-174734` on
// `wasmeditor-enhhe6gndwb0d2ej.a02.azurefd.net`):
//
//   Aborted(Cannot enlarge memory arrays to size 1236799488 bytes (OOM).
//     Either (1) compile with -sINITIAL_MEMORY=X with X higher than the
//     current value 1073741824, (2) compile with -sALLOW_MEMORY_GROWTH ...)
//   …
//   COOL Error: jserror "Uncaught RuntimeError: unreachable"
//     source: …/browser/dist/online.js
//
// The abort fires during `.uno:FormatArea` triggered by clicking
// "Area..." in the shape's right-click context menu. WASM has been
// pinned at TOTAL_MEMORY=1GB (see
// solenv/gbuild/platform/EMSCRIPTEN_INTEL_GCC.mk:18) with no
// ALLOW_MEMORY_GROWTH; the SvxAreaTabDialog constructor allocates past
// the 1 GB cap and emscripten aborts.
//
// Repro recipe (per user):
//   1. Open a Writer doc.
//   2. Insert any shape (Insert → Shape → BasicShapes.rectangle).
//   3. Right-click the shape.
//   4. Click "Area..." in the context menu.
//   5. WASM allocs past the 1 GB cap → Aborted(...) → unreachable.
//
// This test:
//   1. Uploads test/data/new.docx via v2 (URL-fragment secret).
//   2. Opens it in /?singleuser#file=<secret> in real headless chromium.
//   3. Waits for __wasmInitialDocLoaded + StateWordCount/StatusDocPos.
//   4. Clicks Insert ribbon tab via real mouse.
//   5. Clicks the Shapes menubutton; real-clicks the
//      BasicShapes.rectangle tile (any basic shape is fine for triggering
//      the abort — Area dialog is what trips it). Drag-inserts a 200×140
//      rectangle on the canvas.
//   6. Right-clicks the shape's centre.
//   7. Hooks the abort detection (console + pageerror) BEFORE clicking
//      "Area..." so the first allocation failure inside the dialog ctor
//      is captured.
//   8. Real-clicks "Area..." in the context menu.
//   9. Waits 15 s for the OOM to trigger (the user's stack shows it
//      fires synchronously inside the dialog-open mainloop tick).
//  10. Asserts `abortLines.length === 0`. Test FAILS in the broken state
//      (the bug reproduces), PASSES once the OOM is fixed (either by
//      raising INITIAL_MEMORY past the 1 GB cap, by enabling
//      ALLOW_MEMORY_GROWTH, or by fixing whatever LO codepath allocates
//      200+ MB at Area-dialog-open).
//
// This is a "tripwire" test — it goes in first as the bug's permanent
// record, expected to FAIL on internal until the OOM is fixed.

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

const VIEWER  = env.FILE_STORAGE_URL;
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-writer-shape-area-oom';

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

// Click a context-menu item whose label matches `labelRegex` via real
// page.mouse.click on its bounding rect centre. Returns ok=false if no
// matching .context-menu-item / .menu-entry-* element materialises.
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

// Click the Writer notebookbar's Insert tab. The DOM id pattern is
// '#Insert-tab-label' — set by Control.Toolbar.js when the notebookbar
// renders. Returns ok=false if the tab isn't visible (e.g. the popup
// state machine has the Shape context tab active instead).
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

// Click the Shapes menubutton in the Insert tab. The runtime DOM id is
// derived from 'insert-insert-shapes' (with a numeric uid suffix on the
// container + a '-button' suffix on the inner button). Either click
// opens the .insertshape-grid popup.
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

// Real-click a specific shape tile (by data-uno value) in the
// .insertshape-grid popup. Returns ok=false if the tile isn't present.
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
    log('=== Regression: Writer right-click → Area must not trigger WASM OOM ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(FIXTURE)) {
        log(`SKIP: fixture missing: ${FIXTURE}`);
        process.exit(2);
    }

    const bytes = fs.readFileSync(FIXTURE);
    const name  = `writer-shape-area-oom-${Date.now()}.docx`;
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

        // Always-on console + pageerror sinks. We start them BEFORE
        // page.goto so an early abort during init isn't missed; the
        // OOM-specific filter runs against the same shared sinks in
        // step 7 just before we click Area.
        const consoleLines = [];
        const pageErrors   = [];
        page.on('console', m => consoleLines.push(m.text()));
        page.on('pageerror', e => pageErrors.push(e.message || String(e)));

        await page.goto(`${VIEWER}/?singleuser#file=${up.b64urlSecret}`,
            { waitUntil: 'domcontentloaded',
              timeout: env.scaleTimeout(120000) });

        // Locate the editor iframe + canvas + Writer status indicator.
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
        await frame.waitForFunction(
            () => {
                const wc = document.querySelector('#StateWordCount')?.textContent || '';
                const pp = document.querySelector('#StatusDocPos')?.textContent || '';
                return wc.length > 0 || pp.length > 0;
            },
            { timeout: env.scaleTimeout(90000) });
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
        if (!ifr) throw new Error('viewer iframe missing');
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
        // The user said "any shape e.g. Insert → Shape → BasicShapes.rectangle"
        // — we use the plain rectangle, not rounded-rectangle (which
        // has its own separate rendering bug; see
        // test-regression-writer-insert-shape-area.js Bug A revised).
        const SHAPE_UNO = 'BasicShapes.rectangle';
        const tile = await clickShapeTile(page, frame, ifr, SHAPE_UNO);
        log(`clicked tile [${SHAPE_UNO}] → ok=${tile.ok} ${tile.why || ''}`);
        if (!tile.ok) {
            // Fallback: try the rounded-rectangle tile, or any tile at all.
            // We still want the test to reach the right-click → Area path.
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
        // The user's stack shows the abort fires inside the dialog-open
        // mainloop tick, synchronously from the Area click. Capture the
        // pre-click size of the sinks so the post-click delta is
        // attributable to the Area dispatch (and not to earlier init
        // noise like a benign "WebSocket reconnect" line).
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
        // User's stack shows it fires synchronously inside the
        // dialog-open mainloop tick. We give a generous 15 s wall
        // budget so a slow Azure tile-render doesn't mask it.
        await sleep(5000);
        await snap(page, 'after_area_click_5s');
        await sleep(5000);
        await snap(page, 'after_area_click_10s');
        // Nudge the mainloop with a tiny mouse move to drive any
        // pending render/tick.
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

        // Liveness — kit must still be responsive (i.e. the abort didn't
        // tear down the page beyond just the console scream).
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
    } finally {
        await browser.close();
    }

    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e.stack || e.message);
    process.exit(2);
});
