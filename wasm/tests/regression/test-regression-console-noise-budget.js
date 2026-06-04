const __cl = require('../../lib/inject-checklist');
// test-regression-console-noise-budget.js — tripwire for the
// single-user console-log noise floor.
//
// Today (2026-06-02), opening a 13 KB Writer doc in `?singleuser`
// produces ~1748 console messages in ~33 s. 82 % is three sources
// (OverflowManager.onResize/onRefresh + OverflowGroup chatter); see
// ai/proposals/promoted/console-log-cleanup.md and the task
// ai/tasks/todo/console-log-cleanup.md for the phased cleanup plan.
//
// This test asserts the line count stays under BUDGET. It FAILS today
// and PASSES once Phases 1+2 of the cleanup land. After that, any
// regression that re-introduces chatter trips the wire and surfaces
// in the report.
//
// Drives real puppeteer mouse + keyboard; no internal-state
// assertions (the check is purely on observed console output volume).
//
// Companion: PR #180 commit `d6935cbdea` adds per-scenario console
// KB to the snapshot-milestones report, so chatter regressions show
// up in the warm/cold report too.

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-console-noise-budget';

// Budget post Phases 1-3 + Component.Base verbose precedence fix
// (PR #188). The FRMLOAD strip from LO PR #33 was REVERTED on
// 2026-06-04 because the LO build was branched off a poisoned
// base — see wasm/LO_BUILD_ID history. Without the -50 FRMLOAD
// lines, the floor is back to ~436 lines / ~45 KB on new.docx
// single-user cold open. Budget set with ~15% headroom; will
// tighten once FRMLOAD strip re-lands on a safe LO base.
const BUDGET_LINES = 500;
const BUDGET_BYTES = 55 * 1024;

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    try { await page.screenshot({ path: `${SHOT_DIR}/${name}.png` }); } catch (_) {}
}

(async () => {
    log('=== Console-noise budget tripwire ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const docName = 'console-noise-' + Date.now() + '.docx';
    const fixture = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
    const bytes = fs.readFileSync(fixture);
    const up = await uploadV2(VIEWER, docName, bytes);

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });
    let lines = 0;
    let bytesAcc = 0;
    const sourcesByPrefix = new Map();
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });

        // Capture every console + pageerror. Don't filter — the volume
        // IS the signal.
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

        await page.goto(`${VIEWER}/?singleuser#file=${up.b64urlSecret}`,
            { waitUntil: 'domcontentloaded', timeout: env.scaleTimeout(120000) });

        // Wait for editor + doc-loaded + state bar settled.
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

        // Quiesce: 2 s of no new console messages.
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
    } finally {
        await browser.close();
    }

    // Top sources for diagnostic — only print to log, not asserted on.
    const top = Array.from(sourcesByPrefix.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
    log(`Total console: ${lines} lines / ${bytesAcc} bytes`);
    log('Top 5 prefixes:');
    for (const [p, c] of top) log(`  ${c}×  ${p.replace(/\n/g, '⏎')}`);

    check(`Console line count under budget (${BUDGET_LINES})`,
          lines <= BUDGET_LINES,
          `lines=${lines} budget=${BUDGET_LINES}`);
    check(`Console byte count under budget (${BUDGET_BYTES} = ${BUDGET_BYTES/1024} KB)`,
          bytesAcc <= BUDGET_BYTES,
          `bytes=${bytesAcc} budget=${BUDGET_BYTES}`);

    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e.stack || e.message);
    process.exit(2);
});
