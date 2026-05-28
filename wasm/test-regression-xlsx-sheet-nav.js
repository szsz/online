const __cl = require('./lib/inject-checklist');
// Regression: Calc sheet-nav buttons + insert-sheet button must work.
//
// User report (2026-05-28): in Excel editing mode, the sheet-navigation
// buttons in the bottom toolbar (|< < > >|) and the "+" insert-sheet
// button don't respond to clicks. Status indicator does not change,
// no new sheet is created.
//
// Bottom-left button IDs (discovered via wasm/probe-sheet-tabs.js):
//   firstrecord-button    Scroll to the first sheet
//   prevrecord-button     Scroll left
//   nextrecord-button     Scroll right
//   lastrecord-button     Scroll to the last sheet
//   insertsheet-button    Insert sheet (the "+")
//   sheetlist-button      Show sheet list (≡)
//
// This test:
//   1. Opens an xlsx that starts with 1 sheet.
//   2. Reads #StatusDocPos to confirm "Sheet 1 of 1".
//   3. Clicks insertsheet-button. Expects status to flip to a "Sheet
//      N of 2" form (i.e. sheet count went up). FAILS if the button
//      did nothing.
//   4. Clicks firstrecord-button. Expects active sheet to be sheet 1.
//   5. Clicks lastrecord-button. Expects active sheet to be sheet 2.
//   6. Clicks prevrecord-button. Expects sheet 1.
//   7. Clicks nextrecord-button. Expects sheet 2.
//
// Pattern follows test-hotswitch-xlsx.js: read #StatusDocPos plus a
// pixel-hash of a canvas band so we can prove the active sheet
// actually changed (status alone can be stale during the transition).

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');

const VIEWER  = env.FILE_STORAGE_URL;
const FIXTURE = path.join(__dirname, '..', 'test', 'data', 'testdoc.xlsx');
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-xlsx-sheet-nav';

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

// Read both the status indicator and a pixel hash of the visible cells,
// so we can detect "active sheet actually changed" even if the status
// indicator hasn't ticked over yet.
async function probeState(frame) {
    return await frame.evaluate(() => {
        const sd = document.querySelector('#StatusDocPos');
        const statusText = (sd && sd.textContent || '').trim();
        const m = /Sheet\s+(\d+)\s+of\s+(\d+)/i.exec(statusText);
        const sheetIdx   = m ? parseInt(m[1], 10) : null;
        const sheetCount = m ? parseInt(m[2], 10) : null;

        // Canvas-band pixel hash — same recipe as test-hotswitch-xlsx.js.
        const c = document.querySelector('canvas');
        let canvasHash = null;
        if (c) {
            try {
                const ctx = c.getContext('2d', { willReadFrequently: true });
                const w = Math.min(400, c.width), h = Math.min(300, c.height);
                if (w > 0 && h > 0) {
                    const data = ctx.getImageData(0, 0, w, h).data;
                    let h1 = 5381, h2 = 52711;
                    for (let i = 0; i < data.length; i += 7) {
                        h1 = ((h1 * 33) ^ data[i]) >>> 0;
                        h2 = ((h2 * 31) ^ data[i]) >>> 0;
                    }
                    canvasHash = (h1.toString(16) + h2.toString(16));
                }
            } catch (_) { canvasHash = 'denied'; }
        }
        return { statusText, sheetIdx, sheetCount, canvasHash };
    });
}

async function clickButtonInFrame(frame, btnId) {
    return await frame.evaluate((id) => {
        const el = document.getElementById(id);
        if (!el) return { ok: false, why: 'no element' };
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return { ok: false, why: 'zero size' };
        // Use a real click event so any cooltip / focus side-effects fire.
        el.click();
        return { ok: true, rect: { x: Math.round(r.x), y: Math.round(r.y) } };
    }, btnId);
}

