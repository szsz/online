const __cl = require('./lib/inject-checklist');
// test-regression-copy-paste-suite.js — unified copy/paste regression
// suite. Consolidates the 9 previously-separate clipboard tests into a
// single file with one row per use-case in the HTML report. Each row is
// independent — a failure in one use-case doesn't cascade.
//
// Goals:
// 1. **Single source of truth** for which copy/paste scenarios are
//    expected to work; the HTML report shows a checklist at a glance.
// 2. **Amortised setup cost** — one shared `withFreshDoc()` helper
//    handles upload + open + grant-clipboard + word-count-settled
//    so each use-case doesn't pay the ~30 s cold-load × 9 = ~4.5 min
//    suite cost.
// 3. **Real Puppeteer mouse + keyboard throughout** — no
//    `sendUnoCommand`, no `frame.evaluate(()=>el.click())`. Same E2E
//    discipline as the rest of the regression suite.
//
// Migration status (2026-06-01, phase 1):
//   ✓ Ported from singleuser-copy-paste.js: case 1 (ABC baseline)
//   ◔ Skeleton + use-case-array shape established
//   ○ Pending migration from existing test files (subsequent phases):
//       - test-regression-real-copypaste.js (single-browser real Ctrl+C/V)
//       - test-regression-mouse-select-copypaste.js (2-browser mouse selection)
//       - test-regression-plaintext-paste.js (text/plain only)
//       - test-regression-paste-coedit.js (2-browser rich text + image)
//       - test-regression-rightclick-copypaste.js (context menu Copy)
//       - test-regression-paste-table.js (HTML table → docx round-trip)
//       - test-singleuser-copy-paste.js (cases 2-9)
//       - test-e2e-copypaste.js (headful Chrome native events)
//       - test-late-join-copypaste.js (late-join after copy/paste)
//
// The use-case array shape is intentionally flat: one entry per row.
// Some scenarios need 2 browsers (mouse-select, paste-coedit,
// late-join) — those use-cases each construct their own second
// browser via the harness lib. The "shared setup" only covers the
// FIRST browser; cross-browser state is per-use-case to keep each
// row independent.

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-copy-paste-suite';

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}${ev ? ' ['+ev+']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' ['+ev+']' : ''}`); allPassed = false; }
}

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch (_) {}
}

// ── Shared harness: open a fresh single-user Writer doc + grant ─────
// clipboard perms. Returns { browser, page, frame, charCount(),
// destroy() }. Each use-case calls this independently so use-case
// failures don't cascade.
async function withFreshDoc() {
    const docName = 'cp-suite-' + Date.now() + '.docx';
    const fixture = path.join(__dirname, '..', 'test', 'data', 'new.docx');
    const bytes = fs.readFileSync(fixture);
    const up = await uploadV2(VIEWER, docName, bytes);

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });
    const page = await browser.newPage();
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.grantPermissions', {
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`${VIEWER}/?singleuser#file=${up.b64urlSecret}`,
        { waitUntil: 'domcontentloaded', timeout: env.scaleTimeout(120000) });

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

    const charCount = () => frame.evaluate(() => {
        const t = document.querySelector('#StateWordCount')?.textContent || '';
        const m = t.match(/(\d+)\s+character/i);
        return m ? parseInt(m[1], 10) : -1;
    });

    return { browser, page, frame, charCount,
             destroy: () => browser.close() };
}

