// test-cv-regression-copy-paste-suite.js — unified copy/paste regression
// suite through the Tresorit content-viewer (/collabora-tester).
// Consolidates the previously-separate clipboard tests into a single file
// with one row per use-case. Each row is independent — a failure in one
// use-case doesn't cascade (each gets its own fresh browser + fresh doc).
//
// Ported use-cases (real Puppeteer mouse + keyboard throughout — no
// sendUnoCommand, no frame.evaluate(()=>el.click())):
//   - ctrl-c-v-single-browser-baseline   Ctrl+A→C→End→V doubles content
//   - external-plaintext-paste-via-clipboard
//   - cross-tab-cool-to-cool-paste       COOL-marker payload, no fingerprint
//   - html-table-paste-roundtrips-to-docx  (save = tester Save button →
//     browser download; unzip word/document.xml, assert <w:tbl + cells)
//   - save-and-reopen-persists-pasted-content  (save = tester Save button →
//     download; reopen the downloaded file via the tester, char count match)
// Pending rows are kept as informational TODO lines (not failures).
//
// Migrated from wasm/tests/regression/test-regression-copy-paste-suite.js —
// legacy version retired. Legacy v2-storage save (Ctrl+S + downloadV2
// polling) is replaced by the content-preview Save button → browser
// download, per the migration recipe.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-copy-paste-suite.js [base-url]

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { launch, sleep } = require('../../lib/browser');
const {
    openViaContentViewer, openBytesViaContentViewer, waitCvInteractive,
    cvEditorFrame, cvCharCount, waitCvCharCount,
} = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/regression-copy-paste-suite';
const DL_ROOT = '/tmp/cv-downloads-cp-suite';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
let shotN = 0;
async function snap(page, name) {
    try {
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${SHOT_DIR}/${String(++shotN).padStart(2, '0')}_${name}.png` });
    } catch (e) {}
}

// ── Per-page helpers (shared across use-cases) ──────────────────────

async function focusDocBody(page) {
    const el = await page.$('iframe');
    if (!el) return false;
    const box = await el.boundingBox();
    if (!box) return false;
    await page.mouse.click(box.x + box.width / 2,
        box.y + Math.min(box.height * 0.55, 450));
    await sleep(200);
    return true;
}

async function pressShortcut(page, key) {
    await page.keyboard.down('Control');
    await page.keyboard.press(key);
    await page.keyboard.up('Control');
    await sleep(200);
}

async function ctrlEnd(page) {
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    await sleep(150);
}

async function writeClipboardText(page, text) {
    try {
        await page.evaluate(t => navigator.clipboard.writeText(t), text);
    } catch (e) {
        const fr = cvEditorFrame(page);
        if (fr) await fr.evaluate(t => navigator.clipboard.writeText(t), text).catch(() => {});
    }
    await sleep(150);
}

async function writeClipItems(page, items) {
    const writer = target => target.evaluate(async (its) => {
        const blobItems = {};
        for (const k in its) blobItems[k] = new Blob([its[k]], { type: k });
        await navigator.clipboard.write([new ClipboardItem(blobItems)]);
    }, items);
    try { await writer(page); } catch (e) {
        const fr = cvEditorFrame(page);
        if (!fr) throw e;
        await writer(fr);
    }
    await sleep(300);
}

// Plant exactly the HTML+plain payload that COOL's oncopy handler would
// write in a real source tab. The `meta-origin=cool` marker is what
// wasm-loader.js's paste handler keys off to decide between the same-tab
// (`uno:Paste`) and cross-tab (forward HTML bytes) branches. Headless
// Chromium can't share a clipboard across two browser instances, so
// synthesising the source-tab payload is the faithful way to exercise the
// loader branch.
async function plantCoolClipboard(page, sentinel) {
    const html = '<meta http-equiv="content-type" content="text/html; charset=utf-8"/>' +
                 '<meta name="generator" content="LibreOffice"/>' +
                 '<meta name="meta-origin" content="cool"/>' +
                 '<div>' + sentinel + '</div>';
    await writeClipItems(page, { 'text/html': html, 'text/plain': sentinel });
}

// Real click on the content-preview Save button (ElementHandle.click —
// genuine input events at the button's bounding box).
async function clickSaveButton(page) {
    const h = await page.evaluateHandle(() =>
        [...document.querySelectorAll('button')]
            .find(b => /^save$/i.test((b.textContent || '').trim())));
    const el = h.asElement();
    if (el) { await el.click(); return true; }
    return false;
}

async function waitForDownload(dir, budgetMs = 30000) {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
        const files = fs.readdirSync(dir)
            .filter(f => /\.docx$/i.test(f) && !f.endsWith('.crdownload'));
        if (files.length) {
            const f = path.join(dir, files[0]);
            if (fs.statSync(f).size > 0) return f;
        }
        await sleep(500);
    }
    return null;
}

// ── Shared harness: fresh browser + fresh doc per use-case ──────────
// Each use-case launches its OWN browser (as the legacy suite did) so the
// OS clipboard and download state can't leak across rows.
async function withFreshDoc(slug) {
    const { browser, cleanup } = await launch({ headless: 'new' });
    const page = await browser.newPage();
    const cdp = await page.target().createCDPSession();
    try {
        await cdp.send('Browser.grantPermissions', {
            permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
        });
    } catch (e) {}
    const dlDir = path.join(DL_ROOT, slug);
    fs.rmSync(dlDir, { recursive: true, force: true });
    fs.mkdirSync(dlDir, { recursive: true });
    try {
        await cdp.send('Browser.setDownloadBehavior', {
            behavior: 'allow', downloadPath: dlDir, eventsEnabled: true,
        });
    } catch (e) {}

    const bytes = fs.readFileSync(FIXTURE);
    await openBytesViaContentViewer(browser, BASE,
        'cp-suite-' + slug + '-' + Date.now() + '.docx', bytes,
        { page, iframeTimeout: 60000 });
    if (!(await waitCvInteractive(page, LOAD_BUDGET)))
        throw new Error('editor never became interactive');
    if ((await waitCvCharCount(page, c => c >= 0, 60000)) < 0)
        throw new Error('char count never readable');
    await sleep(2000);

    return {
        browser, page, dlDir,
        charCount: () => cvCharCount(page),
        destroy: async () => { try { await (cleanup ? cleanup() : browser.close()); } catch (e) {} },
    };
}

async function waitForCharCountAtLeast(page, expected, timeoutMs = 16000) {
    const got = await waitCvCharCount(page, c => c >= expected, timeoutMs);
    return got >= expected;
}

// ── Use-case registry ──────────────────────────────────────────────
// Each use-case is independently runnable; the runner catches per-case
// exceptions so a hang in one doesn't kill the others.
const USE_CASES = [
    {
        slug: 'ctrl-c-v-single-browser-baseline',
        label: 'Ctrl+A → Ctrl+C → Ctrl+End → Ctrl+V doubles content',
        run: async () => {
            const ctx = await withFreshDoc('ctrl-c-v-baseline');
            try {
                const wc0 = await ctx.charCount();
                // Click into the document canvas (frame-relative rect,
                // offset by the iframe's page-level bounding box).
                const el = await ctx.page.$('iframe');
                const ifBox = await el.boundingBox();
                const fr = cvEditorFrame(ctx.page);
                const canvas = await fr.evaluate(() => {
                    const c = document.querySelector('#document-canvas');
                    const r = c.getBoundingClientRect();
                    return { x: r.left + r.width / 2, y: r.top + 200 };
                });
                await ctx.page.mouse.click(ifBox.x + canvas.x, ifBox.y + canvas.y);
                await sleep(500);
                await ctx.page.keyboard.type('ABC', { delay: 60 });
                await sleep(1500);
                await snap(ctx.page, 'cv-baseline-typed');
                const wcTyped = await ctx.charCount();
                if (wcTyped - wc0 !== 3) return {
                    pass: false, ev: `type delta=${wcTyped - wc0} expected=3`,
                };
                await pressShortcut(ctx.page, 'a');
                await sleep(500);
                await pressShortcut(ctx.page, 'c');
                await sleep(800);
                await ctrlEnd(ctx.page);
                await sleep(400);
                await pressShortcut(ctx.page, 'v');
                await sleep(4000);
                await snap(ctx.page, 'cv-baseline-pasted');
                const wcPasted = await ctx.charCount();
                // Ctrl+A selects EVERYTHING in the doc (not just our typed
                // "ABC"); copy + paste appends the full content, so the
                // delta equals the pre-paste char count.
                return {
                    pass: wcPasted - wcTyped === wcTyped,
                    ev: `paste delta=${wcPasted - wcTyped} expected=${wcTyped} (doc was Ctrl+A'd, then duplicated)`,
                };
            } finally { await ctx.destroy(); }
        },
    },
    // ── PENDING (subsequent migration phases) ────────────────────
    // Each placeholder records a "todo" row so the output still shows the
    // slug. Some flows are covered by standalone CV tests already.
    { slug: 'mouse-drag-select-then-copy-paste',
      pendingPort: 'covered standalone by test-cv-regression-mouse-drag-copypaste.js' },
    { slug: 'double-click-word-select-then-copy-paste',
      pendingPort: 'covered standalone by test-cv-regression-double-click-word-copypaste.js' },
    { slug: 'ctrl-x-cut-then-paste-restores-content',
      pendingPort: 'covered standalone by test-cv-regression-ctrl-x-cut-restore.js (TRIPWIRE)' },
    {
        slug: 'external-plaintext-paste-via-clipboard',
        label: 'External text → navigator.clipboard.writeText → Ctrl+V grows doc',
        // Verifies the OS-clipboard → kit-paste pipeline. Char-count delta
        // catches the prior "fake pass" mode (LO's internal clipboard had
        // matching-length content); we use a UNIQUE-LENGTH sentinel so a
        // stale internal-clipboard match is statistically impossible.
        run: async () => {
            const ctx = await withFreshDoc('external-plaintext');
            try {
                const SENTINEL = 'PASTED-EXTERNAL-' + Date.now();
                await focusDocBody(ctx.page);
                await ctrlEnd(ctx.page);
                const before = await ctx.charCount();
                await writeClipboardText(ctx.page, SENTINEL);
                await focusDocBody(ctx.page);
                await pressShortcut(ctx.page, 'v');
                const grew = await waitForCharCountAtLeast(
                    ctx.page, before + SENTINEL.length, 24000);
                const after = await ctx.charCount();
                await snap(ctx.page, 'external-text-paste');
                return {
                    pass: grew,
                    ev: `before=${before} after=${after} sentinel.len=${SENTINEL.length}`,
                };
            } finally { await ctx.destroy(); }
        },
    },
    {
        slug: 'cross-tab-cool-to-cool-paste',
        label: 'COOL-marker payload (no fingerprint match) takes cross-tab branch and lands in destination doc',
        // Verifies the loader's cross-tab branch: when a COOL `meta-origin`
        // marker is in the clipboard HTML but `_lastCopiedPlain` is unset
        // (destination never copied), the handler must forward the HTML
        // bytes like Word→COOL does — NOT route to `uno:Paste` which reads
        // the per-kit-process internal clipboard (empty here → no-op).
        run: async () => {
            const ctx = await withFreshDoc('cross-tab-cool');
            try {
                const SENTINEL = 'CROSSTAB-PASTE-SENTINEL-' + Date.now();
                await plantCoolClipboard(ctx.page, SENTINEL);
                await focusDocBody(ctx.page);
                const before = await ctx.charCount();
                await ctrlEnd(ctx.page);
                await pressShortcut(ctx.page, 'v');
                const grew = await waitForCharCountAtLeast(
                    ctx.page, before + SENTINEL.length, 24000);
                const after = await ctx.charCount();
                await snap(ctx.page, 'cross-tab-paste');
                return {
                    pass: grew && (after - before) >= SENTINEL.length,
                    ev: `before=${before} after=${after} delta=${after - before} sentinel.len=${SENTINEL.length}`,
                };
            } finally { await ctx.destroy(); }
        },
    },
    { slug: 'external-rich-html-paste',
      pendingPort: 'covered by test-cv-e2e-copypaste.js STEP 5 / test-cv-regression-plaintext-paste.js TEST E' },
    { slug: 'external-image-paste-embeds-in-docx',
      pendingPort: 'covered standalone by test-cv-regression-external-image-paste.js' },
    {
        slug: 'html-table-paste-roundtrips-to-docx',
        label: '2×2 HTML table on clipboard → Ctrl+V → Save → saved docx has <w:tbl with the cell content',
        // Verifies the kit's HTML-import filter on tables: external apps
        // (Gmail, Word, browser-rendered HTML) routinely put `<table>` in
        // text/html. wasm-loader writes the bytes via `paste mimetype=
        // text/html`, the kit's HTML import runs, and the saved docx must
        // contain `<w:tbl>` with the cell content. A regression where the
        // filter drops cells / flattens to inline text shows up as a
        // missing `<w:tbl` or wrong row/cell count. Save goes through the
        // content-preview Save button (export → browser download).
        run: async () => {
            const TABLE_HTML = '<html><body><table border="1">' +
                '<tr><td>R1C1</td><td>R1C2</td></tr>' +
                '<tr><td>R2C1</td><td>R2C2</td></tr>' +
                '</table></body></html>';
            const TABLE_PLAIN = 'R1C1\tR1C2\nR2C1\tR2C2';
            const ctx = await withFreshDoc('html-table');
            try {
                const wc0 = await ctx.charCount();
                await writeClipItems(ctx.page, {
                    'text/html': TABLE_HTML, 'text/plain': TABLE_PLAIN,
                });
                await focusDocBody(ctx.page);
                await ctrlEnd(ctx.page);
                await pressShortcut(ctx.page, 'v');
                await sleep(6000);
                await snap(ctx.page, 'html-table-after-paste');
                const wcAfter = await ctx.charCount();
                const delta = wcAfter - wc0;
                // 4 cells × 4 chars = 16; allow up to 64 for whitespace
                // padding. A regression dropping the table lands at 0.
                if (delta < 16 || delta > 64) return {
                    pass: false,
                    ev: `paste delta=${delta} expected 16..64 (table not landed)`,
                };
                // Save via the content-preview Save button → downloaded docx.
                if (!(await clickSaveButton(ctx.page))) return {
                    pass: false, ev: 'Save button not clickable',
                };
                const dl = await waitForDownload(ctx.dlDir, 30000);
                if (!dl) return {
                    pass: false, ev: 'save did not produce a download within 30s',
                };
                // unzip word/document.xml and grep for <w:tbl + cell strings.
                let docXml = '';
                try {
                    docXml = execFileSync('unzip',
                        ['-p', dl, 'word/document.xml'],
                        { maxBuffer: 16 * 1024 * 1024 }).toString();
                } catch (e) { /* fall through with empty docXml */ }
                const hasTbl = docXml.indexOf('<w:tbl') >= 0;
                const trCount = (docXml.match(/<w:tr[ >\/]/g) || []).length;
                const tcCount = (docXml.match(/<w:tc[ >\/]/g) || []).length;
                const hasR1C1 = docXml.indexOf('R1C1') >= 0;
                const hasR2C2 = docXml.indexOf('R2C2') >= 0;
                const ok = hasTbl && trCount >= 2 && tcCount >= 4
                        && hasR1C1 && hasR2C2;
                return {
                    pass: ok,
                    ev: `delta=${delta} <w:tbl=${hasTbl} tr=${trCount} tc=${tcCount} R1C1=${hasR1C1} R2C2=${hasR2C2}`,
                };
            } finally { await ctx.destroy(); }
        },
    },
    { slug: 'rightclick-menu-copy-then-ctrl-v',
      pendingPort: 'covered standalone by test-cv-regression-rightclick-copypaste.js' },
    { slug: 'rightclick-menu-copy-populates-system-clipboard',
      pendingPort: 'covered standalone by test-cv-regression-rightclick-copypaste.js (smoking gun)' },
    { slug: 'coedit-2browser-paste-propagates-A-to-B',
      pendingPort: 'test-regression-paste-coedit.js (co-edit — needs openCoEditPair port)' },
    { slug: 'coedit-2browser-mouse-selection-paste',
      pendingPort: 'test-regression-mouse-select-copypaste.js (co-edit — needs openCoEditPair port)' },
    { slug: 'late-join-receives-copied-content',
      pendingPort: 'test-late-join-copypaste.js (co-edit — needs joinViaContentViewer port)' },
    {
        slug: 'save-and-reopen-persists-pasted-content',
        label: 'Type → Ctrl+V external sentinel → Save → reopen downloaded file → char count matches',
        // End-to-end save-and-reopen verifying paste persists across a tab
        // close. Save goes through the content-preview Save button (export
        // → download); the downloaded docx is re-opened through the tester
        // in a fresh page and the char count must come back exactly what it
        // was pre-save. Catches the class of bug where paste mutates the
        // in-memory doc but never reaches the exported bytes.
        run: async () => {
            const ctx = await withFreshDoc('save-and-reopen');
            try {
                const SENTINEL = 'SAVED-REOPEN-' + Date.now();
                await focusDocBody(ctx.page);
                await ctrlEnd(ctx.page);
                const before = await ctx.charCount();
                await writeClipboardText(ctx.page, SENTINEL);
                await focusDocBody(ctx.page);
                await pressShortcut(ctx.page, 'v');
                const grew = await waitForCharCountAtLeast(
                    ctx.page, before + SENTINEL.length, 24000);
                if (!grew) return {
                    pass: false,
                    ev: `paste did not grow doc: before=${before} after=${await ctx.charCount()}`,
                };
                const beforeSave = await ctx.charCount();
                // Save via the content-preview Save button → download.
                if (!(await clickSaveButton(ctx.page))) return {
                    pass: false, ev: 'Save button not clickable',
                };
                const dl = await waitForDownload(ctx.dlDir, 30000);
                await snap(ctx.page, 'before-reopen');
                if (!dl) return {
                    pass: false, ev: 'save did not produce a download within 30s',
                };
                // Reopen the downloaded file in a second page in the SAME
                // browser (fresh session = real reload path).
                const page2 = await ctx.browser.newPage();
                const cdp2 = await page2.target().createCDPSession();
                try {
                    await cdp2.send('Browser.grantPermissions', {
                        permissions: ['clipboardReadWrite'],
                    });
                } catch (e) {}
                await openViaContentViewer(ctx.browser, BASE, dl,
                    { page: page2, iframeTimeout: 60000 });
                if (!(await waitCvInteractive(page2, LOAD_BUDGET))) return {
                    pass: false, ev: 'reopened file never became interactive',
                };
                await sleep(2500);
                const afterReopen = await cvCharCount(page2);
                await snap(page2, 'after-reopen');
                return {
                    pass: afterReopen === beforeSave,
                    ev: `beforeSave=${beforeSave} afterReopen=${afterReopen} sentinel.len=${SENTINEL.length}`,
                };
            } finally { await ctx.destroy(); }
        },
    },
];

(async () => {
    log('=== Copy/paste regression suite (content-viewer) ===');
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
    log('viewer: ' + BASE);
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.rmSync(DL_ROOT, { recursive: true, force: true });

    for (const uc of USE_CASES) {
        if (uc.pendingPort) {
            // Surface every pending use-case as a "todo" row so the output
            // shows what's still un-migrated. They don't FAIL — they are
            // informational and stay out of the pass/fail count.
            log(`◔ TODO ${uc.slug} (${uc.pendingPort})`);
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

    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e.stack || e.message);
    process.exit(2);
});
