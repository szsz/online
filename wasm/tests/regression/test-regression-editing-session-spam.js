const __cl = require('../../lib/inject-checklist');
// test-regression-editing-session-spam.js — tripwire for live-editing
// console-log spam.
//
// USER-REPORTED 2026-06-07: opening a real document on the deployed
// stack produces "500000+ lines" of __emscripten_thread_mailbox_await
// stack-trace spam. The existing console-noise-budget test only
// captures COLD-OPEN noise (379 lines on new.docx singleuser) and
// totally misses the live-editing path, where chatty per-layout-tick
// logs (OverflowManager.onResize at ~10/s, JSDialog.RefreshScrollables
// per tab switch, lok-* fprintf diagnostics per paint) accumulate
// into 1500+ lines in a 90s session — and into the user's reported
// hundreds of thousands over a multi-hour work day.
//
// This test drives a real editing session for ~60 s (load + click +
// type 50 chars + scroll 10 ticks + quiesce) and asserts the total
// console line count stays under a strict budget. Today (post LO PR
// #37 cleanup + the older Online f9b57bfce3 OverflowManager cleanup)
// the floor should be ~500 lines / 70 KB. Budget set with ~25%
// headroom; future regressions that re-introduce chatter trip the
// wire and surface in the report.
//
// Drives real puppeteer mouse + keyboard; no internal-state
// assertions (the check is purely on observed console output volume).
// All page console + pageerror also flow into the per-test
// `console.log` via the lib/console-capture infrastructure (PR #202),
// so post-mortem analysis is one click away from the report.

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-editing-session-spam';

// Budget — set with ~25% headroom over today's clean floor.
//
// Historical floor (measured against szebeni-wasm-viewer.azurewebsites.net):
//   2026-06-07 (LO -69, pre Online #209):  1230 lines / 80 KB editing session
//   2026-06-08 (LO -70 + PR #209):          290 lines / 15 KB editing session
//                                           (zero growth over 5min idle)
//
// PR #210 cleanup (executeAction conditional debug + Component.Toolbar
// explicitly-hiding/showing) expected to drop another ~25 lines.
//
// Bump the budget DOWN as cleanup phases land; bump UP only with a
// paired ai/proposals/proposed/<slug>.md entry.
const BUDGET_LINES = 650;
const BUDGET_BYTES = 90 * 1024;

const TYPE_CHARS = 'Hello world this is an editing session spam regression test. '
                 + 'We type some text to exercise the layout pipeline and '
                 + 'measure how chatty the dev-console is during real use.';
const SCROLL_TICKS = 10;
const SCROLL_DELTA = 200;
const QUIESCE_MS = 5000;

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  PASS: ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    try { await page.screenshot({ path: `${SHOT_DIR}/${name}.png` }); } catch (_) {}
}

