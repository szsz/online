const __cl = require('../../lib/inject-checklist');
// Regression: Calc sheet TAB strip — visibility, click-to-activate,
// double-click rename, right-click → "Rename Sheet…" rename.
//
// User-reported behavior 2026-06-01:
//   (1) In Calc/xlsx editing the sheet tab strip at the bottom only
//       shows the nav arrows (|< < > >|) + the "+" insert button.
//       The TABS themselves are either not visible OR not clickable
//       to switch sheet.
//   (2) Renaming a sheet via standard gestures (double-click the tab,
//       OR right-click → "Rename Sheet…") doesn't work.
//
// This test covers a different surface than `regression-xlsx-sheet-nav`
// (which exercises the nav-arrow buttons in `#spreadsheet-toolbar`).
// Here we drive:
//
//   Test A — each sheet has a visible, non-zero-width tab. Probe
//            `#spreadsheet-tab-scroll > *` count vs. visible-part count
//            (`app.calc.getVisiblePartCount()`), and assert every
//            `.spreadsheet-tab` child has a non-zero rendered width.
//
//   Test B — real `page.mouse.click()` on tab #2's bounding box.
//            Assert `_docLayer._selectedPart === 1` (0-indexed) AND
//            `#StatusDocPos` flips to "Sheet 2 of 2".
//
//   Test C — real `page.mouse.click(..., { clickCount: 2 })` on tab #1.
//            Per Control.Tabs.js:243 a dblclick handler is wired that
//            calls `_renameSheet()` → `showInputModal('rename-calc-sheet',
//            ...)`. The modal exposes an `#input-modal-input` <input>
//            (Control.UIManager.ts:2295). Type new name + Enter.
//            Assert tab #1's visible label changes.
//
//   Test D — real right-click on tab #1. The jQuery contextMenu
//            (Control.Tabs.js:125 `installContextMenu({selector:
//            '.spreadsheet-tab'})`) populates `.context-menu-item`
//            entries. Find one whose text matches /Rename/i, real-click
//            it, wait for the same rename-input modal, type new name +
//            click the "OK" button (`#response-ok` per
//            Control.UIManager.ts:2287). Assert tab #1's visible label
//            changes again.
//
// 3 deterministic cycles per case, all checks via visible-outcome
// assertions (DOM children, status-bar text, tab textContent). Real
// puppeteer mouse + keyboard throughout. No `sendUnoCommand`, no
// `frame.evaluate(()=>el.click())`, no internal-state mutation.

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('../../lib/test-env');
const { openViaViewer } = require('../../lib/open-via-viewer');

const VIEWER  = env.FILE_STORAGE_URL;
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'testdoc.xlsx');
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-xlsx-sheet-tabs-rename';

const CYCLES = parseInt(process.env.CYCLES || '3', 10);

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

