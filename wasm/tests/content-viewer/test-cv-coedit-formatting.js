// test-cv-coedit-formatting.js — co-editing FORMATTING convergence through
// the Tresorit content viewer: bold / italic / font-size propagate.
//
// Formatting ops sync via a different path than character insertion (they
// carry attributes over a range) and are a distinct co-editing bug surface:
//   A + B open (co-edit)
//   A types a word; converge (char count)
//   A selects the word, Ctrl+B (bold)      → B's canvas must change (propagated)
//   B selects the word, Ctrl+I (italic)    → A's canvas must change
//   A changes font size via the notebookbar combo → B's canvas must change
//   A saves (tester Save button); C late-joins → C renders the formatted word
//                                            (canvas differs from pristine)
//   no CHECKPOINT MISMATCH / abort anywhere
//
// Propagation signal = same-browser #document-canvas pixel-hash before/after
// the PEER's op (reliable; cursor/overlay-free tile canvas). Visible-UI only.
//
// Migrated from wasm/tests/coedit/test-coedit-formatting.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-coedit-formatting.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const {
    openCoEditPair, openBytesViaContentViewer, joinViaContentViewer,
    waitCvInteractive, cvEditorFrame, cvCharCount,
} = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/coedit-formatting';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const PROP_BUDGET = parseInt(process.env.PROP_BUDGET || '45000', 10);
const VP = { width: 1920, height: 1080 };

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

let shotNum = 0;
async function snap(part, name) {
    if (!part || part.dead) return;
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    try { await part.page.screenshot({ path: `${SHOT_DIR}/${String(++shotNum).padStart(2, '0')}_${part.id}_${name}.png` }); } catch (e) {}
}

