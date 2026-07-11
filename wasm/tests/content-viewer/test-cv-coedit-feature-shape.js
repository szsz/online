// test-cv-coedit-feature-shape.js — INSERT SHAPE propagation + churn through
// the Tresorit content viewer. Structural/drawing ops are the classic
// co-editing divergence source (a drawing object inserted in A must appear
// in B and vice-versa). This test:
//   A + B open (co-edit pair)
//   A inserts a rectangle via the Insert ribbon → B's canvas must change
//   B inserts a rectangle                       → A's canvas must change
//   A saves (tester Save button → checkpoint rotate); C late-joins
//                                               → C must render BOTH shapes
//   no CHECKPOINT MISMATCH / abort anywhere
//
// All driven through visible UI (Insert tab → Shapes → rectangle tile →
// drag on canvas). Convergence signal: the editor canvas SIGNATURE (a
// sampled pixel hash of #document-canvas) — a peer that received the remote
// shape has a different canvas than before the peer's op.
//
// Coordinate note: in the content viewer the tester toolbar sits above the
// editor iframe, so every frame-local coordinate is mapped through the
// iframe's bounding-box origin before mouse use.
//
// Migrated from wasm/tests/coedit/test-coedit-feature-shape.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-coedit-feature-shape.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const {
    openCoEditPair, openBytesViaContentViewer, joinViaContentViewer,
    waitCvInteractive, cvEditorFrame,
} = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/coedit-feature-shape';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const PROP_BUDGET = parseInt(process.env.PROP_BUDGET || '60000', 10);
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

// frame-local coords + iframe origin = page coords
async function frameOrigin(page) {
    const el = await page.$('iframe');
    const box = el && await el.boundingBox();
    if (!box) throw new Error('no editor iframe on page');
    return { x: box.x, y: box.y };
}
async function clickFramePt(page, fx, fy, opts) {
    const o = await frameOrigin(page);
    await page.mouse.click(o.x + fx, o.y + fy, opts || {});
}
async function inFrame(part, fn, ...args) {
    const fr = cvEditorFrame(part.page);
    if (!fr) return null;
    return fr.evaluate(fn, ...args).catch(() => null);
}

// Sampled pixel hash of the editor canvas — a cheap, robust "did the
// rendered document change" signal (same-browser pre/post comparison).
async function canvasSig(part) {
    if (!part || part.dead) return -2;
    const r = await inFrame(part, () => {
        const c = document.querySelector('#document-canvas');
        if (!c || !c.width) return -1;
        try {
            const g = c.getContext('2d');
            const step = 17;
            let h = 2166136261;
            const w = c.width, ht = c.height;
            for (let y = 0; y < ht; y += step) {
                const row = g.getImageData(0, y, w, 1).data;
                for (let x = 0; x < row.length; x += step * 4) {
                    h ^= row[x]; h = (h * 16777619) >>> 0;
                }
            }
            return h >>> 0;
        } catch (e) { return -3; }
    });
    return r === null ? -1 : r;
}

// Wait until part's canvas sig differs from `prev` (something rendered).
async function waitCanvasChanged(part, prev, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let cur = prev;
    while (Date.now() < deadline) {
        cur = await canvasSig(part);
        if (cur > 0 && cur !== prev) return { changed: true, sig: cur };
        await sleep(500);
    }
    return { changed: false, sig: cur };
}

