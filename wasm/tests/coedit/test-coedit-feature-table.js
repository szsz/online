const __cl = require('../../lib/inject-checklist');
// Co-editing feature convergence: INSERT TABLE propagation + late-join.
//
// Tables are a structural mutation (nested cell content, row/column model)
// and a distinct co-editing bug surface from drawing shapes. This test:
//   A + B open (co-edit)
//   A inserts a 3x3 table via Insert ribbon → grid picker → B's canvas changes
//   B inserts a 2x2 table                                 → A's canvas changes
//   A saves; C late-joins                                 → C renders both tables
//   no CHECKPOINT MISMATCH / abort anywhere
//
// Visible-UI only (Insert tab → Table button → grid cell). Propagation
// signal = same-browser #document-canvas pixel-hash before/after the PEER's
// op (cursor/overlay-free tile canvas).

'use strict';

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { openViaViewer, openSecretInBrowser } = require('../../lib/open-via-viewer');
const { waitInFrame, evalInFrame } = require('../../lib/two-tab');

const VIEWER = env.FILE_STORAGE_URL;
const LOAD_TIMEOUT = env.scaleTimeout(120000);
const PROP_TIMEOUT = env.scaleTimeout(30000);
const VP = { width: 1920, height: 1080 };
const SHOT_DIR = '/tmp/static-deploy/public/shots-coedit-feature-table';
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

let shotNum = 0;
async function snap(part, name) {
    if (!part || part.dead) return;
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    try { await part.page.screenshot({ path: `${SHOT_DIR}/${String(++shotNum).padStart(2,'0')}_${part.id}_${name}.png` }); } catch (e) {}
}

