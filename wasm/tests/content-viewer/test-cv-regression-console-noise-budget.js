// test-cv-regression-console-noise-budget.js — tripwire for the single-user
// cold-open console-log noise floor.
//
// WHAT IS VERIFIED (same subject + budgets as the legacy test):
//   Open new.docx, capture EVERY console message + pageerror from before
//   navigation until the doc is loaded and the console has quiesced (2 s of
//   silence), then assert:
//     total lines <= 440
//     total bytes <= 48 KB
//   The volume IS the signal — nothing is filtered. If any of the closed
//   chatter sources (OverflowManager/OverflowGroup debug, JSDialog chatter,
//   lok-* diagnostics) comes back, the wire trips.
//
// Harness change vs legacy: the host page is now the content-viewer tester
// instead of the legacy viewer's ?singleuser route. page.on('console')
// captures the same-origin editor iframe's output too, so the tripwire
// covers the identical editor chatter plus the (quiet) tester host.
//
// Migrated from wasm/tests/regression/test-regression-console-noise-budget.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-console-noise-budget.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, waitCvInteractive } = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOCX = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const SHOT_DIR = '/tmp/content-viewer-report/regression-console-noise-budget';

// Same budgets as the legacy test (floor ~386 lines / ~42 KB post cleanup
// phases + LO PR #34, ~13% headroom). Bump DOWN as cleanup lands; bump UP
// only with a paired ai/proposals entry.
const BUDGET_LINES = 440;
const BUDGET_BYTES = 48 * 1024;

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
const editorFrame = page => page.frames().find(f => (f.url() || '').includes('cool.html'));
async function snap(page, name) {
    try { fs.mkdirSync(SHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${SHOT_DIR}/${name}.png` }); } catch (_) {}
}

(async () => {
    if (!fs.existsSync(DOCX)) { check('fixture present', false, DOCX); process.exit(2); }
    log('=== Console-noise budget tripwire (content viewer) ===');
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });

    let lines = 0;
    let bytesAcc = 0;
    const sourcesByPrefix = new Map();
    try {
        const page = await browser.newPage();

        // Capture every console + pageerror BEFORE navigation. Don't filter —
        // the volume IS the signal.
        page.on('console', m => {
            const t = m.text();
            lines++;
            bytesAcc += Buffer.byteLength(t, 'utf8');
            const prefix = t.substring(0, 80);
            sourcesByPrefix.set(prefix, (sourcesByPrefix.get(prefix) || 0) + 1);
        });
        page.on('pageerror', e => {
            const msg = 'PAGEERROR: ' + (e.message || '');
            lines++;
            bytesAcc += Buffer.byteLength(msg, 'utf8');
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

        // Quiesce: 2 s of no new console messages (30 s window).
        const idleStart = Date.now();
        let lastSeen = lines;
        let quietSince = Date.now();
        while (Date.now() - idleStart < 30000) {
            await sleep(500);
            if (lines !== lastSeen) {
                lastSeen = lines;
                quietSince = Date.now();
            } else if (Date.now() - quietSince > 2000) {
                break;
            }
        }
        await snap(page, 'after-quiesce');
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }

    // Top sources — diagnostic only, not asserted on.
    const top = Array.from(sourcesByPrefix.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
    log(`Total console: ${lines} lines / ${bytesAcc} bytes`);
    log('Top 5 prefixes:');
    for (const [p, c] of top) log(`  ${c}×  ${p.replace(/\n/g, '⏎')}`);

    check(`Console line count under budget (${BUDGET_LINES})`,
        lines <= BUDGET_LINES, `lines=${lines} budget=${BUDGET_LINES}`);
    check(`Console byte count under budget (${BUDGET_BYTES} = ${BUDGET_BYTES / 1024} KB)`,
        bytesAcc <= BUDGET_BYTES, `bytes=${bytesAcc} budget=${BUDGET_BYTES}`);

    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
