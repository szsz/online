const __cl = require('../../lib/inject-checklist');
// Regression: opening a SECOND document in the SAME tab breaks the
// notebookbar / dialogs.
//
// User-reported 2026-06-19 (incognito, so not a cache artifact): the first
// document opened in a tab works fully — Insert ribbon, Symbol dialog, and
// the shape Area palette all open. But after opening a second document in
// the same tab (a doc-switch via #file= hashchange), the notebookbar tab
// switching stops working: clicking the "Insert" tab no longer activates the
// Insert ribbon, so the Shapes menu button can't be reached, no shape can be
// inserted, and the right-click → Area palette never appears. ("the symbol
// insert, and shape area panel does not appear, also the cursor is a bit
// buggy.")
//
// Repro (deterministic, confirmed on the clean LO build):
//   DOC A: Insert tab → ribbon activates → Shapes → rectangle → right-click
//          → Area → colour palette visible.            (works)
//   switch to DOC B in the same tab (location.hash = #file=<B>)
//   DOC B: click Insert tab → ribbon STAYS on Home → Shapes button absent →
//          no shape → right-click gives only the text menu → no Area.  (BUG)
//
// This test drives everything through real visible UI (mouse/keyboard) and
// asserts via visible DOM only — no sendUnoCommand / dispatcher / state pokes.
//
// STATUS: FIXED (2026-06-21) — the DOC-B assertions now PASS. Root cause was
// kit-side: switchdocument (kit/ChildSession.cpp) passed Batch=true, leaking a
// DialogCancelMode::LOKSilent that killed all modal dialogs on the 2nd doc,
// plus a missing notebookbar refresh on same-type switch (Socket.ts). This is
// no longer a tripwire — it is a live regression guard: it must stay GREEN.
// The DOC-A block is a sanity gate (proves the mechanics work on a first doc).

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const DOC_A = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const DOC_B = path.join(__dirname, '..', '..', '..', 'test', 'data', 'old.docx');
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-docswitch-dialogs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  PASS: ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
let shotN = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    try { await page.screenshot({ path: `${SHOT_DIR}/${String(++shotN).padStart(2,'0')}_${name}.png` }); } catch (_) {}
}

