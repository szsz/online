const __cl = require('../../lib/inject-checklist');
// Co-editing feature convergence: INSERT SHAPE propagation + churn.
//
// Structural/drawing ops are the classic co-editing divergence source
// (UNO runs in the acting client's *remote* view on peers; a drawing
// object inserted in A must appear in B and vice-versa). This test:
//   A + B open (co-edit)
//   A inserts a rectangle via the Insert ribbon → B's canvas must change
//   B inserts a rectangle                       → A's canvas must change
//   C late-joins                                → C must render BOTH shapes
//   A saves (Ctrl+S)                            → no CHECKPOINT MISMATCH
//
// All driven through visible UI (Insert tab → Shapes → rectangle tile →
// drag on canvas). Convergence signal: the editor canvas SIGNATURE
// (a sampled pixel hash of #document-canvas) — a peer that received the
// remote shape has a different canvas than before the peer's op.
// No sendUnoCommand / dispatcher / internal-state pokes.

'use strict';

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { openViaViewer, openSecretInBrowser } = require('../../lib/open-via-viewer');
const { waitInFrame, evalInFrame, getActiveEditorFrame } = require('../../lib/two-tab');

const VIEWER = env.FILE_STORAGE_URL;
const LOAD_TIMEOUT = env.scaleTimeout(120000);
const PROP_TIMEOUT = env.scaleTimeout(30000);
const SHOT_DIR = '/tmp/static-deploy/public/shots-coedit-feature-shape';
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

// Sampled pixel hash of the editor canvas — a cheap, robust "did the
// rendered document change" signal (same-browser pre/post comparison).
async function canvasSig(part) {
    if (!part || part.dead) return -2;
    return evalInFrame(part.page, () => {
        const c = document.querySelector('#document-canvas');
        if (!c || !c.width) return -1;
        try {
            const g = c.getContext('2d');
            // sample a coarse grid to keep it cheap + stable
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
    }).catch(() => -1);
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
    await page.mouse.click(640, 380); await sleep(400);
    // activate Insert ribbon (re-click until the Shapes button is visible)
    let shapesBox = null;
    for (let i = 0; i < 20 && !shapesBox; i++) {
        const tab = await evalInFrame(page, () => {
            const e = document.querySelector('#Insert-tab-label');
            if (!e || !e.offsetParent) return null;
            const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height };
        }).catch(() => null);
        const ifr = await page.evaluate(() => { const f = document.querySelector('iframe'); const r = f.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top) }; });
        if (tab && tab.w) await page.mouse.click(tab.x + tab.w / 2 + ifr.left, tab.y + tab.h / 2 + ifr.top);
        await sleep(400);
        shapesBox = await evalInFrame(page, () => {
            for (const s of ['[id^="insert-insert-shapes"][id$="-button"]', '[id^="insert-insert-shapes"]:not([id$="-button"])']) {
                const e = document.querySelector(s);
                if (e && e.offsetParent) { const r = e.getBoundingClientRect(); if (r.width > 0) return { x: r.left, y: r.top, w: r.width, h: r.height }; }
            }
            return null;
        }).catch(() => null);
    }
    if (!shapesBox) return false;
    const ifr = await page.evaluate(() => { const f = document.querySelector('iframe'); const r = f.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top) }; });
    await page.mouse.click(shapesBox.x + shapesBox.w / 2 + ifr.left, shapesBox.y + shapesBox.h / 2 + ifr.top);
    await sleep(800);
    const tile = await evalInFrame(page, () => {
        const g = document.querySelector('.insertshape-grid'); if (!g) return null;
        const t = Array.from(g.querySelectorAll('.col')).find(x => (x.dataset.uno || '') === 'BasicShapes.rectangle');
        if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height };
    }).catch(() => null);
    if (!tile) return false;
    await page.mouse.click(tile.x + tile.w / 2 + ifr.left, tile.y + tile.h / 2 + ifr.top);
    await sleep(600);
    // drag a rectangle on the canvas
    const base = { x: 500 + ifr.left, y: 430 + ifr.top };
    await page.mouse.move(base.x, base.y); await page.mouse.down();
    await page.mouse.move(base.x + 180, base.y + 120, { steps: 8 }); await page.mouse.up();
    await sleep(2500);
    // click empty area to deselect (so the shape's selection handles don't
    // pollute the peer-propagation signal via our own selection overlay)
    await page.keyboard.press('Escape'); await sleep(1500);
    return true;
}

