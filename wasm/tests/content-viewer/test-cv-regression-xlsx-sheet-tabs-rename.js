// test-cv-regression-xlsx-sheet-tabs-rename.js — Calc sheet TAB strip in the
// content viewer: visibility, click-to-activate, double-click rename,
// right-click → "Rename Sheet…" rename.
//
//   Test A — each sheet has a visible, non-zero-width tab
//            (#spreadsheet-tab-scroll children vs. visible part count).
//   Test B — real page.mouse.click on tab #2 → _selectedPart === 1 AND
//            #StatusDocPos flips to "Sheet 2 of N" AND tab #2 gets the
//            'spreadsheet-tab-selected' class.
//   Test C — real double-click on tab #1 → rename input modal
//            (#input-modal-input) → type new name + Enter → tab label changes.
//   Test D — real right-click on tab #1 → context menu → "Rename Sheet…" →
//            same modal → type new name + click OK → tab label changes.
//
// 3 deterministic cycles (fresh content-viewer open per cycle), all checks
// via visible-outcome assertions. Real puppeteer mouse + keyboard throughout.
//
// Migrated from wasm/tests/regression/test-regression-xlsx-sheet-tabs-rename.js
// — legacy version retired.
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, waitCvInteractive, cvEditorFrame } =
    require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'testdoc.xlsx');
const SHOT_DIR = '/tmp/content-viewer-report/regression-xlsx-sheet-tabs-rename';
const CYCLES = parseInt(process.env.CYCLES || '3', 10);
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

