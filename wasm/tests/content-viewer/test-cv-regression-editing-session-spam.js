// test-cv-regression-editing-session-spam.js — tripwire for LIVE-EDITING
// console-log spam (sibling of the cold-open noise budget).
//
// USER-REPORTED 2026-06-07: a real editing session produced "500000+ lines"
// of __emscripten_thread_mailbox_await stack-trace spam; the cold-open
// tripwire missed it because per-layout-tick chatter (OverflowManager
// onResize ~10/s etc.) only stacks up DURING editing.
//
// WHAT IS VERIFIED (same subject + budgets as the legacy test):
//   Open new.docx, then drive a real editing session — click into the doc,
//   type ~170 chars, scroll 10 wheel ticks, quiesce 5 s — capturing EVERY
//   console message + pageerror from before navigation, then assert:
//     total lines <= 400
//     total bytes <= 30 KB
//
// Drives real puppeteer mouse + keyboard; no internal-state assertions (the
// check is purely on observed console output volume). Host page is the
// content-viewer tester; page.on('console') captures the same-origin editor
// iframe's output too.
//
// Migrated from wasm/tests/regression/test-regression-editing-session-spam.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-editing-session-spam.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, waitCvInteractive } = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOCX = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const SHOT_DIR = '/tmp/content-viewer-report/regression-editing-session-spam';

// Same budgets as the legacy test (~35% headroom over the measured
// 289-line / 17.5 KB floor). Bump DOWN as cleanup lands; bump UP only with
// a paired ai/proposals entry.
const BUDGET_LINES = 400;
const BUDGET_BYTES = 30 * 1024;

const TYPE_CHARS = 'Hello world this is an editing session spam regression test. '
                 + 'We type some text to exercise the layout pipeline and '
                 + 'measure how chatty the dev-console is during real use.';
const SCROLL_TICKS = 10;
const SCROLL_DELTA = 200;
const QUIESCE_MS = 5000;
const QUIESCE_CAP_MS = 60000;

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
const editorFrame = page => page.frames().find(f => (f.url() || '').includes('cool.html'));
let shotN = 0;
async function snap(page, name) {
    try { fs.mkdirSync(SHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${SHOT_DIR}/${String(++shotN).padStart(2, '0')}_${name}.png` }); } catch (_) {}
}

(async () => {
    if (!fs.existsSync(DOCX)) { check('fixture present', false, DOCX); process.exit(2); }
    log('=== Regression: live editing-session console spam (content viewer) ===');
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });

    let total = 0;
    let bytesAcc = 0;
    const counts = new Map();
    let pageErrCount = 0;

    try {
        const page = await browser.newPage();

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

        await openViaContentViewer(browser, BASE, DOCX, {
            page, viewport: { width: 1280, height: 900 }, iframeTimeout: 45000,
        });
        check('editor interactive', await waitCvInteractive(page, LOAD_BUDGET));
        const frame = editorFrame(page);
        if (!frame) throw new Error('editor frame never loaded');
        await frame.waitForFunction(() =>
            /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''),
            { timeout: 60000 });
        await sleep(2000);
        await snap(page, 'loaded');

        const linesAfterLoad = total;
        log(`load complete: ${total} lines / ${bytesAcc} bytes`);

        // Click into the doc to focus (real mouse, iframe box coords).
        const ifEl = await page.$('iframe');
        const ifBox = await ifEl.boundingBox();
        const X = ifBox.x + ifBox.width / 2;
        const Y = ifBox.y + Math.min(ifBox.height / 3, 300);
        await page.mouse.click(X, Y);
        await sleep(1000);
        await snap(page, 'clicked');

        // Type — moderate speed so the layout pipeline gets a chance to emit
        // per-frame logs if it's chatty.
        const linesBeforeType = total;
        for (const ch of TYPE_CHARS) {
            await page.keyboard.type(ch, { delay: 30 });
        }
        await sleep(2000);
        await snap(page, 'typed');
        log(`typing complete: ${total} lines (delta=${total - linesBeforeType})`);

        // Scroll — exercises tile invalidation + canvas paint paths. Position
        // the cursor over the doc first so the wheel events hit the editor.
        const linesBeforeScroll = total;
        await page.mouse.move(X, Y);
        for (let i = 0; i < SCROLL_TICKS; i++) {
            await page.mouse.wheel({ deltaY: SCROLL_DELTA });
            await sleep(200);
        }
        await sleep(2000);
        await snap(page, 'scrolled');
        log(`scrolling complete: ${total} lines (delta=${total - linesBeforeScroll})`);

        // Final quiesce — QUIESCE_MS of no new messages (capped).
        const quiesceStart = Date.now();
        let lastSeen = total;
        let quietSince = Date.now();
        while (Date.now() - quietSince < QUIESCE_MS
               && Date.now() - quiesceStart < QUIESCE_CAP_MS) {
            await sleep(500);
            if (total !== lastSeen) { lastSeen = total; quietSince = Date.now(); }
        }
        await snap(page, 'quiesced');

        log(`Final total: ${total} lines / ${bytesAcc} bytes (${(bytesAcc / 1024).toFixed(1)} KB)`);
        log(`Breakdown: load=${linesAfterLoad}, typing=${linesBeforeScroll - linesBeforeType}, `
            + `scrolling=${total - linesBeforeScroll}, pageerrors=${pageErrCount}`);

        // Top sources — diagnostic only.
        const top = Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1]).slice(0, 10);
        log('Top 10 prefixes (most-frequent chatter):');
        for (const [p, c] of top) log(`  ${c}× ${p.replace(/\n/g, '⏎')}`);
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }

    check(`Editing-session console line count under budget (${BUDGET_LINES})`,
        total <= BUDGET_LINES, `lines=${total} budget=${BUDGET_LINES}`);
    check(`Editing-session console byte count under budget (${BUDGET_BYTES} = ${BUDGET_BYTES / 1024} KB)`,
        bytesAcc <= BUDGET_BYTES, `bytes=${bytesAcc} budget=${BUDGET_BYTES}`);

    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
