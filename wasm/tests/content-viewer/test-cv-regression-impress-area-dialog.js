// test-cv-regression-impress-area-dialog.js — Impress shape Area dialog must
// not crash the kit with a "memory access out of bounds" trap in the
// Browser_mainLoop chain (content-viewer harness).
//
// History: sd/source/ui/func/fuarea.cxx StartExecuteAsync callback captured
// pView + pViewShell by raw pointer and ran after FuArea unwound → freed-
// memory dereference on Apply. Repro: select the title placeholder,
// right-click → Area… → pick colour → OK, three deterministic cycles.
//
// Asserts (identical to the legacy test):
//   - no "memory access out of bounds" console/pageerror event
//   - no Pthread "sent an error" console line
//   - no WASM_ABORT / Aborted( console line
//   - no "unreachable" trap
//   - Area dialog appeared on at least one cycle
//   - window.app + Module.HEAP8 still alive after 3 cycles
//   - slide-status indicator still renders after 3 cycles
//
// Migrated from wasm/tests/regression/test-regression-impress-area-dialog.js
// — legacy version retired.
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, waitCvInteractive, cvEditorFrame } =
    require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'testdoc.pptx');
const SHOT_DIR = '/tmp/content-viewer-report/regression-impress-area-dialog';
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

// Real puppeteer click on a context-menu item with a visible label
// matching `labelRegex`. Reads getBoundingClientRect (DOM-state read),
// then drives page.mouse at centre + iframe offset.
async function realClickMenuItem(page, frame, labelRegex, kind, ifr) {
    const selector = kind === 'context'
        ? '.context-menu-item'
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

// Click an OK / Apply button inside any visible jsdialog.
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

// Pick the first visible colour tile in the open Area dialog.
async function realClickFirstColorTile(page, frame, ifr) {
    let bbox = null;
    for (let i = 0; i < 80; i++) {
        bbox = await frame.evaluate(() => {
            const candidates = Array.from(document.querySelectorAll(
                '[style*="background-color"]'));
            const tiles = candidates.filter(t => {
                if (!t.offsetParent) return false;  // not rendered
                const r = t.getBoundingClientRect();
                if (r.width < 6 || r.height < 6) return false;
                if (r.width > 60 || r.height > 60) return false;  // skip big bg panels
                if (r.top < 50) return false;  // skip top-bar elements
                const bg = t.style.backgroundColor || '';
                if (!bg || /rgba?\(255,\s*255,\s*255/.test(bg) || /transparent/.test(bg)) return false;
                return true;
            });
            if (!tiles.length) return null;
            const found = tiles[Math.floor(tiles.length / 2)];  // middle tile
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

// ONE attempt of (right-click → Area → colour → OK).
async function runOneAreaCycle(page, frame, titleXY, ifr, runIdx, evidence) {
    log(`--- cycle ${runIdx}: starting Area-dialog repro (click @ ${titleXY.x},${titleXY.y}) ---`);
    const titleX = titleXY.x;
    const titleY = titleXY.y;

    // Select the title placeholder rectangle (not text-edit mode).
    await page.mouse.click(titleX, titleY);
    await sleep(600);
    await page.keyboard.press('Escape');
    await sleep(400);
    await page.mouse.click(titleX, titleY);
    await sleep(700);
    await snap(page, `c${runIdx}_shape_selected`);

    // Right-click on the placeholder rim (off the glyph centre).
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

    const items = await frame.evaluate(() => Array.from(
        document.querySelectorAll('.context-menu-item')).map(
            el => (el.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 50)));
    log(`  cycle ${runIdx}: context-menu items (${items.length}): ${JSON.stringify(items.slice(0, 14))}`);

    const area = await realClickMenuItem(page, frame, /^\s*Area/i, 'context', ifr);
    if (!area.ok) {
        log(`  cycle ${runIdx}: NO Area menu item found: ${area.why}`);
        return { ok: false, why: area.why };
    }
    log(`  cycle ${runIdx}: clicked context-menu item "${area.item}"`);

    // Wait for the Area dialog to appear.
    let dialogVisible = false;
    for (let i = 0; i < 80 && !dialogVisible; i++) {
        dialogVisible = await frame.evaluate(() => {
            const dlg = document.querySelector('.jsdialog .ui-dialog, .lokdialog, .modaldialog');
            if (dlg && dlg.offsetWidth > 0) return true;
            const titles = Array.from(document.querySelectorAll(
                '.jsdialog .ui-dialog-title, .lokdialog-titlebar'));
            return titles.some(t => /Area/i.test(t.textContent || ''));
        }).catch(() => false);
        if (!dialogVisible) await sleep(200);
    }
    await snap(page, `c${runIdx}_area_dialog_open`);
    log(`  cycle ${runIdx}: area dialog visible? ${dialogVisible}`);
    if (!dialogVisible) {
        evidence.dialogNeverAppeared.push(runIdx);
    }

    if (dialogVisible) {
        // Switch to the Color fill-type panel first.
        const colorTab = await frame.evaluate(() => {
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
            // frame.click drives real CDP Input.dispatchMouseEvent; keyboard
            // Enter is the fallback path (different handler chain).
            try {
                await frame.click('#btncolor-button');
            } catch (e) { /* ignore */ }
            log(`  cycle ${runIdx}: frame.click('#btncolor-button') attempted`);
            await sleep(1500);
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

        // OK — fires SetAttributes in the async callback (the crash trigger).
        const ok = await realClickDialogOk(page, frame, ifr);
        log(`  cycle ${runIdx}: OK click → ok=${ok.ok} id=${ok.id || ''} label="${ok.label || ''}" ${ok.why || ''}`);
    }

    // Settle: give the kit ≥ 4 s for the StartExecuteAsync callback +
    // the next Browser_mainLoop tick.
    await sleep(2000);
    await snap(page, `c${runIdx}_after_ok_2s`);
    await sleep(3000);
    await snap(page, `c${runIdx}_after_ok_5s`);

    // ALSO: Ctrl+S after the Area Apply — the original report says "save
    // fails / only Discard works"; the trap might fire on the save path.
    await page.keyboard.down('Control');
    await page.keyboard.press('s');
    await page.keyboard.up('Control');
    await sleep(2500);
    await snap(page, `c${runIdx}_after_ctrl_s`);

    // Longer settle — the trap fires from a Browser_mainLoop tick which
    // could be 1-30 s after Apply.
    await sleep(5000);
    await snap(page, `c${runIdx}_after_ctrl_s_5s`);

    // Nudge the kit with a benign mouse-move so its tick runs.
    await page.mouse.move(titleX + 5, titleY + 5);
    await sleep(300);
    await page.mouse.move(titleX, titleY);
    await sleep(2000);
    await snap(page, `c${runIdx}_after_jitter`);

    return { ok: true };
}

(async () => {
    log('=== CV Regression: Impress Area dialog must not crash kit (memory access OOB) ===');
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

        // Evidence buckets — fatal console lines, pageerrors, wasm-stack
        // signatures, missed dialogs. Attached BEFORE the doc opens.
        const evidence = {
            wasmAborts:           [],
            pthreadErrors:        [],
            memoryOOB:            [],
            unreachable:          [],
            pageErrors:           [],
            jserrors:             [],
            wasmStackFuncs:       new Set(),
            dialogNeverAppeared:  [],
            cycleRan:             0,
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
            { page, viewport: { width: 1280, height: 900 }, iframeTimeout: 60000 });
        if (!(await waitCvInteractive(page, LOAD_BUDGET)))
            throw new Error('doc never became interactive in content viewer');
        const frame = cvEditorFrame(page);
        if (!frame) throw new Error('editor frame never loaded');
        await frame.waitForFunction(
            () => /Slide\s+\d+\s+of\s+\d+/i.test(
                document.querySelector('#SlideStatus')?.textContent || ''),
            { timeout: 60000 });
        await sleep(2500);
        await snap(page, 'loaded');

        // Title-placeholder centre in iframe coords (~centre-x, ~30% down).
        const titleXY = await frame.evaluate(() => {
            const c = document.querySelector('#document-canvas');
            if (!c) return null;
            const r = c.getBoundingClientRect();
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

        // The editor iframe sits at an offset inside the tester page.
        const ifr = await page.evaluate(() => {
            const f = document.querySelector('iframe');
            if (!f) return null;
            const r = f.getBoundingClientRect();
            return { left: Math.round(r.left), top: Math.round(r.top) };
        });
        if (!ifr) throw new Error('editor iframe missing');
        log(`iframe offset in tester page: (${ifr.left},${ifr.top})`);
        const clickXY = { x: titleXY.x + ifr.left, y: titleXY.y + ifr.top };
        log(`page-mouse click coords: (${clickXY.x},${clickXY.y})`);

        // Three deterministic cycles to attest reproduction rate.
        for (let i = 1; i <= 3; i++) {
            evidence.cycleRan = i;
            await runOneAreaCycle(page, frame, clickXY, ifr, i, evidence);
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
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 200));
    } finally {
        try { await browser.close(); } catch (_) {}
    }

    process.exit(allPassed ? 0 : 1);
})();