const ERR_RE = /CHECKPOINT MISMATCH|memory access out of bounds|RuntimeError|unreachable|Aborted\(|table index is out of bounds|OOB/i;
function wire(part) {
    part.errors = [];
    part.page.on('console', m => { const t = m.text(); if (ERR_RE.test(t)) part.errors.push(t.slice(0, 200)); });
    part.page.on('pageerror', e => { if (ERR_RE.test(e.message)) part.errors.push('pageerror: ' + e.message.slice(0, 200)); });
    return part;
}

async function charCount(part) {
    if (!part || part.dead) return -2;
    return cvCharCount(part.page);
}
async function convergeTo(parts, target, timeoutMs) {
    const live = parts.filter(p => p && !p.dead); const deadline = Date.now() + timeoutMs; let counts = {};
    while (Date.now() < deadline) {
        counts = {}; let all = true;
        for (const p of live) { const c = await charCount(p); counts[p.id] = c; if (c !== target) all = false; }
        if (all) return { ok: true, counts };
        await sleep(500);
    }
    return { ok: false, counts };
}

async function evalFr(part, fn, ...args) {
    const fr = cvEditorFrame(part.page);
    if (!fr) return null;
    return fr.evaluate(fn, ...args).catch(() => null);
}
async function canvasSig(part) {
    if (!part || part.dead) return -2;
    const fr = cvEditorFrame(part.page);
    if (!fr) return -1;
    return fr.evaluate(() => {
        const c = document.querySelector('#document-canvas'); if (!c || !c.width) return -1;
        try {
            const g = c.getContext('2d'); const step = 11; let h = 2166136261; const w = c.width, ht = c.height;
            for (let y = 0; y < ht; y += step) { const row = g.getImageData(0, y, w, 1).data; for (let x = 0; x < row.length; x += step * 4) { h ^= row[x]; h = (h * 16777619) >>> 0; } }
            return h >>> 0;
        } catch (e) { return -3; }
    }).catch(() => -1);
}
async function waitCanvasChanged(part, prev, timeoutMs) {
    const deadline = Date.now() + timeoutMs; let cur = prev;
    while (Date.now() < deadline) { cur = await canvasSig(part); if (cur > 0 && cur !== prev) return { changed: true, sig: cur }; await sleep(500); }
    return { changed: false, sig: cur };
}

async function typeWord(part, w) {
    await part.page.bringToFront().catch(() => {});
    await part.page.mouse.click(640, 380); await sleep(300);
    await part.page.keyboard.down('Control'); await part.page.keyboard.press('End'); await part.page.keyboard.up('Control'); await sleep(200);
    await part.page.keyboard.type(' ' + w, { delay: 30 }); await sleep(1200);
}
// select the last-typed word: go to end, then Shift+Ctrl+Left selects one word
async function selectLastWord(part) {
    await part.page.bringToFront().catch(() => {});
    await part.page.mouse.click(640, 380); await sleep(200);
    await part.page.keyboard.down('Control'); await part.page.keyboard.press('End'); await part.page.keyboard.up('Control'); await sleep(200);
    await part.page.keyboard.down('Control'); await part.page.keyboard.down('Shift');
    await part.page.keyboard.press('ArrowLeft');
    await part.page.keyboard.up('Shift'); await part.page.keyboard.up('Control'); await sleep(400);
}
async function key(part, mods, k) {
    for (const m of mods) await part.page.keyboard.down(m);
    await part.page.keyboard.press(k);
    for (const m of mods.slice().reverse()) await part.page.keyboard.up(m);
    await sleep(1200);
}

// Change font size via the notebookbar font-size combo (visible UI):
// click the combo, clear, type a size, Enter. Returns true if the combo
// was found + interacted.
async function setFontSize(part, size) {
    const page = part.page;
    await page.bringToFront().catch(() => {});
    // ensure Home ribbon
    const ifr = await page.evaluate(() => { const f = document.querySelector('iframe'); const r = f.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top) }; });
    for (let i = 0; i < 10; i++) {
        const tab = await evalFr(part, () => { const e = document.querySelector('#Home-tab-label'); if (!e || !e.offsetParent) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
        if (tab && tab.w) { await page.mouse.click(tab.x + tab.w / 2 + ifr.left, tab.y + tab.h / 2 + ifr.top); await sleep(400); }
        // The size field is a real <input> in the combo (probe: id
        // #fontsizecombobox-input-notebookbar). Click it, select-all, type,
        // Enter — applies to the current selection.
        const box = await evalFr(part, () => {
            const e = document.querySelector('#fontsizecombobox-input-notebookbar')
                   || document.querySelector('#fontsizecombobox input.ui-combobox-content')
                   || document.querySelector('#fontsizecombobox input');
            if (!e) return null; const r = e.getBoundingClientRect();
            return r.width > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
        });
        if (box) {
            await page.mouse.click(box.x + box.w / 2 + ifr.left, box.y + box.h / 2 + ifr.top); await sleep(400);
            await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
            await page.keyboard.type(String(size), { delay: 50 });
            await page.keyboard.press('Enter'); await sleep(1800);
            return true;
        }
        await sleep(500);
    }
    return false;
}

// Tester Save button — rotates the relay checkpoint in a co-edit room.
async function clickSave(page) {
    const h = await page.evaluateHandle(() =>
        [...document.querySelectorAll('button')].find(b => /^save$/i.test((b.textContent || '').trim())));
    const el = h.asElement();
    if (!el) return false;
    await el.click();
    return true;
}

async function joinPart(browser, joinLink, id, userName) {
    log(`--- ${id} joining (co-edit) ---`);
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await joinViaContentViewer(browser, joinLink, { page, userName, viewport: VP, iframeTimeout: 90000 });
    const part = wire({ id, page, context, dead: false });
    check(`${id}: editor interactive`, await waitCvInteractive(page, LOAD_BUDGET));
    await sleep(6000);
    return part;
}

(async () => {
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
    log('=== CV co-editing FORMATTING convergence ===');
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    const parts = {};
    try {
        const bytes = fs.readFileSync(FIXTURE);
        const NAME = 'cv-coedit-fmt-' + Date.now() + '.docx';
        const pair = await openCoEditPair(browser, BASE, NAME, bytes, {
            userA: 'Alice Fmt', userB: 'Bob Fmt', viewport: VP,
            loadBudgetMs: LOAD_BUDGET, iframeTimeout: 60000,
        });
        const A = parts.A = wire({ id: 'A', page: pair.A.page, context: null, dead: false });
        const B = parts.B = wire({ id: 'B', page: pair.B.page, context: pair.contextB, dead: false });
        await sleep(6000);

        // A types a word, converge
        log('--- A types a word ---');
        await typeWord(A, 'Formatting');
        const t1 = await charCount(A);
        let cr = await convergeTo([A, B], t1, PROP_BUDGET);
        check('typed word converges A→B', cr.ok, JSON.stringify(cr.counts));

        // A bolds the word → B canvas changes
        log('--- A bolds the word ---');
        const bBefore = await canvasSig(B);
        await selectLastWord(A); await key(A, ['Control'], 'KeyB');
        await A.page.keyboard.press('Escape');
        const bChg = await waitCanvasChanged(B, bBefore, PROP_BUDGET);
        await snap(A, 'A_bold'); await snap(B, 'B_sees_bold');
        check('bold in A propagates to B (canvas changed)', bChg.changed, `Bsig ${bBefore}->${bChg.sig}`);

        // B italicizes the word → A canvas changes
        log('--- B italicizes the word ---');
        const aBefore = await canvasSig(A);
        await selectLastWord(B); await key(B, ['Control'], 'KeyI');
        await B.page.keyboard.press('Escape');
        const aChg = await waitCanvasChanged(A, aBefore, PROP_BUDGET);
        await snap(B, 'B_italic'); await snap(A, 'A_sees_italic');
        check('italic in B propagates to A (canvas changed)', aChg.changed, `Asig ${aBefore}->${aChg.sig}`);

        // A changes font size → B canvas changes
        log('--- A changes font size to 36 ---');
        const bBefore2 = await canvasSig(B);
        await selectLastWord(A);
        const fsOk = await setFontSize(A, 36);
        await A.page.keyboard.press('Escape');
        check('A: font-size combo reachable at 1920 viewport', fsOk);
        if (fsOk) {
            const bChg2 = await waitCanvasChanged(B, bBefore2, PROP_BUDGET);
            await snap(A, 'A_fontsize'); await snap(B, 'B_sees_fontsize');
            check('font-size change in A propagates to B (canvas changed)', bChg2.changed, `Bsig ${bBefore2}->${bChg2.sig}`);
        }

        // save (tester Save button), C late-joins → must render formatted word (differs from pristine)
        log('--- A saves (tester Save button); C late-joins ---');
        check('A: tester Save button clicked', await clickSave(A.page));
        await sleep(6000);
        const C = parts.C = await joinPart(browser, pair.joinLink, 'C', 'Cara Fmt'); await sleep(3000);
        const cSig = await canvasSig(C);
        const refCtx = await browser.createBrowserContext();
        const refPage = await refCtx.newPage();
        await openBytesViaContentViewer(browser, BASE, 'cv-coedit-fmt-ref-' + Date.now() + '.docx', bytes,
            { page: refPage, viewport: VP, iframeTimeout: 60000 });
        const REF = parts.REF = wire({ id: 'REF', page: refPage, context: refCtx, dead: false });
        await waitCvInteractive(refPage, LOAD_BUDGET); await sleep(4000);
        const refSig = await canvasSig(REF);
        await snap(C, 'C_late');
        check('C late-join renders the formatted content (differs from pristine)', cSig > 0 && refSig > 0 && cSig !== refSig, `Csig=${cSig} refSig=${refSig}`);

        for (const id of Object.keys(parts)) {
            const p = parts[id];
            check(`${id}: no checkpoint-mismatch / abort / OOB`, p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
        }
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        for (const id of Object.keys(parts)) { const p = parts[id]; if (p && !p.dead && p.context) { try { await p.context.close(); } catch (e) {} } }
        try { await browser.close(); } catch (e) {}
    }
    log('\n' + (allPassed ? 'ALL PASS' : 'SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