async function joinPart(browser, id, secret) {
    log(`--- ${id} joining (co-edit) ---`);
    const up = await openSecretInBrowser(browser, VIEWER, secret, {
        iframeTimeout: LOAD_TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
        isolatedContext: true, coEditing: true, viewport: { width: 1920, height: 1080 },
    });
    const part = wire({ id, page: up.page, context: up.context, dead: false });
    await waitInFrame(part.page,
        () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''),
        { timeout: LOAD_TIMEOUT });
    await sleep(6000);
    return part;
}

(async () => {
    log('=== Co-editing INSERT SHAPE convergence + churn ===');
    const { browser } = await launch({ headless: 'new' });
    const parts = {};
    try {
        const bytes = fs.readFileSync(FIXTURE);
        const NAME = 'coedit-shape-' + Date.now() + '.docx';

        const upA = await openViaViewer(browser, VIEWER, NAME, bytes, {
            iframeTimeout: LOAD_TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
            isolatedContext: true, coEditing: true, viewport: { width: 1920, height: 1080 },
        });
        const A = parts.A = wire({ id: 'A', page: upA.page, context: upA.context, dead: false });
        const secret = upA.b64urlSecret;
        await waitInFrame(A.page, () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''), { timeout: LOAD_TIMEOUT });
        await sleep(6000);

        const B = parts.B = await joinPart(browser, 'B', secret);
        check('A + B both open', true);

        // ── A inserts a rectangle → B must render it ──
        log('--- A inserts rectangle ---');
        const bSigBefore = await canvasSig(B);
        const okA = await insertRectangle(A);
        check('A: Insert ribbon → rectangle drawn', okA);
        await snap(A, 'A_shape');
        const bChanged = await waitCanvasChanged(B, bSigBefore, PROP_TIMEOUT);
        await snap(B, 'B_sees_A_shape');
        check('B renders the shape A inserted (canvas changed)', bChanged.changed,
            `Bsig ${bSigBefore}->${bChanged.sig}`);

        // ── B inserts a rectangle → A must render it ──
        log('--- B inserts rectangle ---');
        const aSigBefore = await canvasSig(A);
        const okB = await insertRectangle(B);
        check('B: Insert ribbon → rectangle drawn', okB);
        await snap(B, 'B_shape');
        const aChanged = await waitCanvasChanged(A, aSigBefore, PROP_TIMEOUT);
        await snap(A, 'A_sees_B_shape');
        check('A renders the shape B inserted (canvas changed)', aChanged.changed,
            `Asig ${aSigBefore}->${aChanged.sig}`);

        // ── C late-joins → must render BOTH shapes ──
        // Save first so the late-joiner's checkpoint carries the shapes.
        log('--- A saves before C joins ---');
        await A.page.bringToFront().catch(() => {});
        await A.page.keyboard.down('Control'); await A.page.keyboard.press('KeyS'); await A.page.keyboard.up('Control');
        await sleep(6000);
        const C = parts.C = await joinPart(browser, 'C', secret);
        await sleep(4000);
        const cSig = await canvasSig(C);
        // A blank new.docx canvas signature (captured fresh in an isolated
        // context that made no edits) would equal the pristine doc; C should
        // differ from a pristine baseline because it rendered 2 shapes.
        await snap(C, 'C_late_join');
        // Compare C to a pristine reference opened in its own tab.
        log('--- pristine reference (no shapes) for comparison ---');
        const refUp = await openViaViewer(browser, VIEWER, 'coedit-shape-ref-' + Date.now() + '.docx', bytes, {
            iframeTimeout: LOAD_TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
            isolatedContext: true, coEditing: false, viewport: { width: 1920, height: 1080 },
        });
        const REF = parts.REF = wire({ id: 'REF', page: refUp.page, context: refUp.context, dead: false });
        await waitInFrame(REF.page, () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''), { timeout: LOAD_TIMEOUT });
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
        for (const id of Object.keys(parts)) { const p = parts[id]; if (p && !p.dead) { try { await p.context.close(); } catch (e) {} } }
        try { await browser.close(); } catch (e) {}
    }

    log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