(async () => {
    log('=== Regression: live editing-session console spam ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const docName = 'editing-spam-' + Date.now() + '.docx';
    const fixture = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
    const bytes = fs.readFileSync(fixture);
    const up = await uploadV2(VIEWER, docName, bytes);
    log(`uploaded ${docName}`);

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    let total = 0;
    let bytesAcc = 0;
    const counts = new Map();
    let pageErrCount = 0;

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });

        page.on('console', m => {
            const t = m.text();
            total++;
            bytesAcc += Buffer.byteLength(t, 'utf8');
            const prefix = t.substring(0, 80);
            counts.set(prefix, (counts.get(prefix) || 0) + 1);
        });
        page.on('pageerror', e => {
            pageErrCount++;
            total++;
            bytesAcc += Buffer.byteLength(e.message || '', 'utf8');
        });

        await page.goto(`${VIEWER}/?singleuser#file=${up.b64urlSecret}`,
            { waitUntil: 'domcontentloaded', timeout: env.scaleTimeout(120000) });

        // Wait for editor + doc-loaded.
        let frame = null;
        for (let i = 0; i < 90 && !frame; i++) {
            frame = page.frames().find(f => f.url().includes('cool.html'));
            if (frame && !(await frame.$('#document-canvas').catch(() => null))) frame = null;
            if (!frame) await sleep(1000);
        }
        if (!frame) throw new Error('editor frame never loaded');
        await frame.waitForFunction(() => window.__wasmInitialDocLoaded === true,
            { timeout: env.scaleTimeout(60000) });
        await frame.waitForFunction(() =>
            /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''),
            { timeout: env.scaleTimeout(30000) });
        await sleep(2000);
        await snap(page, '01_loaded');

        const linesAfterLoad = total;
        log(`load complete: ${total} lines / ${bytesAcc} bytes`);

        // Click into the doc to focus.
        const canvasXY = await frame.evaluate(() => {
            const c = document.querySelector('#document-canvas');
            if (!c) return null;
            const r = c.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 3 };
        });
        const ifrEl = await page.$('#editor-frame');
        const ifrBox = ifrEl ? await ifrEl.boundingBox() : { x: 0, y: 0 };
        const X = (ifrBox.x || 0) + (canvasXY?.x || 100);
        const Y = (ifrBox.y || 0) + (canvasXY?.y || 100);

        await page.mouse.click(X, Y);
        await sleep(1000);
        await snap(page, '02_clicked');

        // Type — moderate speed so the layout pipeline gets a chance to
        // emit per-frame logs if it's chatty.
        const linesBeforeType = total;
        for (const ch of TYPE_CHARS) {
            await page.keyboard.type(ch, { delay: 30 });
        }
        await sleep(2000);
        await snap(page, '03_typed');
        log(`typing complete: ${total} lines (delta=${total - linesBeforeType})`);

        // Scroll — exercises tile invalidation + canvas paint paths.
        const linesBeforeScroll = total;
        for (let i = 0; i < SCROLL_TICKS; i++) {
            await page.mouse.wheel({ deltaY: SCROLL_DELTA });
            await sleep(200);
        }
        await sleep(2000);
        await snap(page, '04_scrolled');
        log(`scrolling complete: ${total} lines (delta=${total - linesBeforeScroll})`);

        // Final quiesce — wait until QUIESCE_MS of no new messages.
        let lastSeen = total;
        let quietSince = Date.now();
        while (Date.now() - quietSince < QUIESCE_MS && (Date.now() - T0) < 90000) {
            await sleep(500);
            if (total !== lastSeen) { lastSeen = total; quietSince = Date.now(); }
        }
        await snap(page, '05_quiesced');

        log(`Final total: ${total} lines / ${bytesAcc} bytes (${(bytesAcc/1024).toFixed(1)} KB)`);
        log(`Breakdown: load=${linesAfterLoad}, typing=${linesBeforeScroll - linesBeforeType}, `
            + `scrolling=${total - linesBeforeScroll}, pageerrors=${pageErrCount}`);

        // Top sources — for diagnostic. Captured to the report via
        // the persistent console capture in lib/console-capture.js
        // (PR #202 + #203 + #205). Surface here too so the per-test
        // log lines have a quick summary.
        const top = Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1]).slice(0, 10);
        log('Top 10 prefixes (most-frequent chatter):');
        for (const [p, c] of top) {
            log(`  ${c}× ${p.replace(/\n/g, '⏎')}`);
        }
    } finally {
        await browser.close();
    }

    check(`Editing-session console line count under budget (${BUDGET_LINES})`,
          total <= BUDGET_LINES,
          `lines=${total} budget=${BUDGET_LINES}`);
    check(`Editing-session console byte count under budget (${BUDGET_BYTES} = ${BUDGET_BYTES/1024} KB)`,
          bytesAcc <= BUDGET_BYTES,
          `bytes=${bytesAcc} budget=${BUDGET_BYTES}`);

    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e.stack || e.message);
    process.exit(2);
});