(async () => {
    log('=== Regression: Calc sheet navigation + insert-sheet ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(FIXTURE)) {
        log(`SKIP: fixture missing: ${FIXTURE}`);
        process.exit(2);
    }

    const bytes = fs.readFileSync(FIXTURE);
    const name  = `sheet-nav-${Date.now()}.xlsx`;
    const up    = await uploadV2(VIEWER, name, bytes);
    log(`uploaded ${name}`);

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto(`${VIEWER}/?singleuser#file=${up.b64urlSecret}`,
            { waitUntil: 'domcontentloaded',
              timeout: env.scaleTimeout(120000) });

        // Wait for the editor iframe + canvas + the Calc-side "Sheet"
        // status indicator (which means the doc is fully loaded for
        // editing, not just visible).
        let frame = null;
        for (let i = 0; i < 90 && !frame; i++) {
            frame = page.frames().find(f => f.url().includes('cool.html'));
            if (frame && !(await frame.$('#document-canvas').catch(() => null))) frame = null;
            if (!frame) await sleep(1000);
        }
        if (!frame) throw new Error('editor frame never loaded');
        await frame.waitForFunction(
            () => window.__wasmInitialDocLoaded === true,
            { timeout: env.scaleTimeout(60000) });
        await frame.waitForFunction(
            () => document.querySelector('#StatusDocPos')?.textContent?.includes('Sheet'),
            { timeout: env.scaleTimeout(30000) });
        await sleep(2000);
        await snap(page, 'loaded');

        // Baseline: 1 sheet, idx=1.
        const s0 = await probeState(frame);
        log(`baseline: ${JSON.stringify(s0)}`);
        check('Calc loaded with status "Sheet 1 of 1"',
              s0.sheetIdx === 1 && s0.sheetCount === 1,
              `got "${s0.statusText}"`);

        // ── Test 1: Insert-sheet (+) button must add a sheet ───────
        log('--- click insertsheet-button (the "+") ---');
        const c1 = await clickButtonInFrame(frame, 'insertsheet-button');
        log(`click insertsheet-button: ${JSON.stringify(c1)}`);
        check('insertsheet-button is present + clickable',
              c1.ok === true, c1.why || '');
        await sleep(2500);
        await snap(page, 'after_insert');

        const s1 = await probeState(frame);
        log(`after insertsheet: ${JSON.stringify(s1)}`);
        check('Sheet count increased from 1 to 2 after clicking "+"',
              s1.sheetCount === 2,
              `count=${s1.sheetCount} status="${s1.statusText}"`);
        check('Active sheet moved to the new sheet (idx=2)',
              s1.sheetIdx === 2,
              `idx=${s1.sheetIdx}`);

        // ── Test 2: firstrecord (|<) must jump to sheet 1 ──────────
        log('--- click firstrecord-button (|<) ---');
        const c2 = await clickButtonInFrame(frame, 'firstrecord-button');
        check('firstrecord-button is present + clickable',
              c2.ok === true, c2.why || '');
        await sleep(1500);
        const s2 = await probeState(frame);
        log(`after firstrecord: ${JSON.stringify(s2)}`);
        check('firstrecord moved active sheet back to idx=1',
              s2.sheetIdx === 1,
              `idx=${s2.sheetIdx}`);

        // ── Test 3: lastrecord (>|) must jump to sheet 2 ───────────
        log('--- click lastrecord-button (>|) ---');
        const c3 = await clickButtonInFrame(frame, 'lastrecord-button');
        check('lastrecord-button is present + clickable',
              c3.ok === true, c3.why || '');
        await sleep(1500);
        const s3 = await probeState(frame);
        log(`after lastrecord: ${JSON.stringify(s3)}`);
        check('lastrecord moved active sheet to idx=2',
              s3.sheetIdx === 2,
              `idx=${s3.sheetIdx}`);

        // ── Test 4: prevrecord (<) — back to sheet 1 ───────────────
        log('--- click prevrecord-button (<) ---');
        const c4 = await clickButtonInFrame(frame, 'prevrecord-button');
        check('prevrecord-button is present + clickable',
              c4.ok === true, c4.why || '');
        await sleep(1500);
        const s4 = await probeState(frame);
        log(`after prevrecord: ${JSON.stringify(s4)}`);
        check('prevrecord moved active sheet to idx=1',
              s4.sheetIdx === 1,
              `idx=${s4.sheetIdx}`);

        // ── Test 5: nextrecord (>) — forward to sheet 2 ────────────
        log('--- click nextrecord-button (>) ---');
        const c5 = await clickButtonInFrame(frame, 'nextrecord-button');
        check('nextrecord-button is present + clickable',
              c5.ok === true, c5.why || '');
        await sleep(1500);
        const s5 = await probeState(frame);
        log(`after nextrecord: ${JSON.stringify(s5)}`);
        check('nextrecord moved active sheet to idx=2',
              s5.sheetIdx === 2,
              `idx=${s5.sheetIdx}`);

        await snap(page, 'final');

        log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    } finally {
        await browser.close();
    }

    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e.stack || e.message);
    process.exit(2);
});