async function insertRectangle(part) {
    const page = part.page;
    await page.bringToFront().catch(() => {});
    // click into the body first
    await clickFramePt(page, 640, 380); await sleep(400);
    // activate Insert ribbon (re-click until the Shapes button is visible)
    let shapesBox = null;
    for (let i = 0; i < 20 && !shapesBox; i++) {
        const tab = await inFrame(part, () => {
            const e = document.querySelector('#Insert-tab-label');
            if (!e || !e.offsetParent) return null;
            const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height };
        });
        if (tab && tab.w) await clickFramePt(page, tab.x + tab.w / 2, tab.y + tab.h / 2);
        await sleep(400);
        shapesBox = await inFrame(part, () => {
            for (const s of ['[id^="insert-insert-shapes"][id$="-button"]', '[id^="insert-insert-shapes"]:not([id$="-button"])']) {
                const e = document.querySelector(s);
                if (e && e.offsetParent) { const r = e.getBoundingClientRect(); if (r.width > 0) return { x: r.left, y: r.top, w: r.width, h: r.height }; }
            }
            return null;
        });
    }
    if (!shapesBox) return false;
    await clickFramePt(page, shapesBox.x + shapesBox.w / 2, shapesBox.y + shapesBox.h / 2);
    await sleep(800);
    const tile = await inFrame(part, () => {
        const g = document.querySelector('.insertshape-grid'); if (!g) return null;
        const t = Array.from(g.querySelectorAll('.col')).find(x => (x.dataset.uno || '') === 'BasicShapes.rectangle');
        if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    if (!tile) return false;
    await clickFramePt(page, tile.x + tile.w / 2, tile.y + tile.h / 2);
    await sleep(600);
    // drag a rectangle on the canvas (frame coords → page coords)
    const o = await frameOrigin(page);
    const base = { x: o.x + 500, y: o.y + 430 };
    await page.mouse.move(base.x, base.y); await page.mouse.down();
    await page.mouse.move(base.x + 180, base.y + 120, { steps: 8 }); await page.mouse.up();
    await sleep(2500);
    // Escape to deselect (so the shape's selection handles don't pollute the
    // peer-propagation signal via our own selection overlay)
    await page.keyboard.press('Escape'); await sleep(1500);
    return true;
}

async function clickSave(page) {
    const h = await page.evaluateHandle(() =>
        [...document.querySelectorAll('button')].find(b => /^save$/i.test((b.textContent || '').trim())));
    const el = h.asElement();
    if (!el) return false;
    await el.click();
    return true;
}

async function joinPart(browser, joinLink, id, userName) {
    log(`--- ${id} joining (co-edit link) ---`);
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await joinViaContentViewer(browser, joinLink, { page, userName, viewport: VP, iframeTimeout: 90000 });
    const part = wire({ id, page, context, dead: false });
    check(`${id}: joined + editor interactive`, await waitCvInteractive(page, LOAD_BUDGET));
    await sleep(6000);
    return part;
}

(async () => {
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
    log('=== CV co-editing INSERT SHAPE convergence + churn ===');
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    const parts = {};
    try {
        const bytes = fs.readFileSync(FIXTURE);
        const NAME = 'cv-coedit-shape-' + Date.now() + '.docx';

        const pair = await openCoEditPair(browser, BASE, NAME, bytes, {
            userA: 'Alice Shape', userB: 'Bob Shape', viewport: VP,
        });
        const A = parts.A = wire({ id: 'A', page: pair.A.page, context: null, dead: false });
        const B = parts.B = wire({ id: 'B', page: pair.B.page, context: pair.contextB, dead: false });
        await sleep(6000);
        check('A + B both open', !!pair.A.editorFrame && !!pair.B.editorFrame);

        // ── A inserts a rectangle → B must render it ──
        log('--- A inserts rectangle ---');
        const bSigBefore = await canvasSig(B);
        const okA = await insertRectangle(A);
        check('A: Insert ribbon → rectangle drawn', okA);
        await snap(A, 'A_shape');
        const bChanged = await waitCanvasChanged(B, bSigBefore, PROP_BUDGET);
        await snap(B, 'B_sees_A_shape');
        check('B renders the shape A inserted (canvas changed)', bChanged.changed,
            `Bsig ${bSigBefore}->${bChanged.sig}`);

        // ── B inserts a rectangle → A must render it ──
        log('--- B inserts rectangle ---');
        const aSigBefore = await canvasSig(A);
        const okB = await insertRectangle(B);
        check('B: Insert ribbon → rectangle drawn', okB);
        await snap(B, 'B_shape');
        const aChanged = await waitCanvasChanged(A, aSigBefore, PROP_BUDGET);
        await snap(A, 'A_sees_B_shape');
        check('A renders the shape B inserted (canvas changed)', aChanged.changed,
            `Asig ${aSigBefore}->${aChanged.sig}`);

        // ── C late-joins → must render BOTH shapes ──
        // Save first so the late-joiner's checkpoint carries the shapes.
        log('--- A saves before C joins (tester Save button) ---');
        await A.page.bringToFront().catch(() => {});
        check('A: tester Save button clicked', await clickSave(A.page));
        await sleep(6000);
        const C = parts.C = await joinPart(browser, pair.joinLink, 'C', 'Cara Shape');
        await sleep(4000);
        const cSig = await canvasSig(C);
        await snap(C, 'C_late_join');
        // Compare C to a pristine reference opened in its own isolated context.
        log('--- pristine reference (no shapes) for comparison ---');
        const refCtx = await browser.createBrowserContext();
        const refPage = await refCtx.newPage();
        await openBytesViaContentViewer(browser, BASE, 'cv-coedit-shape-ref-' + Date.now() + '.docx', bytes, {
            page: refPage, userName: 'Ref Shape', viewport: VP, iframeTimeout: 60000,
        });
        const REF = parts.REF = wire({ id: 'REF', page: refPage, context: refCtx, dead: false });
        check('REF: pristine doc interactive', await waitCvInteractive(refPage, LOAD_BUDGET));
        await sleep(4000);
        const refSig = await canvasSig(REF);
        check('C late-join renders content different from a pristine doc (got the shapes)',
            cSig > 0 && refSig > 0 && cSig !== refSig, `Csig=${cSig} refSig=${refSig}`);

        // Error-flag gate
        for (const id of Object.keys(parts)) {
            const p = parts[id];
            check(`${id}: no checkpoint-mismatch / abort / OOB`, p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
        }
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        for (const id of Object.keys(parts)) {
            const p = parts[id];
            if (p && !p.dead && p.context) { try { await p.context.close(); } catch (e) {} }
        }
        try { await browser.close(); } catch (e) {}
    }
    log('\n' + (allPassed ? 'ALL PASS' : 'SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