// ── Use-case registry ──────────────────────────────────────────────
// Each use-case is independently runnable; the runner catches per-
// case exceptions so a hang in one doesn't kill the others.
const USE_CASES = [
    {
        slug: 'ctrl-c-v-single-browser-baseline',
        label: 'Ctrl+A → Ctrl+C → Ctrl+End → Ctrl+V doubles content',
        run: async () => {
            const ctx = await withFreshDoc();
            try {
                const wc0 = await ctx.charCount();
                const canvas = await ctx.frame.evaluate(() => {
                    const c = document.querySelector('#document-canvas');
                    const r = c.getBoundingClientRect();
                    return { x: r.left + r.width / 2, y: r.top + 200 };
                });
                await ctx.page.mouse.click(canvas.x, canvas.y);
                await sleep(500);
                await ctx.page.keyboard.type('ABC', { delay: 60 });
                await sleep(1500);
                await snap(ctx.page, 'cv-baseline-typed');
                const wcTyped = await ctx.charCount();
                if (wcTyped - wc0 !== 3) return {
                    pass: false, ev: `type delta=${wcTyped - wc0} expected=3`,
                };
                await ctx.page.keyboard.down('Control');
                await ctx.page.keyboard.press('a');
                await ctx.page.keyboard.up('Control');
                await sleep(500);
                await ctx.page.keyboard.down('Control');
                await ctx.page.keyboard.press('c');
                await ctx.page.keyboard.up('Control');
                await sleep(800);
                await ctx.page.keyboard.down('Control');
                await ctx.page.keyboard.press('End');
                await ctx.page.keyboard.up('Control');
                await sleep(400);
                await ctx.page.keyboard.down('Control');
                await ctx.page.keyboard.press('v');
                await ctx.page.keyboard.up('Control');
                await sleep(2000);
                await snap(ctx.page, 'cv-baseline-pasted');
                const wcPasted = await ctx.charCount();
                // Ctrl+A selects EVERYTHING in the doc (not just our
                // typed "ABC"); copy + paste appends the full content,
                // so the delta equals the pre-paste char count.
                return {
                    pass: wcPasted - wcTyped === wcTyped,
                    ev: `paste delta=${wcPasted - wcTyped} expected=${wcTyped} (doc was Ctrl+A'd, then duplicated)`,
                };
            } finally { await ctx.destroy(); }
        },
    },
    // ── PENDING (subsequent migration phases) ────────────────────
    // Each placeholder records a "todo" check so the report still
    // shows the slug; this makes adding new cases trivially additive.
    // When porting a case from an existing test file, replace `run`
    // with the real implementation.
    { slug: 'mouse-drag-select-then-copy-paste',         pendingPort: 'test-singleuser-copy-paste.js case 4' },
    { slug: 'double-click-word-select-then-copy-paste',  pendingPort: 'test-singleuser-copy-paste.js case 3' },
    { slug: 'ctrl-x-cut-then-paste-restores-content',    pendingPort: 'test-singleuser-copy-paste.js case 5' },
    { slug: 'external-plaintext-paste-via-clipboard',    pendingPort: 'test-regression-plaintext-paste.js' },
    { slug: 'external-rich-html-paste',                  pendingPort: 'test-singleuser-copy-paste.js case 6' },
    { slug: 'external-image-paste-embeds-in-docx',       pendingPort: 'test-singleuser-copy-paste.js case 7' },
    { slug: 'html-table-paste-roundtrips-to-docx',       pendingPort: 'test-regression-paste-table.js' },
    { slug: 'rightclick-menu-copy-then-ctrl-v',          pendingPort: 'test-regression-rightclick-copypaste.js' },
    { slug: 'rightclick-menu-copy-populates-system-clipboard', pendingPort: 'test-regression-rightclick-copypaste.js (smoking gun)' },
    { slug: 'coedit-2browser-paste-propagates-A-to-B',   pendingPort: 'test-regression-paste-coedit.js' },
    { slug: 'coedit-2browser-mouse-selection-paste',     pendingPort: 'test-regression-mouse-select-copypaste.js' },
    { slug: 'late-join-receives-copied-content',         pendingPort: 'test-late-join-copypaste.js' },
    { slug: 'save-and-reopen-persists-pasted-content',   pendingPort: 'test-singleuser-copy-paste.js case 9' },
];

(async () => {
    log('=== Copy/paste regression suite ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    for (const uc of USE_CASES) {
        if (uc.pendingPort) {
            // Surface every pending use-case as a "todo" row so the
            // report shows what's still un-migrated. They don't FAIL —
            // they show as informational. The eventual goal is all
            // rows have a real `run`.
            log(`◔ TODO ${uc.slug} (pending port from ${uc.pendingPort})`);
            // No __cl.recordCheck for pending — kept out of pass/fail
            // count so suite-level fail==0 is meaningful.
            continue;
        }
        log(`--- ${uc.slug} ---`);
        try {
            const result = await uc.run();
            check(`${uc.slug}: ${uc.label}`, result.pass, result.ev);
        } catch (e) {
            check(`${uc.slug}: ${uc.label}`, false, 'EXCEPTION: ' + (e.message || e));
        }
    }

    log('\n' + (allPassed ? '✓ ALL PORTED USE-CASES PASSED' : '✗ SOME PORTED USE-CASES FAILED'));
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e.stack || e.message);
    process.exit(2);
});