// Bottom-strip closeup so screenshots clearly document the tab-strip state.
async function snapBottomStrip(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2, '0')}_${name}_BOT.png`;
    try {
        await page.screenshot({
            path: `${SHOT_DIR}/${f}`,
            clip: { x: 0, y: 700, width: 1280, height: 200 },
        });
    } catch (_) {}
}

// Probe state of the tab strip + status indicator. Pure DOM/window reads.
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

// Real puppeteer click at a tab's centre (+ tester-page iframe offset).
async function realClickTab(page, tab, ifr, opts) {
    const cx = Math.round(tab.x + tab.w / 2) + ifr.left;
    const cy = Math.round(tab.y + tab.h / 2) + ifr.top;
    await page.mouse.click(cx, cy, opts || {});
    return { x: cx, y: cy, t: tab.text };
}

// Click the insert-sheet (+) button via real puppeteer mouse.
async function clickInsertSheet(page, frame, ifr) {
    const bbox = await frame.evaluate(() => {
        const el = document.getElementById('insertsheet-button');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    if (!bbox || bbox.w === 0) return { ok: false, why: 'no insertsheet button' };
    await page.mouse.click(
        Math.round(bbox.x + bbox.w / 2) + ifr.left,
        Math.round(bbox.y + bbox.h / 2) + ifr.top);
    return { ok: true };
}

// Click a context-menu item by visible label via real puppeteer mouse.
async function realClickContextMenuItem(page, frame, labelRegex, ifr) {
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
        Math.round(bbox.x + bbox.w / 2) + ifr.left,
        Math.round(bbox.y + bbox.h / 2) + ifr.top);
    return { ok: true, item: bbox.text };
}

// Wait for the rename-calc-sheet input modal; returns bounding rects of the
// <input> + OK button (iframe coords — caller adds the offset).
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

// Ensure ≥ 2 sheets by clicking "+" until count reaches 2.
async function ensureTwoSheets(page, frame, ifr) {
    let st = await probeTabs(frame);
    if ((st.sheetCount || 0) >= 2) return st;
    log(`  inserting sheet via "+" (was ${st.sheetCount})`);
    await clickInsertSheet(page, frame, ifr);
    for (let i = 0; i < 30; i++) {
        await sleep(500);
        st = await probeTabs(frame);
        if ((st.sheetCount || 0) >= 2) return st;
    }
    return st;
}

// Fresh content-viewer open of the fixture. Returns { page, frame, ifr, errLog }.
async function openFresh(browser) {
    const page = await browser.newPage();

    // Capture pageerror + console lines that signal a crash inside the
    // tab/rename path.
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

    await openViaContentViewer(browser, BASE, FIXTURE,
        { page, viewport: { width: 1280, height: 900 }, iframeTimeout: 60000 });
    if (!(await waitCvInteractive(page, LOAD_BUDGET)))
        throw new Error('doc never became interactive in content viewer');
    const frame = cvEditorFrame(page);
    if (!frame) throw new Error('editor frame never loaded');
    await frame.waitForFunction(
        () => /Sheet\s+\d+\s+of/i.test(
            document.querySelector('#StatusDocPos')?.textContent || ''),
        { timeout: 60000 });
    await sleep(2500);  // let tab strip settle

    const ifr = await page.evaluate(() => {
        const f = document.querySelector('iframe');
        if (!f) return null;
        const r = f.getBoundingClientRect();
        return { left: Math.round(r.left), top: Math.round(r.top) };
    });
    if (!ifr) throw new Error('editor iframe missing');
    log(`opened fresh content-viewer doc (iframe offset ${ifr.left},${ifr.top})`);
    return { page, frame, ifr, errLog };
}

(async () => {
    log('=== CV Regression: Calc sheet TABS visibility + click + rename ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(FIXTURE)) {
        log(`SKIP: fixture missing: ${FIXTURE}`);
        process.exit(2);
    }
    log('viewer: ' + BASE);

    const counters = {
        A: { pass: 0, fail: 0 },
        B: { pass: 0, fail: 0 },
        C: { pass: 0, fail: 0 },
        D: { pass: 0, fail: 0 },
    };

    const { browser } = await launch({ headless: 'new' });
    try {
        for (let cycle = 1; cycle <= CYCLES; cycle++) {
            log(`\n══════════════════════ CYCLE ${cycle}/${CYCLES} ══════════════════════`);
            let page = null;
            try {
                const opened = await openFresh(browser);
                page = opened.page;
                const { frame, ifr, errLog } = opened;
                await snap(page, `c${cycle}_00_loaded`);
                await snapBottomStrip(page, `c${cycle}_00_loaded`);

                // Ensure 2 sheets.
                const st0 = await ensureTwoSheets(page, frame, ifr);
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
                const condA1 = st.scrollExists === true;
                check(`[A.${cycle}] #spreadsheet-tab-scroll exists`, condA1,
                    `directChildren=${st.directChildrenCount}`);
                counters.A[condA1 ? 'pass' : 'fail']++;

                const expected = st.visiblePartCount != null
                    ? st.visiblePartCount
                    : (st.sheetCount || 0);
                const condA2 = st.tabs.length === expected && expected > 0;
                check(`[A.${cycle}] tab count === visible part count`, condA2,
                    `tabs=${st.tabs.length} expected=${expected}`);
                counters.A[condA2 ? 'pass' : 'fail']++;

                const zeroWidth = st.tabs.filter(t => t.w <= 0);
                const condA3 = st.tabs.length > 0 && zeroWidth.length === 0;
                check(`[A.${cycle}] every tab has non-zero rendered width`, condA3,
                    `tabs=${st.tabs.length} zeroWidth=${zeroWidth.length} ` +
                    `widths=${JSON.stringify(st.tabs.map(t => Math.round(t.w)))}`);
                counters.A[condA3 ? 'pass' : 'fail']++;

                const hidden = st.tabs.filter(t => t.display === 'none');
                const condA4 = st.tabs.length > 0 && hidden.length === 0;
                check(`[A.${cycle}] every tab display !== "none"`, condA4,
                    `hidden=${hidden.length}`);
                counters.A[condA4 ? 'pass' : 'fail']++;

                // ───────── Test B: real-click tab #2 activates sheet 2 ─
                log(`  --- Test B: click tab #2 to activate it ---`);
                await snap(page, `c${cycle}_02_pre_clickTab2`);

                // Reset to sheet 1 first using firstrecord-button via real mouse.
                const fr = await frame.evaluate(() => {
                    const el = document.getElementById('firstrecord-button');
                    if (!el) return null;
                    const r = el.getBoundingClientRect();
                    return { x: r.x, y: r.y, w: r.width, h: r.height };
                });
                if (fr && fr.w > 0) {
                    await page.mouse.click(
                        Math.round(fr.x + fr.w / 2) + ifr.left,
                        Math.round(fr.y + fr.h / 2) + ifr.top);
                    await sleep(1500);
                }
                const stBeforeB = await probeTabs(frame);
                if (stBeforeB.tabs.length < 2) {
                    check(`[B.${cycle}] need ≥2 tabs to test click-activation`,
                        false, `tabs=${stBeforeB.tabs.length}`);
                    counters.B.fail++;
                    await snap(page, `c${cycle}_03_B_skipped_no_tabs`);
                } else {
                    const tab2 = stBeforeB.tabs[1];
                    const clk = await realClickTab(page, tab2, ifr);
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
                    await realClickTab(page, tab1, ifr, { clickCount: 2 });
                    await sleep(1500);
                    await snap(page, `c${cycle}_05_post_dblclick`);

                    const modal = await waitRenameInputModal(frame, 8000);
                    const condC1 = modal !== null;
                    check(`[C.${cycle}] rename input modal opens on dblclick`,
                        condC1, modal ? `value="${modal.input.value}"` : 'no modal');
                    counters.C[condC1 ? 'pass' : 'fail']++;

                    if (modal) {
                        const newName = `Cdbl${cycle}_${Date.now() % 100000}`;
                        await page.mouse.click(
                            Math.round(modal.input.x + modal.input.w / 2) + ifr.left,
                            Math.round(modal.input.y + modal.input.h / 2) + ifr.top);
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
                        Math.round(tab1.x + tab1.w / 2) + ifr.left,
                        Math.round(tab1.y + tab1.h / 2) + ifr.top,
                        { button: 'right' });
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
                        const items = await frame.evaluate(() => {
                            const els = Array.from(
                                document.querySelectorAll('.context-menu-item'));
                            return els.map(el => (el.textContent || '')
                                .replace(/\s+/g, ' ').trim().substring(0, 60));
                        });
                        log(`  context-menu items (${items.length}): ` +
                            `${JSON.stringify(items.slice(0, 16))}`);

                        const click = await realClickContextMenuItem(
                            page, frame, /Rename/i, ifr);
                        const condD2 = click.ok === true;
                        check(`[D.${cycle}] "Rename Sheet…" item present + clickable`,
                            condD2, click.item || click.why);
                        counters.D[condD2 ? 'pass' : 'fail']++;

                        if (!condD2) {
                            check(`[D.${cycle}] tab #1 text changed (skipped — no rename item)`,
                                false, click.why);
                            counters.D.fail++;
                        } else {
                            const modal = await waitRenameInputModal(frame, 8000);
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
                                    Math.round(modal.input.x + modal.input.w / 2) + ifr.left,
                                    Math.round(modal.input.y + modal.input.h / 2) + ifr.top);
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

                                // Real-click the OK button (exercises the actual
                                // button-callback path showInputModal wires).
                                await page.mouse.click(
                                    Math.round(modal.ok.x + modal.ok.w / 2) + ifr.left,
                                    Math.round(modal.ok.y + modal.ok.h / 2) + ifr.top);
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
                try { if (page) await page.close(); } catch (_) {}
            }
        }
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 200));
    } finally {
        try { await browser.close(); } catch (_) {}
    }

    log('\n────────────────────── RESULTS ──────────────────────');
    for (const k of ['A', 'B', 'C', 'D']) {
        const c = counters[k];
        log(`  Test ${k}: ${c.pass} pass / ${c.fail} fail`);
    }
    log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