async function getFrame(page) {
    let f = null;
    for (let i = 0; i < 90 && !f; i++) {
        f = page.frames().find(x => x.url().includes('cool.html'));
        if (f && !(await f.$('#document-canvas').catch(() => null))) f = null;
        if (!f) await sleep(1000);
    }
    return f;
}
async function clickEl(page, frame, ifr, finder, arg) {
    const b = await frame.evaluate(finder, arg);
    if (!b || !b.w) return false;
    await page.mouse.click(b.x + b.w / 2 + ifr.left, b.y + b.h / 2 + ifr.top);
    return true;
}
function ifrOf(page) {
    return page.evaluate(() => {
        const f = document.querySelector('iframe'); const r = f.getBoundingClientRect();
        return { left: Math.round(r.left), top: Math.round(r.top) };
    });
}
// Click the Insert notebookbar tab, then poll until the Insert ribbon is
// actually active — i.e. the Shapes menu button becomes visible. Returns
// true only if the ribbon really switched (the thing that breaks on doc B).
async function activateInsertRibbon(page, frame, ifr) {
    for (let i = 0; i < 20; i++) {
        // Re-click each iteration: right after a doc-switch the notebookbar
        // may still be rebuilding, so a single click can be discarded by the
        // rebuild. Re-clicking until the Insert ribbon's Shapes button shows
        // makes this robust to that transient.
        await clickEl(page, frame, ifr, () => {
            const e = document.querySelector('#Insert-tab-label');
            if (!e || !e.offsetParent) return null;
            const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height };
        });
        const shapesVisible = await frame.evaluate(() => {
            for (const s of ['[id^="insert-insert-shapes"][id$="-button"]',
                             '[id^="insert-insert-shapes"]:not([id$="-button"])']) {
                const e = document.querySelector(s);
                if (e && e.offsetParent) { const r = e.getBoundingClientRect(); if (r.width > 0) return true; }
            }
            return false;
        }).catch(() => false);
        if (shapesVisible) return true;
        await sleep(400);
    }
    return false;
}
// Full flow on the currently-open doc: Insert ribbon → rectangle → drag →
// right-click → Area → is the colour palette visible?  Returns a result obj.
async function areaPaletteFlow(page, frame, ifr, label) {
    const cxy = await frame.evaluate(() => {
        const c = document.querySelector('#document-canvas'); const r = c.getBoundingClientRect();
        return { x: Math.round(r.left + r.width * 0.5), y: Math.round(r.top + r.height * 0.45) };
    });
    const click = { x: cxy.x + ifr.left, y: cxy.y + ifr.top };
    await page.keyboard.press('Escape'); await sleep(300);
    await page.mouse.click(click.x, click.y); await sleep(400);

    const ribbon = await activateInsertRibbon(page, frame, ifr);
    await snap(page, label + '_insert_ribbon');
    if (!ribbon) return { ribbon: false, shape: false, areaItem: false, palette: false };

    await clickEl(page, frame, ifr, () => {
        for (const s of ['[id^="insert-insert-shapes"][id$="-button"]', '[id^="insert-insert-shapes"]:not([id$="-button"])']) {
            const e = document.querySelector(s); if (e && e.offsetParent) { const r = e.getBoundingClientRect(); if (r.width) return { x: r.left, y: r.top, w: r.width, h: r.height }; }
        }
        return null;
    });
    await sleep(800);
    const tile = await clickEl(page, frame, ifr, () => {
        const g = document.querySelector('.insertshape-grid'); if (!g) return null;
        const t = Array.from(g.querySelectorAll('.col')).find(x => (x.dataset.uno || '') === 'BasicShapes.rectangle');
        if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    if (!tile) return { ribbon: true, shape: false, areaItem: false, palette: false };
    await sleep(500);
    await page.mouse.move(click.x, click.y); await page.mouse.down();
    await page.mouse.move(click.x + 200, click.y + 140, { steps: 8 }); await page.mouse.up();
    await sleep(2500);
    await page.mouse.click(click.x + 100, click.y + 70, { button: 'right' });
    let menu = false;
    for (let i = 0; i < 25 && !menu; i++) { menu = await frame.evaluate(() => !!document.querySelector('.context-menu-list,.on-the-fly-context-menu')).catch(() => false); if (!menu) await sleep(150); }
    let area = null;
    for (let i = 0; i < 25 && !area; i++) {
        area = await frame.evaluate(() => {
            const el = Array.from(document.querySelectorAll('.context-menu-item,.menu-entry-with-icon,.menu-entry-no-icon')).find(e => /^\s*Area/i.test(e.textContent || ''));
            if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height };
        });
        if (!area) await sleep(150);
    }
    if (area) await page.mouse.click(area.x + area.w / 2 + ifr.left, area.y + area.h / 2 + ifr.top);
    let palette = false;
    // The Area dialog's built-in colour grid is emitted differently depending
    // on the LO core: the Collabora lineage uses a `colorset` drawingarea
    // (rendered client-side as #colorset-img), while upstream emits it as a
    // `coloriconview` iconview (#coloriconview with coloriconview_N swatch
    // entries). Both are the real, interactive palette — accept either.
    for (let i = 0; i < 40 && !palette; i++) {
        palette = await frame.evaluate(() => {
            const drawing = document.querySelector('#colorset-img');
            if (drawing && drawing.getBoundingClientRect().width > 0) return true;
            const iconview = document.querySelector('#coloriconview');
            if (iconview && iconview.getBoundingClientRect().width > 0
                && iconview.querySelector('.ui-iconview-entry')) return true;
            return false;
        }).catch(() => false);
        if (!palette) await sleep(250);
    }
    await snap(page, label + '_area');
    await page.keyboard.press('Escape'); await sleep(400); await page.keyboard.press('Escape'); await sleep(400);
    return { ribbon: true, shape: !!tile, areaItem: !!area, palette };
}
// Wait until a freshly-switched doc has settled: notebookbar present and the
// "Rendering document…" overlay gone.
async function waitDocSettled(page, getFrameFn) {
    for (let i = 0; i < 100; i++) {
        const f = await getFrameFn(page);
        const st = f ? await f.evaluate(() => ({
            tab: !!(document.querySelector('#Home-tab-label, #Insert-tab-label') || {}).offsetParent,
            rendering: /Rendering document/i.test(document.body.innerText || ''),
        })).catch(() => ({ tab: false, rendering: true })) : { tab: false, rendering: true };
        if (st.tab && !st.rendering) return true;
        await sleep(500);
    }
    return false;
}

(async () => {
    log('=== Regression: 2nd doc in same tab must not break notebookbar/dialogs ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true }); fs.mkdirSync(SHOT_DIR, { recursive: true });
    if (!fs.existsSync(DOC_A) || !fs.existsSync(DOC_B)) { log('SKIP: fixtures missing'); process.exit(2); }

    const upA = await uploadV2(VIEWER, `docswitch-A-${Date.now()}.docx`, fs.readFileSync(DOC_A));
    const upB = await uploadV2(VIEWER, `docswitch-B-${Date.now()}.docx`, fs.readFileSync(DOC_B));
    log('uploaded A + B');

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-features=SharedArrayBuffer'],
    });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 900 });
        await page.goto(`${VIEWER}/?singleuser#file=${upA.b64urlSecret}`,
            { waitUntil: 'domcontentloaded', timeout: env.scaleTimeout(120000) });
        let frame = await getFrame(page);
        if (!frame) throw new Error('editor frame A never loaded');
        await frame.waitForFunction(() => window.__wasmInitialDocLoaded === true, { timeout: env.scaleTimeout(90000) });
        await sleep(3000);
        let ifr = await ifrOf(page);

        // ── DOC A (first doc) — sanity gate ──
        log('--- DOC A (first doc) ---');
        const a = await areaPaletteFlow(page, frame, ifr, 'docA');
        log(`  DOC A: ${JSON.stringify(a)}`);
        check('DOC A: Insert ribbon activates on first doc', a.ribbon);
        check('DOC A: Area palette appears for a shape on first doc', a.palette);
        if (!a.ribbon || !a.palette) { log('first-doc sanity failed — aborting'); process.exit(allPassed ? 0 : 1); }

        // ── Switch to DOC B in the SAME tab ──
        log('--- switching to DOC B in the same tab ---');
        await page.evaluate(s => { location.hash = '#file=' + s; }, upB.b64urlSecret);
        await sleep(3000);
        const settled = await waitDocSettled(page, getFrame);
        log(`  DOC B settled: ${settled}`);
        frame = await getFrame(page) || frame;
        try { await frame.waitForFunction(() => window.__wasmInitialDocLoaded === true, { timeout: env.scaleTimeout(60000) }); } catch (_) {}
        await sleep(2500);
        ifr = await ifrOf(page);
        await snap(page, 'docB_loaded');

        // ── DOC B (second doc) — the regression ──
        log('--- DOC B (second doc, same tab) ---');
        const b = await areaPaletteFlow(page, frame, ifr, 'docB');
        log(`  DOC B: ${JSON.stringify(b)}`);
        check('DOC B: Insert ribbon activates after doc-switch (tab switching works)', b.ribbon);
        check('DOC B: Shapes menu reachable → rectangle inserted after doc-switch', b.shape);
        check('DOC B: Area palette appears for a shape after doc-switch', b.palette);

        log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    } finally {
        await browser.close();
    }
    process.exit(allPassed ? 0 : 1);
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(2); });