const ERR_RE = /CHECKPOINT MISMATCH|memory access out of bounds|RuntimeError|unreachable|Aborted\(|table index is out of bounds|OOB/i;
function wire(part) {
    part.errors = [];
    part.page.on('console', m => { const t = m.text(); if (ERR_RE.test(t)) part.errors.push(t.slice(0, 200)); });
    part.page.on('pageerror', e => { if (ERR_RE.test(e.message)) part.errors.push('pageerror: ' + e.message.slice(0, 200)); });
    return part;
}

async function canvasSig(part) {
    if (!part || part.dead) return -2;
    return evalInFrame(part.page, () => {
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

async function ifrOffset(page) {
    return page.evaluate(() => { const f = document.querySelector('iframe'); const r = f.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top) }; });
}

// Insert a rows×cols table via Insert ribbon → Table button → grid picker.
async function insertTable(part, rows, cols) {
    const page = part.page;
    await page.bringToFront().catch(() => {});
    await page.mouse.click(640, 380); await sleep(400);
    const ifr = await ifrOffset(page);
    // activate Insert ribbon + find the Table button
    let btn = null;
    for (let i = 0; i < 15 && !btn; i++) {
        const tab = await evalInFrame(page, () => { const e = document.querySelector('#Insert-tab-label'); if (!e || !e.offsetParent) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }).catch(() => null);
        if (tab && tab.w) await page.mouse.click(tab.x + tab.w / 2 + ifr.left, tab.y + tab.h / 2 + ifr.top);
        await sleep(400);
        btn = await evalInFrame(page, () => {
            const e = document.querySelector('[id^="insert-insert-table"][id$="-button"]') || document.querySelector('[id^="insert-insert-table"]:not([id$="-button"])');
            if (!e || !e.offsetParent) return null; const r = e.getBoundingClientRect(); return r.width > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
        }).catch(() => null);
    }
    if (!btn) return false;
    await page.mouse.click(btn.x + btn.w / 2 + ifr.left, btn.y + btn.h / 2 + ifr.top);
    await sleep(1500);
    // grid picker: .inserttable-grid > .row(10) > cell(10). Click cell (rows,cols).
    const cell = await evalInFrame(page, (r, c) => {
        const grid = document.querySelector('.inserttable-grid'); if (!grid) return null;
        const row = grid.children[r - 1]; if (!row) return null;
        const cel = row.children[c - 1]; if (!cel) return null;
        const rect = cel.getBoundingClientRect();
        return rect.width > 0 ? { x: rect.left, y: rect.top, w: rect.width, h: rect.height } : null;
    }, rows, cols).catch(() => null);
    if (!cell) return false;
    // hover to size the selection, then click to insert
    await page.mouse.move(cell.x + cell.w / 2 + ifr.left, cell.y + cell.h / 2 + ifr.top); await sleep(400);
    await page.mouse.click(cell.x + cell.w / 2 + ifr.left, cell.y + cell.h / 2 + ifr.top); await sleep(3000);
    await page.keyboard.press('Escape'); await sleep(1500);
    return true;
}

async function joinPart(browser, id, secret) {
    log(`--- ${id} joining (co-edit) ---`);
    const up = await openSecretInBrowser(browser, VIEWER, secret, {
        iframeTimeout: LOAD_TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
        isolatedContext: true, coEditing: true, viewport: VP,
    });
    const part = wire({ id, page: up.page, context: up.context, dead: false });
    await waitInFrame(part.page, () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''), { timeout: LOAD_TIMEOUT });
    await sleep(6000);
    return part;
}

(async () => {
    log('=== Co-editing INSERT TABLE convergence + late-join ===');
    const { browser } = await launch({ headless: 'new' });
    const parts = {};
    try {
        const bytes = fs.readFileSync(FIXTURE);
        const upA = await openViaViewer(browser, VIEWER, 'coedit-table-' + Date.now() + '.docx', bytes, {
            iframeTimeout: LOAD_TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
            isolatedContext: true, coEditing: true, viewport: VP,
        });
        const A = parts.A = wire({ id: 'A', page: upA.page, context: upA.context, dead: false });
        const secret = upA.b64urlSecret;
        await waitInFrame(A.page, () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''), { timeout: LOAD_TIMEOUT });
        await sleep(6000);
        const B = parts.B = await joinPart(browser, 'B', secret);
        check('A + B both open', true);

        // A inserts a 3x3 table → B canvas changes
        log('--- A inserts a 3x3 table ---');
        const bBefore = await canvasSig(B);
        const okA = await insertTable(A, 3, 3);
        check('A: Insert ribbon → 3x3 table inserted', okA);
        await snap(A, 'A_table');
        const bChanged = await waitCanvasChanged(B, bBefore, PROP_TIMEOUT);
        await snap(B, 'B_sees_A_table');
        check('B renders the table A inserted (canvas changed)', bChanged.changed, `Bsig ${bBefore}->${bChanged.sig}`);

        // B inserts a 2x2 table → A canvas changes
        log('--- B inserts a 2x2 table ---');
        const aBefore = await canvasSig(A);
        const okB = await insertTable(B, 2, 2);
        check('B: Insert ribbon → 2x2 table inserted', okB);
        await snap(B, 'B_table');
        const aChanged = await waitCanvasChanged(A, aBefore, PROP_TIMEOUT);
        await snap(A, 'A_sees_B_table');
        check('A renders the table B inserted (canvas changed)', aChanged.changed, `Asig ${aBefore}->${aChanged.sig}`);

        // save + late join C → must render both tables
        log('--- A saves; C late-joins ---');
        await A.page.bringToFront().catch(() => {});
        await A.page.keyboard.down('Control'); await A.page.keyboard.press('KeyS'); await A.page.keyboard.up('Control'); await sleep(6000);
        const C = parts.C = await joinPart(browser, 'C', secret); await sleep(3000);
        const cSig = await canvasSig(C);
        const refUp = await openViaViewer(browser, VIEWER, 'coedit-table-ref-' + Date.now() + '.docx', bytes, {
            iframeTimeout: LOAD_TIMEOUT, gotoTimeout: env.scaleTimeout(60000), isolatedContext: true, coEditing: false, viewport: VP,
        });
        const REF = parts.REF = wire({ id: 'REF', page: refUp.page, context: refUp.context, dead: false });
        await waitInFrame(REF.page, () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''), { timeout: LOAD_TIMEOUT }); await sleep(4000);
        const refSig = await canvasSig(REF);
        await snap(C, 'C_late');
        check('C late-join renders the tables (canvas differs from pristine)', cSig > 0 && refSig > 0 && cSig !== refSig, `Csig=${cSig} refSig=${refSig}`);

        for (const id of Object.keys(parts)) {
            const p = parts[id];
            check(`${id}: no checkpoint-mismatch / abort / OOB`, p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
        }
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        for (const id of Object.keys(parts)) { const p = parts[id]; if (p && !p.dead) { try { await p.context.close(); } catch (e) {} } }
        try { await browser.close(); } catch (e) {}
    }
    log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
