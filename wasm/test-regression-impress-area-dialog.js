const __cl = require('./lib/inject-checklist');
// Regression: Impress shape Area dialog must not crash the kit with a
// "memory access out of bounds" trap in the Browser_mainLoop chain.
//
// User report (2026-05-31, on editor build 2026-05-27-022740):
//   In Impress, after creating a shape and modifying its Area (via
//   right-click → Area → pick color → OK), the WASM kit emits:
//     Pthread 0x... sent an error!
//     Uncaught RuntimeError: memory access out of bounds
//     COOL Error: jserror {"message":"Uncaught [object ErrorEvent]", ...}
//     $func57701 → $func150544 → $func150552 → $func150493 → $func150492
//     ... browserIterationFunc → Browser_mainLoop_runner
//
// The earlier task (impress-shape-area-cant-be-saved) was misdiagnosed
// as fixed by `fd4e2ec` (the "don't forward .uno:Save to kit" change).
// That fix is correct for the *save* assert, but it does NOT address the
// memory-access-out-of-bounds trap that fires after the Area dialog Apply
// — that trap originates inside LO's main loop, not at save time.
//
// Strongest pre-test hypothesis (H5 from the task body): the async
// callback installed by `pDlg->StartExecuteAsync(...)` in
// `sd/source/ui/func/fuarea.cxx:62` captures `pView` + `pViewShell` by
// raw pointer and is invoked from the timer/main-loop AFTER the `FuArea`
// dispatch frame has unwound. If anything along that chain (the FuArea
// rtl::Reference, the dialog's reference to draw-pool items, or the
// view's selection state) has been destroyed or mutated between dialog
// open and Apply, the callback dereferences freed memory.
//
// This test:
//   1. Open a pptx in singleuser editing mode.
//   2. Click the Title placeholder to select it (the shape we'll
//      operate on — the user said "create a shape", but the existing
//      title placeholder is *also* a shape with full Area-dialog
//      support, and using it makes the repro deterministic without
//      a fragile drag-to-place sequence).
//   3. Right-click on it.
//   4. Click "Area..." in the context menu via REAL mouse click.
//   5. In the dialog, click a colour tile + click OK via REAL mouse.
//   6. Wait a few seconds for the async callback + main-loop tick to
//      fire.
//   7. Assert: no "memory access out of bounds" pageerror, no
//      WASM_ABORT, no "Pthread ... sent an error" console line,
//      window.app + Module.HEAP8 still alive, slide-status indicator
//      still rendering.
//
// Pre-fix expectation: the assertions FAIL — the same memory-access-
// out-of-bounds trap the user observed. The test is a faithful
// reproducer; we'll diagnose from the captured stack + console.

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');

const VIEWER  = env.FILE_STORAGE_URL;
const FIXTURE = path.join(__dirname, '..', 'test', 'data', 'testdoc.pptx');
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-impress-area-dialog';

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

// Real puppeteer click on a context-menu item with a visible label
// matching `labelRegex`. Returns {ok, item} on success, {ok:false, why}
// otherwise. Uses getBoundingClientRect to derive coordinates — DOM-
// state read, not a synthetic .click().
async function realClickMenuItem(page, frame, labelRegex, kind, ifr) {
    const selector = kind === 'context'
        ? '.context-menu-item'
        // jsdialog menu items live in .jsdialog popup containers;
        // the Format/Area menu rendered from native menubar
        // dispatch may use either '.menu-entry-with-icon' or
        // standard 'li > a' patterns. Match defensively.
        : '.context-menu-item, .menu-entry-with-icon, .jsdialog li, .menu-entry-no-icon';
    let bbox = null;
    for (let i = 0; i < 30; i++) {
        bbox = await frame.evaluate(({sel, reSrc, reFlags}) => {
            const re = new RegExp(reSrc, reFlags);
            const items = Array.from(document.querySelectorAll(sel));
            const found = items.find(el => re.test(el.textContent || ''));
            if (!found) return null;
            const r = found.getBoundingClientRect();
            return {
                x: r.left, y: r.top, w: r.width, h: r.height,
                t: (found.textContent || '').trim().substring(0, 80),
            };
        }, { sel: selector, reSrc: labelRegex.source, reFlags: labelRegex.flags });
        if (bbox && bbox.w > 0 && bbox.h > 0) break;
        await sleep(150);
    }
    if (!bbox) return { ok: false, why: 'menu item not found' };
    const off = ifr || { left: 0, top: 0 };
    await page.mouse.click(bbox.x + bbox.w / 2 + off.left, bbox.y + bbox.h / 2 + off.top);
    return { ok: true, item: bbox.t };
}

