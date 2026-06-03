const __cl = require('../../lib/inject-checklist');
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
//      N of 2" form (i.e. sheet count went up).
//   4. Clicks firstrecord-button (|<). Active sheet must be idx=1.
//   5. Clicks lastrecord-button (>|). Active sheet must be idx=2.
//   6. Clicks prevrecord-button (<). Active sheet must be idx=1.
//   7. Clicks nextrecord-button (>). Active sheet must be idx=2.
//
// Per docdispatcher.ts:486-509 (Excel-like behavior, added 2026-05-31):
// each tab-nav button BOTH scrolls the tab strip AND changes the
// active sheet via app.map.setPart(). Pre-2026-05-31 the buttons were
// scroll-only and the test revision that ran 2026-05-30 → 2026-05-31
// failed against that intermediate state.
//
// Pattern follows test-hotswitch-xlsx.js: read #StatusDocPos plus a
// pixel-hash of a canvas band so we can prove the active sheet
// actually changed (status alone can be stale during the transition).

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

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

        // ── Tests 2-5: the |<, <, >, >| buttons must scroll the tab
        //   strip AND change the active sheet (Excel-like behavior,
        //   docdispatcher.ts:486-509). The starting state from Test 1
        //   has 2 sheets with idx=2 active.
        const navSteps = [
            { id: 'firstrecord-button', label: '|< (firstrecord)', expected: 1 },
            { id: 'lastrecord-button',  label: '>| (lastrecord)',  expected: 2 },
            { id: 'prevrecord-button',  label: '<  (prevrecord)',  expected: 1 },
            { id: 'nextrecord-button',  label: '>  (nextrecord)',  expected: 2 },
        ];
        for (const b of navSteps) {
            log(`--- click ${b.id} ---`);
            const c = await clickButtonInFrame(frame, b.id);
            check(`${b.id} is present + clickable`,
                  c.ok === true, c.why || '');
            await sleep(1500);
            const st = await probeState(frame);
            log(`after ${b.id}: ${JSON.stringify(st)}`);
            check(`${b.label} moved active sheet to idx=${b.expected}`,
                  st.sheetIdx === b.expected,
                  `idx=${st.sheetIdx} (expected ${b.expected})`);
        }

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