// Bottom-strip closeup so the screenshots clearly document the tab-strip
// state for each failed case (the full-viewport shot makes the tab area
// hard to see).
async function snapBottomStrip(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2, '0')}_${name}_BOT.png`;
    try {
        await page.screenshot({
            path: `${SHOT_DIR}/${f}`,
            clip: { x: 0, y: 700, width: 1280, height: 100 },
        });
    } catch (_) {}
}

// Probe state of the tab strip + status indicator. All reads are pure
// DOM/window reads — we do not call dispatchers or app methods that
// would mutate.
async function probeTabs(frame) {
    return await frame.evaluate(() => {
        const sd = document.querySelector('#StatusDocPos');
        const statusText = (sd && sd.textContent || '').trim();
        const m = /Sheet\s+(\d+)\s+of\s+(\d+)/i.exec(statusText);
        const sheetIdx   = m ? parseInt(m[1], 10) : null;
        const sheetCount = m ? parseInt(m[2], 10) : null;

        const scroll = document.getElementById('spreadsheet-tab-scroll');
        const scrollExists = !!scroll;
        const directChildrenCount = scroll ? scroll.children.length : 0;
        const tabEls = scroll
            ? Array.from(scroll.querySelectorAll('.spreadsheet-tab'))
            : [];
        const tabs = tabEls.map((el) => {
            const r = el.getBoundingClientRect();
            const cs = window.getComputedStyle(el);
            return {
                id: el.id || null,
                text: (el.textContent || '').trim(),
                x: r.x, y: r.y, w: r.width, h: r.height,
                display: cs.display,
                visibility: cs.visibility,
                selected: el.classList.contains('spreadsheet-tab-selected'),
            };
        });
        let visiblePartCount = null;
        let selectedPart = null;
        try {
            if (window.app && window.app.calc
                && typeof window.app.calc.getVisiblePartCount === 'function') {
                visiblePartCount = window.app.calc.getVisiblePartCount();
            }
            if (window.app && window.app.map && window.app.map._docLayer) {
                selectedPart = window.app.map._docLayer._selectedPart;
            }
        } catch (_) {}
        return {
            statusText, sheetIdx, sheetCount,
            scrollExists, directChildrenCount,
            tabs, visiblePartCount, selectedPart,
        };
    });
}

// Real puppeteer click at a tab's centre. Returns the tab text it
// targeted (caller already had the bbox from probeTabs).
async function realClickTab(page, tab, opts) {
    const cx = Math.round(tab.x + tab.w / 2);
    const cy = Math.round(tab.y + tab.h / 2);
    await page.mouse.click(cx, cy, opts || {});
    return { x: cx, y: cy, t: tab.text };
}

// Click the insert-sheet (+) button via real puppeteer mouse on its
// bounding box. We avoid `el.click()` to stay within the
// real-input-only rule.
async function clickInsertSheet(page, frame) {
    const bbox = await frame.evaluate(() => {
        const el = document.getElementById('insertsheet-button');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    if (!bbox || bbox.w === 0) return { ok: false, why: 'no insertsheet button' };
    await page.mouse.click(
        Math.round(bbox.x + bbox.w / 2),
        Math.round(bbox.y + bbox.h / 2));
    return { ok: true };
}

// Click a context-menu item by visible label via real puppeteer mouse.
async function realClickContextMenuItem(page, frame, labelRegex) {
    let bbox = null;
    for (let i = 0; i < 30; i++) {
        bbox = await frame.evaluate((reSrc) => {
            const re = new RegExp(reSrc.source, reSrc.flags);
            const items = Array.from(document.querySelectorAll('.context-menu-item'));
            const found = items.find(el => re.test(el.textContent || ''));
            if (!found) return null;
            const r = found.getBoundingClientRect();
            return { x: r.left, y: r.top, w: r.width, h: r.height,
                     text: (found.textContent || '').trim() };
        }, { source: labelRegex.source, flags: labelRegex.flags });
        if (bbox && bbox.w > 0 && bbox.h > 0) break;
        await sleep(150);
    }
    if (!bbox) return { ok: false, why: 'menu item not found' };
    await page.mouse.click(
        Math.round(bbox.x + bbox.w / 2),
        Math.round(bbox.y + bbox.h / 2));
    return { ok: true, item: bbox.text };
}

// Wait for the rename-calc-sheet input modal to appear; returns the
// bounding rect of the <input> + OK button so the caller can drive both
// via real puppeteer mouse/keys.
async function waitRenameInputModal(frame, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < (timeoutMs || 5000)) {
        const r = await frame.evaluate(() => {
            const inp = document.getElementById('input-modal-input');
            const ok  = document.getElementById('response-ok');
            if (!inp || !ok) return null;
            const ri = inp.getBoundingClientRect();
            const ro = ok.getBoundingClientRect();
            if (ri.width === 0 || ro.width === 0) return null;
            return {
                input: { x: ri.x, y: ri.y, w: ri.width, h: ri.height,
                         value: inp.value || '' },
                ok:    { x: ro.x, y: ro.y, w: ro.width, h: ro.height },
            };
        }).catch(() => null);
        if (r) return r;
        await sleep(150);
    }
    return null;
}

// Helper: ensure ≥ 2 sheets by clicking the "+" button until count goes
// to 2. Robust against the test running on a fixture that already has
// multiple sheets.
async function ensureTwoSheets(page, frame) {
    let st = await probeTabs(frame);
    if ((st.sheetCount || 0) >= 2) return st;
    log(`  inserting sheet via "+" (was ${st.sheetCount})`);
    await clickInsertSheet(page, frame);
    for (let i = 0; i < 30; i++) {
        await sleep(500);
        st = await probeTabs(frame);
        if ((st.sheetCount || 0) >= 2) return st;
    }
    return st;
}

async function openFresh(browser) {
    const bytes = fs.readFileSync(FIXTURE);
    const name = `sheet-tabs-rename-${Date.now()}.xlsx`;
    const { page, editorFrame } = await openViaViewer(browser, VIEWER,
        name, bytes, {
            singleUser: true,
            viewport: { width: 1280, height: 800 },
            gotoTimeout: env.scaleTimeout(120000),
            iframeTimeout: env.scaleTimeout(60000),
        });
    log(`opened ${name}`);

    // Capture pageerror + console lines that signal a crash inside the
    // tab/rename path — these are the smoking-gun lines diagnosed in
    // similar trap families (impress-shape-area memory OOB,
    // writer-shape-color).
    const errLog = [];
    page.on('pageerror', e => {
        const msg = (e.message || '').substring(0, 240);
        if (/WASM_ABORT|memory access|unreachable|Pthread.*error|jserror|RuntimeError/.test(msg)) {
            errLog.push(`[pageerror] ${msg}`);
        }
    });
    page.on('console', m => {
        const t = m.text();
        if (/WASM_ABORT|memory access|unreachable|Pthread.*error|jserror|RuntimeError/.test(t)) {
            errLog.push(`[${m.type()}] ${t.substring(0, 240)}`);
        }
    });

    await editorFrame.waitForFunction(
        () => window.__wasmInitialDocLoaded === true,
        { timeout: env.scaleTimeout(120000) });
    await editorFrame.waitForFunction(
        () => /Sheet\s+\d+\s+of/i.test(
            document.querySelector('#StatusDocPos')?.textContent || ''),
        { timeout: env.scaleTimeout(60000) });
    await sleep(2500);  // let tab strip settle
    return { page, frame: editorFrame, errLog };
}

(async () => {
    log('=== Regression: Calc sheet TABS visibility + click + rename ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(FIXTURE)) {
        log(`SKIP: fixture missing: ${FIXTURE}`);
        process.exit(2);
    }

    const counters = {
        A: { pass: 0, fail: 0 },
        B: { pass: 0, fail: 0 },
        C: { pass: 0, fail: 0 },
        D: { pass: 0, fail: 0 },
    };

    for (let cycle = 1; cycle <= CYCLES; cycle++) {
        log(`\n══════════════════════ CYCLE ${cycle}/${CYCLES} ══════════════════════`);
        const browser = await puppeteer.launch({
            headless: 'new', protocolTimeout: 600000,
            args: ['--no-sandbox', '--ignore-certificate-errors',
                   '--enable-features=SharedArrayBuffer'],
        });
        try {
            const { page, frame, errLog } = await openFresh(browser);
            await snap(page, `c${cycle}_00_loaded`);
            await snapBottomStrip(page, `c${cycle}_00_loaded`);

            // Ensure 2 sheets.
            const st0 = await ensureTwoSheets(page, frame);
            await snap(page, `c${cycle}_01_two_sheets`);
            await snapBottomStrip(page, `c${cycle}_01_two_sheets`);
            log(`  state after ensureTwoSheets: ${JSON.stringify({
                sheetCount: st0.sheetCount, sheetIdx: st0.sheetIdx,
                tabs: st0.tabs.length, visiblePartCount: st0.visiblePartCount,
                scrollExists: st0.scrollExists,
            })}`);

            // ───────── Test A: each sheet has a visible tab ─────────
            const st = await probeTabs(frame);
            log(`  --- Test A: tab visibility ---`);
            const labelA1 = `[A.${cycle}] #spreadsheet-tab-scroll exists`;
            const condA1 = st.scrollExists === true;
            check(labelA1, condA1,
                `directChildren=${st.directChildrenCount}`);
            counters.A[condA1 ? 'pass' : 'fail']++;

            const labelA2 = `[A.${cycle}] tab count === visible part count`;
            const expected = st.visiblePartCount != null
                ? st.visiblePartCount
                : (st.sheetCount || 0);
            const condA2 = st.tabs.length === expected && expected > 0;
            check(labelA2, condA2,
                `tabs=${st.tabs.length} expected=${expected}`);
            counters.A[condA2 ? 'pass' : 'fail']++;

            const labelA3 = `[A.${cycle}] every tab has non-zero rendered width`;
            const zeroWidth = st.tabs.filter(t => t.w <= 0);
            const condA3 = st.tabs.length > 0 && zeroWidth.length === 0;
            check(labelA3, condA3,
                `tabs=${st.tabs.length} zeroWidth=${zeroWidth.length} ` +
                `widths=${JSON.stringify(st.tabs.map(t => Math.round(t.w)))}`);
            counters.A[condA3 ? 'pass' : 'fail']++;

            const labelA4 = `[A.${cycle}] every tab display !== "none"`;
            const hidden = st.tabs.filter(t => t.display === 'none');
            const condA4 = st.tabs.length > 0 && hidden.length === 0;
            check(labelA4, condA4,
                `hidden=${hidden.length}`);
            counters.A[condA4 ? 'pass' : 'fail']++;

            // ───────── Test B: real-click tab #2 activates sheet 2 ─
            log(`  --- Test B: click tab #2 to activate it ---`);
            await snap(page, `c${cycle}_02_pre_clickTab2`);

            // Reset to sheet 1 first using firstrecord-button via real
            // mouse so the test doesn't depend on starting state.
            const fr = await frame.evaluate(() => {
                const el = document.getElementById('firstrecord-button');
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: r.x, y: r.y, w: r.width, h: r.height };
            });
            if (fr && fr.w > 0) {
                await page.mouse.click(
                    Math.round(fr.x + fr.w / 2),
                    Math.round(fr.y + fr.h / 2));
                await sleep(1500);
            }
            const stBeforeB = await probeTabs(frame);
            if (stBeforeB.tabs.length < 2) {
                check(`[B.${cycle}] need ≥2 tabs to test click-activation`,
                    false, `tabs=${stBeforeB.tabs.length}`);
                counters.B.fail++;
                // Still snap the failed bottom-strip so the screenshots
                // show what the user actually sees.
                await snap(page, `c${cycle}_03_B_skipped_no_tabs`);
            } else {
                const tab2 = stBeforeB.tabs[1];
                const clk = await realClickTab(page, tab2);
                log(`  real-clicked tab #2 at (${clk.x},${clk.y}) text="${clk.t}"`);
                await sleep(1500);
                await snap(page, `c${cycle}_03_post_clickTab2`);
                const stAfter = await probeTabs(frame);
                log(`  state after click tab #2: ${JSON.stringify({
                    sheetIdx: stAfter.sheetIdx,
                    selectedPart: stAfter.selectedPart,
                    statusText: stAfter.statusText,
                    selectedTabs: stAfter.tabs
                        .map((t,i) => t.selected ? i : -1).filter(i => i >= 0),
                })}`);

                const condB1 = stAfter.selectedPart === 1;
                check(`[B.${cycle}] _docLayer._selectedPart === 1 after clicking tab #2`,
                    condB1, `selectedPart=${stAfter.selectedPart}`);
                counters.B[condB1 ? 'pass' : 'fail']++;

                const condB2 = stAfter.sheetIdx === 2;
                check(`[B.${cycle}] #StatusDocPos shows "Sheet 2 of N" after click`,
                    condB2, `status="${stAfter.statusText}"`);
                counters.B[condB2 ? 'pass' : 'fail']++;

                const condB3 = stAfter.tabs[1] && stAfter.tabs[1].selected === true;
                check(`[B.${cycle}] tab #2 has 'spreadsheet-tab-selected' class`,
                    condB3, `selectedTabs=${JSON.stringify(
                        stAfter.tabs.map((t,i) => t.selected ? i : -1).filter(i=>i>=0))}`);
                counters.B[condB3 ? 'pass' : 'fail']++;
            }

            // ───────── Test C: double-click tab #1 → rename modal ───
            log(`  --- Test C: double-click tab #1 for inline rename ---`);
            // Reset to a known-good tab strip.
            const stPreC = await probeTabs(frame);
            if (stPreC.tabs.length < 1) {
                check(`[C.${cycle}] need ≥1 tab to test dblclick rename`,
                    false, `tabs=${stPreC.tabs.length}`);
                counters.C.fail++;
                await snap(page, `c${cycle}_05_C_skipped_no_tabs`);
            } else {
                const tab1 = stPreC.tabs[0];
                const originalText = tab1.text;
                log(`  dblclick tab #1 "${originalText}"`);
                await snap(page, `c${cycle}_04_pre_dblclick`);
                await realClickTab(page, tab1, { clickCount: 2 });
                await sleep(1500);
                await snap(page, `c${cycle}_05_post_dblclick`);

                const modal = await waitRenameInputModal(frame,
                    env.scaleTimeout(5000));
                const condC1 = modal !== null;
                check(`[C.${cycle}] rename input modal opens on dblclick`,
                    condC1, modal ? `value="${modal.input.value}"` : 'no modal');
                counters.C[condC1 ? 'pass' : 'fail']++;

                if (modal) {
                    const newName = `Cdbl${cycle}_${Date.now() % 100000}`;
                    // Click into the input via real mouse, select-all,
                    // type new name, Enter.
                    await page.mouse.click(
                        Math.round(modal.input.x + modal.input.w / 2),
                        Math.round(modal.input.y + modal.input.h / 2));
                    await sleep(200);
                    await page.keyboard.down('Control');
                    await page.keyboard.press('a');
                    await page.keyboard.up('Control');
                    await sleep(100);
                    await page.keyboard.press('Delete');
                    await sleep(100);
                    await page.keyboard.type(newName, { delay: 25 });
                    await sleep(200);
                    await snap(page, `c${cycle}_06_typed_newname`);
                    await page.keyboard.press('Enter');
                    await sleep(2500);
                    await snap(page, `c${cycle}_07_post_enter`);

                    const stPostC = await probeTabs(frame);
                    const tab1Post = stPostC.tabs[0];
                    const condC2 = tab1Post && tab1Post.text === newName;
                    check(`[C.${cycle}] tab #1 textContent === "${newName}" after Enter`,
                        condC2, tab1Post ? `text="${tab1Post.text}"` : 'no tab #1');
                    counters.C[condC2 ? 'pass' : 'fail']++;

                    const condC3 = tab1Post && tab1Post.text !== originalText;
                    check(`[C.${cycle}] tab #1 text changed from original "${originalText}"`,
                        condC3, tab1Post ? `text="${tab1Post.text}"` : 'no tab #1');
                    counters.C[condC3 ? 'pass' : 'fail']++;
                } else {
                    // Modal didn't open. Record two failures so each
                    // cycle has the same number of assertions per case.
                    check(`[C.${cycle}] tab #1 textContent changed (skipped — no modal)`,
                        false, 'modal never appeared');
                    counters.C.fail++;
                    check(`[C.${cycle}] tab #1 text differs from original (skipped — no modal)`,
                        false, 'modal never appeared');
                    counters.C.fail++;
                }
            }

            // ───────── Test D: right-click tab #1 → "Rename Sheet…" ─
            log(`  --- Test D: right-click tab #1 → Rename Sheet… ---`);
            const stPreD = await probeTabs(frame);
            if (stPreD.tabs.length < 1) {
                check(`[D.${cycle}] need ≥1 tab to test rightclick rename`,
                    false, `tabs=${stPreD.tabs.length}`);
                counters.D.fail++;
                await snap(page, `c${cycle}_08_D_skipped_no_tabs`);
            } else {
                const tab1 = stPreD.tabs[0];
                const originalText = tab1.text;
                log(`  rightclick tab #1 "${originalText}"`);
                await snap(page, `c${cycle}_08_pre_rightclick`);
                await page.mouse.click(
                    Math.round(tab1.x + tab1.w / 2),
                    Math.round(tab1.y + tab1.h / 2),
                    { button: 'right' });
                // Wait for the menu — Control.Tabs.js wires the
                // contextmenu handler via jQuery.contextMenu so it
                // emits `.context-menu-item` entries (same as
                // canvas right-click).
                let menuOpen = false;
                for (let i = 0; i < 30 && !menuOpen; i++) {
                    menuOpen = await frame.evaluate(() =>
                        document.querySelectorAll('.context-menu-item').length > 0
                    ).catch(() => false);
                    if (!menuOpen) await sleep(150);
                }
                await snap(page, `c${cycle}_09_context_menu`);
                const condD1 = menuOpen === true;
                check(`[D.${cycle}] context menu opens on right-click tab #1`,
                    condD1, menuOpen ? 'yes' : 'no .context-menu-item');
                counters.D[condD1 ? 'pass' : 'fail']++;

                if (!menuOpen) {
                    check(`[D.${cycle}] "Rename Sheet…" item present (skipped)`,
                        false, 'no menu');
                    counters.D.fail++;
                    check(`[D.${cycle}] tab #1 text changed (skipped)`,
                        false, 'no menu');
                    counters.D.fail++;
                } else {
                    // Enumerate items for diagnostic visibility — same
                    // pattern as test-regression-rightclick-copypaste.js.
                    const items = await frame.evaluate(() => {
                        const els = Array.from(
                            document.querySelectorAll('.context-menu-item'));
                        return els.map(el => (el.textContent || '')
                            .replace(/\s+/g, ' ').trim().substring(0, 60));
                    });
                    log(`  context-menu items (${items.length}): ` +
                        `${JSON.stringify(items.slice(0, 16))}`);

                    const click = await realClickContextMenuItem(
                        page, frame, /Rename/i);
                    const condD2 = click.ok === true;
                    check(`[D.${cycle}] "Rename Sheet…" item present + clickable`,
                        condD2, click.item || click.why);
                    counters.D[condD2 ? 'pass' : 'fail']++;

                    if (!condD2) {
                        check(`[D.${cycle}] tab #1 text changed (skipped — no rename item)`,
                            false, click.why);
                        counters.D.fail++;
                    } else {
                        const modal = await waitRenameInputModal(frame,
                            env.scaleTimeout(5000));
                        if (!modal) {
                            check(`[D.${cycle}] rename input modal opens after "Rename Sheet"`,
                                false, 'modal never appeared');
                            counters.D.fail++;
                            check(`[D.${cycle}] tab #1 text changed (skipped — no modal)`,
                                false, 'modal never appeared');
                            counters.D.fail++;
                        } else {
                            check(`[D.${cycle}] rename input modal opens after "Rename Sheet"`,
                                true, `value="${modal.input.value}"`);
                            counters.D.pass++;

                            const newName = `Drmb${cycle}_${Date.now() % 100000}`;
                            await page.mouse.click(
                                Math.round(modal.input.x + modal.input.w / 2),
                                Math.round(modal.input.y + modal.input.h / 2));
                            await sleep(200);
                            await page.keyboard.down('Control');
                            await page.keyboard.press('a');
                            await page.keyboard.up('Control');
                            await sleep(100);
                            await page.keyboard.press('Delete');
                            await sleep(100);
                            await page.keyboard.type(newName, { delay: 25 });
                            await sleep(200);
                            await snap(page, `c${cycle}_10_typed_newname_rmb`);

                            // Real-click the OK button instead of Enter
                            // so we exercise the actual button-callback
                            // path showInputModal wires.
                            await page.mouse.click(
                                Math.round(modal.ok.x + modal.ok.w / 2),
                                Math.round(modal.ok.y + modal.ok.h / 2));
                            await sleep(2500);
                            await snap(page, `c${cycle}_11_post_ok_rmb`);

                            const stPostD = await probeTabs(frame);
                            const tab1Post = stPostD.tabs[0];
                            const condD3 = tab1Post && tab1Post.text === newName;
                            check(`[D.${cycle}] tab #1 textContent === "${newName}" after OK`,
                                condD3, tab1Post ? `text="${tab1Post.text}"` : 'no tab #1');
                            counters.D[condD3 ? 'pass' : 'fail']++;
                        }
                    }
                }
            }

            if (errLog.length) {
                log(`  Captured ${errLog.length} crash-pattern log lines this cycle:`);
                errLog.slice(0, 8).forEach(e => log(`    ! ${e}`));
            }
        } finally {
            await browser.close();
        }
    }

    log('\n────────────────────── RESULTS ──────────────────────');
    for (const k of ['A', 'B', 'C', 'D']) {
        const c = counters[k];
        log(`  Test ${k}: ${c.pass} pass / ${c.fail} fail`);
    }
    log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e.stack || e.message);
    process.exit(2);
});