// Click an OK / Apply button inside any visible jsdialog. Returns
// {ok, label} on success or {ok:false, why}. Strict: walks the DOM
// for a visible button with id matching `ok` or label "OK" / "Apply".
// ifr is the iframe page-offset so the page.mouse click lands in the
// right viewport coords.
async function realClickDialogOk(page, frame, ifr) {
    let bbox = null;
    for (let i = 0; i < 50; i++) {
        bbox = await frame.evaluate(() => {
            // Standard jsdialog OK button is button#ok inside .jsdialog.
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

// Pick the first visible colour tile in the open Area dialog. The
// Area page renders the Colour palette as a .color-sample-selector
// grid; tiles are .color-sample. If selectors change, fall back to
// any visible canvas-coloured rect inside the dialog.
async function realClickFirstColorTile(page, frame, ifr) {
    // The Area dialog's colour swatch grid is rendered as buttons
    // inside the colour-page; tiles carry inline `background-color`
    // style (or `aria-label` like "Red"). The Color sub-panel must
    // be visible first — gate on offsetParent != null. Iterate until
    // a visible tile shows up.
    let bbox = null;
    for (let i = 0; i < 80; i++) {
        bbox = await frame.evaluate(() => {
            // The dialog colour palette in jsdialog renders as a grid
            // of <div> tiles (no role=button) with inline style
            // `background-color: rgb(...);` — different from the
            // "Color" toggle button which has textContent "Color".
            // Look for any visible element whose inline-style
            // background-color is set to a non-empty value, AND that
            // is small (a swatch), AND whose offsetParent is set
            // (i.e. it's actually rendered).
            const candidates = Array.from(document.querySelectorAll(
                '[style*="background-color"]'));
            const tiles = candidates.filter(t => {
                if (!t.offsetParent) return false;  // not rendered
                const r = t.getBoundingClientRect();
                if (r.width < 6 || r.height < 6) return false;
                if (r.width > 60 || r.height > 60) return false;  // skip big bg panels
                if (r.top < 50) return false;  // skip top-bar elements
                const bg = t.style.backgroundColor || '';
                // Skip empty / transparent / white tiles so we
                // pick a real colour change.
                if (!bg || /rgba?\(255,\s*255,\s*255/.test(bg) || /transparent/.test(bg)) return false;
                return true;
            });
            if (!tiles.length) return null;
            const found = tiles[Math.floor(tiles.length / 2)];  // pick middle tile (skip top-left corner / black)
            const r = found.getBoundingClientRect();
            return {
                x: r.left, y: r.top, w: r.width, h: r.height,
                cls: (found.className || '').substring(0, 60),
                bg: found.style.backgroundColor || '',
                totalTiles: tiles.length,
            };
        });
        if (bbox) break;
        await sleep(200);
    }
    if (!bbox) return { ok: false, why: 'no colour tile found' };
    await page.mouse.click(bbox.x + bbox.w / 2 + ifr.left, bbox.y + bbox.h / 2 + ifr.top);
    return { ok: true, cls: bbox.cls, bg: bbox.bg, total: bbox.totalTiles };
}

// Drive ONE attempt of (right-click → Area → colour → OK). Returns
// the captured fatal-evidence snapshot taken AFTER the OK click +
// settle wait. The caller invokes this 3 times to confirm
// determinism.
async function runOneAreaCycle(page, frame, titleXY, ifr, runIdx, evidence) {
    log(`--- cycle ${runIdx}: starting Area-dialog repro (click @ ${titleXY.x},${titleXY.y}) ---`);
    const titleX = titleXY.x;
    const titleY = titleXY.y;

    // First click selects the title text-frame border (a real puppeteer
    // mouse click — single-click in Impress selects the placeholder
    // rectangle, NOT enter text-edit mode, which is what we want for
    // the Area dialog).
    await page.mouse.click(titleX, titleY);
    await sleep(600);
    // Press Escape so we're guaranteed to be in "shape-selected" mode
    // (not text-edit mode) — repeated clicks on the same placeholder
    // toggle into edit mode, and Area is greyed-out in edit mode.
    await page.keyboard.press('Escape');
    await sleep(400);
    // Click the rim again to ensure the placeholder is selected.
    await page.mouse.click(titleX, titleY);
    await sleep(700);
    await snap(page, `c${runIdx}_shape_selected`);

    // Right-click on the placeholder to bring up its context menu.
    // Slightly shift the right-click off the typed-text glyph centre
    // so we hit the placeholder rim, not the text run — Impress
    // selects the placeholder as a shape only when the click misses
    // any inner text-run.
    await page.mouse.click(titleX + 30, titleY, { button: 'right' });
    let menuVisible = false;
    for (let i = 0; i < 30 && !menuVisible; i++) {
        menuVisible = await frame.evaluate(() =>
            !!document.querySelector('.context-menu-list') ||
            !!document.querySelector('.on-the-fly-context-menu')
        ).catch(() => false);
        if (!menuVisible) await sleep(150);
    }
    await snap(page, `c${runIdx}_context_menu`);
    if (!menuVisible) {
        log(`  cycle ${runIdx}: NO context menu materialised — aborting cycle`);
        return { ok: false, why: 'no context menu' };
    }

    // Diagnostic: dump visible menu items.
    const items = await frame.evaluate(() => Array.from(
        document.querySelectorAll('.context-menu-item')).map(
            el => (el.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 50)));
    log(`  cycle ${runIdx}: context-menu items (${items.length}): ${JSON.stringify(items.slice(0, 14))}`);

    // Click "Area..." (or anything starting with Area). Label may include
    // an ellipsis (…) or three dots (...). The label is locale-sensitive
    // — the en-US build emits "Area..."; we match on the English text.
    const area = await realClickMenuItem(page, frame, /^\s*Area/i, 'context', ifr);
    if (!area.ok) {
        log(`  cycle ${runIdx}: NO Area menu item found: ${area.why}`);
        return { ok: false, why: area.why };
    }
    log(`  cycle ${runIdx}: clicked context-menu item "${area.item}"`);

    // Wait for the Area dialog to appear. Look for the dialog
    // container or a visible "Color" tab / "OK" button. jsdialog
    // emits the dialog as `.jsdialog.modalpopup` or `.lokdialog`
    // depending on the path, both with role=dialog typically.
    let dialogVisible = false;
    for (let i = 0; i < 80 && !dialogVisible; i++) {
        dialogVisible = await frame.evaluate(() => {
            const dlg = document.querySelector('.jsdialog .ui-dialog, .lokdialog, .modaldialog');
            if (dlg && dlg.offsetWidth > 0) return true;
            // Alternate: the dialog window-title containing "Area".
            const titles = Array.from(document.querySelectorAll(
                '.jsdialog .ui-dialog-title, .lokdialog-titlebar'));
            return titles.some(t => /Area/i.test(t.textContent || ''));
        }).catch(() => false);
        if (!dialogVisible) await sleep(200);
    }
    await snap(page, `c${runIdx}_area_dialog_open`);
    log(`  cycle ${runIdx}: area dialog visible? ${dialogVisible}`);
    if (!dialogVisible) {
        // The right-click → Area dispatch reached the kit but no
        // jsdialog appeared — that's *itself* a regression worth
        // surfacing, and it likely means the kit crashed during
        // CreateSvxAreaTabDialog. Capture this as part of evidence
        // and continue to the post-action assertions.
        evidence.dialogNeverAppeared.push(runIdx);
    }

    // Pick a colour tile (if the dialog rendered).
    if (dialogVisible) {
        // Step 1: click the "Color" fill-type tab/button. The Area
        // dialog opens on whichever fill-type the shape currently has
        // ("None" for a fresh title placeholder); to pick a real
        // colour we first switch to the Color panel. The fill-type
        // selector is a `weld::ToggleButton` group; in jsdialog DOM
        // they render as <button class="ui-pushbutton"> with a text
        // label child. Match defensively, prefer exact-text match,
        // and dump all candidate buttons for diagnostic clarity.
        const colorTab = await frame.evaluate(() => {
            // Enumerate visible candidates inside the dialog
            // container only — guard against matching toolbar
            // colour-pickers above the dialog (e.g. font colour).
            const dlg = document.querySelector(
                '.jsdialog .ui-dialog-content, .jsdialog [role="dialog"], .modaldialog, .lokdialog');
            const root = dlg || document;
            const candidates = Array.from(root.querySelectorAll(
                'button, [role="tab"], .ui-pushbutton, .ui-radio'));
            const visible = candidates.filter(t => {
                const r = t.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && r.top > 0;
            });
            const dump = visible.map(c => (c.textContent || '').trim().substring(0, 30));
            const found = visible.find(t =>
                /^\s*Color\s*$/i.test(t.textContent || ''));
            if (!found) return { tab: null, dump };
            const r = found.getBoundingClientRect();
            return {
                tab: { x: r.left + r.width / 2, y: r.top + r.height / 2,
                       id: found.id || '', cls: (found.className || '').substring(0, 60) },
                dump,
            };
        });
        log(`  cycle ${runIdx}: dialog button candidates (${(colorTab.dump || []).length}): ${JSON.stringify((colorTab.dump || []).slice(0, 20))}`);
        if (colorTab.tab) {
            // The jsdialog "Color" GtkToggleButton fires a UNO command
            // to switch the dialog's fill-type sub-panel. Empirically
            // (probe-dlg-dom.js) page.mouse.click / frame.click /
            // pointerdown / Space all leave aria-pressed=null and the
            // panel doesn't switch. Drive via puppeteer's frame-level
            // CDP click which uses real Input.dispatchMouseEvent. Also
            // try Tab+Tab+...+Space keyboard navigation as a fallback
            // — keyboard handlers go through a different code path.
            try {
                await frame.click('#btncolor-button');
            } catch (e) { /* ignore */ }
            log(`  cycle ${runIdx}: frame.click('#btncolor-button') attempted`);
            await sleep(1500);
            // Keyboard fallback: focus the Color button then press Enter.
            try {
                await frame.focus('#btncolor-button');
                await sleep(150);
                await page.keyboard.press('Enter');
                log(`  cycle ${runIdx}: focused #btncolor-button + Enter`);
                await sleep(1500);
            } catch (e) {
                log(`  cycle ${runIdx}: focus/Enter on Color toggle failed: ${e.message}`);
            }
        } else {
            log(`  cycle ${runIdx}: NO "Color" tab found — dialog may use a different layout`);
        }
        await snap(page, `c${runIdx}_color_tab`);

        const tile = await realClickFirstColorTile(page, frame, ifr);
        log(`  cycle ${runIdx}: colour tile click → ok=${tile.ok} bg=${tile.bg || ''} total=${tile.total || 0} ${tile.cls || tile.why}`);
        await sleep(800);
        await snap(page, `c${runIdx}_color_picked`);

        // Click OK — this is what fires SetAttributes in the async
        // callback, the suspected crash trigger.
        const ok = await realClickDialogOk(page, frame, ifr);
        log(`  cycle ${runIdx}: OK click → ok=${ok.ok} id=${ok.id || ''} label="${ok.label || ''}" ${ok.why || ''}`);
    }

    // Settle: give the kit ≥ 4 s for the StartExecuteAsync callback
    // + the next Browser_mainLoop tick to fire. The user-reported
    // trap is in that tick. We snap mid-settle so we have visual
    // evidence of any kit hang.
    await sleep(2000);
    await snap(page, `c${runIdx}_after_ok_2s`);
    await sleep(3000);
    await snap(page, `c${runIdx}_after_ok_5s`);

    // ALSO: trigger Ctrl+S after the Area dialog Apply — the
    // user-original report says "save fails / only Discard works".
    // The memory-access-out-of-bounds trap might fire on the SAVE
    // path immediately after the Area Apply, not on the Apply
    // itself. (The save no-forward fix in fd4e2ec stopped one
    // assertion path but the wasm-side trap may live elsewhere.)
    await page.keyboard.down('Control');
    await page.keyboard.press('s');
    await page.keyboard.up('Control');
    await sleep(2500);
    await snap(page, `c${runIdx}_after_ctrl_s`);

    // Longer settle — the user-observed trap fires from a
    // Browser_mainLoop tick which could be 1-30 seconds after Apply
    // depending on async-callback scheduling.
    await sleep(5000);
    await snap(page, `c${runIdx}_after_ctrl_s_5s`);

    // Also nudge the kit with a benign mouse-move so its tick
    // runs (the trap is in browserIterationFunc → runIter, which
    // only fires when there's pending work).
    await page.mouse.move(titleX + 5, titleY + 5);
    await sleep(300);
    await page.mouse.move(titleX, titleY);
    await sleep(2000);
    await snap(page, `c${runIdx}_after_jitter`);

    return { ok: true };
}

(async () => {
    log('=== Regression: Impress Area dialog must not crash kit (memory access OOB) ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(FIXTURE)) {
        log(`SKIP: fixture missing: ${FIXTURE}`);
        process.exit(2);
    }

    const bytes = fs.readFileSync(FIXTURE);
    const name  = `area-dialog-${Date.now()}.pptx`;
    const up    = await uploadV2(VIEWER, name, bytes);
    log(`uploaded ${name}`);

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });

        // Evidence buckets — fatal console lines, pageerrors, the
        // wasm-stack signatures from the user report, missed dialogs.
        const evidence = {
            wasmAborts:           [],   // "WASM_ABORT" / "Aborted("
            pthreadErrors:        [],   // "Pthread ... sent an error!"
            memoryOOB:            [],   // "memory access out of bounds"
            unreachable:          [],   // "unreachable" trap
            pageErrors:           [],   // all pageerrors verbatim
            jserrors:             [],   // "COOL Error: jserror"
            wasmStackFuncs:       new Set(),  // $funcNNNN from stacks
            dialogNeverAppeared:  [],   // cycle indices where dialog never showed
            cycleRan:             0,
        };

        page.on('console', m => {
            const t = m.text();
            // Capture the canonical fatal-signal lines verbatim.
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
            // Extract $funcNNNN signatures so we can compare across
            // runs (same bottom-of-stack across cycles → deterministic
            // crash site).
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

        // Wait for editor iframe + canvas + Impress slide-status.
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
            () => /Slide\s+\d+\s+of\s+\d+/i.test(
                document.querySelector('#SlideStatus')?.textContent || ''),
            { timeout: env.scaleTimeout(45000) });
        await sleep(2500);
        await snap(page, 'loaded');

        // Locate the title placeholder centre in viewport coords by
        // reading the slide canvas's getBoundingClientRect from inside
        // the iframe. In testdoc.pptx the title sits ~25% from the top
        // and centred horizontally on the slide.
        const titleXY = await frame.evaluate(() => {
            const c = document.querySelector('#document-canvas');
            if (!c) return null;
            const r = c.getBoundingClientRect();
            // Iframe is positioned at viewer (0,0) inside the page; the
            // iframe origin maps 1:1 to page coords as long as the
            // viewer wraps the iframe full-bleed (which it does — see
            // viewer-public/index.html). Title placeholder centre is
            // ~horizontal-centre + ~30% from the top of the canvas.
            return {
                x: Math.round(r.left + r.width * 0.5),
                y: Math.round(r.top + r.height * 0.30),
                cw: Math.round(r.width),
                ch: Math.round(r.height),
                rx: Math.round(r.left),
                ry: Math.round(r.top),
            };
        });
        if (!titleXY) throw new Error('document canvas missing');
        log(`canvas viewport rect: top-left=(${titleXY.rx},${titleXY.ry}) size=(${titleXY.cw}x${titleXY.ch})`);
        log(`title-placeholder click target: (${titleXY.x},${titleXY.y})`);

        // The iframe is mounted inside the viewer page at some offset
        // (the viewer has a top bar + sidebar). Page-level
        // page.mouse.click uses VIEWER-page coords, while the
        // bounding-rect we read is IFRAME-local. Compute iframe offset.
        const ifr = await page.evaluate(() => {
            const f = document.querySelector('iframe');
            if (!f) return null;
            const r = f.getBoundingClientRect();
            return { left: Math.round(r.left), top: Math.round(r.top) };
        });
        if (!ifr) throw new Error('viewer iframe missing');
        log(`iframe offset in viewer page: (${ifr.left},${ifr.top})`);
        const clickXY = { x: titleXY.x + ifr.left, y: titleXY.y + ifr.top };
        log(`page-mouse click coords: (${clickXY.x},${clickXY.y})`);

        // Three deterministic cycles. The user report says the trap
        // fires on the FIRST run after the Apply; do three so we can
        // attest reproduction rate.
        for (let i = 1; i <= 3; i++) {
            evidence.cycleRan = i;
            await runOneAreaCycle(page, frame, clickXY, ifr, i, evidence);
            // Try to dismiss anything still open between cycles.
            await page.keyboard.press('Escape');
            await sleep(300);
            await page.keyboard.press('Escape');
            await sleep(500);
        }

        // ========== Hard assertions ==========
        check('no "memory access out of bounds" event after Area dialog Apply',
              evidence.memoryOOB.length === 0,
              evidence.memoryOOB[0]
                ? evidence.memoryOOB[0].substring(0, 140)
                : '');
        check('no Pthread "sent an error" console line',
              evidence.pthreadErrors.length === 0,
              evidence.pthreadErrors[0]
                ? evidence.pthreadErrors[0].substring(0, 140)
                : '');
        check('no WASM_ABORT / Aborted( console line',
              evidence.wasmAborts.length === 0,
              evidence.wasmAborts[0]
                ? evidence.wasmAborts[0].substring(0, 140)
                : '');
        check('no "unreachable" trap',
              evidence.unreachable.length === 0,
              evidence.unreachable[0]
                ? evidence.unreachable[0].substring(0, 140)
                : '');
        check('Area dialog appeared on at least one cycle',
              evidence.dialogNeverAppeared.length < 3,
              `missed=[${evidence.dialogNeverAppeared.join(',')}]`);

        const alive = await frame.evaluate(() => ({
            hasApp:    !!window.app,
            hasMap:    !!window.app?.map,
            hasModule: !!(window.Module && window.Module.HEAP8),
            slide:     document.querySelector('#SlideStatus')?.textContent || '',
        }));
        check('window.app still defined after 3 Area-dialog cycles',
              alive.hasApp === true);
        check('window.Module still healthy (HEAP8 present) after 3 cycles',
              alive.hasModule === true,
              `app=${alive.hasApp} map=${alive.hasMap}`);
        check('slide-status indicator still renders after 3 cycles',
              /Slide\s+\d+\s+of\s+\d+/i.test(alive.slide),
              `"${alive.slide}"`);

        // ========== Diagnostic dump ==========
        log('');
        log('=== Evidence dump ===');
        log(`cycles ran:            ${evidence.cycleRan}`);
        log(`memory-OOB events:     ${evidence.memoryOOB.length}`);
        log(`pthread errors:        ${evidence.pthreadErrors.length}`);
        log(`WASM_ABORT events:     ${evidence.wasmAborts.length}`);
        log(`unreachable traps:     ${evidence.unreachable.length}`);
        log(`pageerrors total:      ${evidence.pageErrors.length}`);
        log(`jserror lines:         ${evidence.jserrors.length}`);
        log(`dialog-no-show cycles: [${evidence.dialogNeverAppeared.join(',')}]`);
        log(`unique $funcNNNN ids:  ${evidence.wasmStackFuncs.size}`);
        if (evidence.wasmStackFuncs.size) {
            log(`  funcs: ${Array.from(evidence.wasmStackFuncs).slice(0, 20).join(' ')}`);
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
