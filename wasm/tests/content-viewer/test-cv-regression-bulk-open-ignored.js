// test-cv-regression-bulk-open-ignored.js — bulk-open smoke of the ad-hoc
// test/samples/ignored/ corpus through the content-viewer.
//
// WHAT IS VERIFIED: every file in the gitignored, local-only corpus at
// test/samples/ignored/ (may be absent on any machine; absent/empty corpus →
// log skip + exit 0) opens through the real /collabora-tester upload flow and
// accepts typing. Each file gets a FRESH page (so one broken file cannot
// poison the next): open via openViaContentViewer, wait waitCvInteractive
// (generous budget), click into the doc via the iframe bounding box, type
// "hello world" through the real keyboard, then verify the typing landed via
//   (a) canvas pixel-diff — before/after screenshots of the editor region,
//       compared pixel-by-pixel with a noise threshold, and
//   (b) char-count delta via cvCharCount (#StateWordCount, docx only).
// Per-file open time + before/after screenshots land in an HTML report at
// /tmp/content-viewer-report/bulk-open-ignored/report.html.
//
// Per-file failures are recorded in the report and the log tally (per-file
// PASS/FAIL lines + ALL PASS / SOME FAILED), but the process ALWAYS exits 0
// so this local-only bulk run never blocks a suite.
//
// Real user input only drives the editor (bounding-box mouse clicks +
// page.keyboard); frame/page.evaluate is used solely to READ state.
//
// Migrated from wasm/tests/regression/test-regression-bulk-open-ignored.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-bulk-open-ignored.js [base-url]
//   BULK_OPEN_SAMPLES_DIR=<dir>  override the corpus location
//   BULK_OPEN_FILTER=<substr>    open only files whose name contains <substr>
//   LOAD_BUDGET=<ms>             per-file interactive budget (default 300000)

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, waitCvInteractive, cvCharCount } =
    require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const SAMPLES_DIR = process.env.BULK_OPEN_SAMPLES_DIR
    || path.join(__dirname, '..', '..', '..', 'test', 'samples', 'ignored');
const REPORT_DIR = '/tmp/content-viewer-report/bulk-open-ignored';
const REPORT_PATH = path.join(REPORT_DIR, 'report.html');
// Generous patience (NOT a perf gate — the legacy per-MB budget gate is
// deliberately dropped: this port always exits 0 and never aborts the run).
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const PHRASE = 'hello world';

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

function formatOf(name) {
    const ext = path.extname(name).toLowerCase().replace(/^\./, '');
    if (['docx', 'doc', 'odt', 'rtf'].includes(ext)) return 'docx';
    if (['xlsx', 'xls', 'ods', 'csv'].includes(ext)) return 'xlsx';
    if (['pptx', 'ppt', 'odp'].includes(ext)) return 'pptx';
    return ext || 'unknown';
}

function listFiles() {
    if (!fs.existsSync(SAMPLES_DIR)) return [];
    const focus = (process.env.BULK_OPEN_FILTER || '').toLowerCase();
    return fs.readdirSync(SAMPLES_DIR)
        .filter(n => !n.startsWith('.'))
        .filter(n => !focus || n.toLowerCase().includes(focus))
        .filter(n => { try { return fs.statSync(path.join(SAMPLES_DIR, n)).isFile(); } catch (_) { return false; } })
        .sort((a, b) => a.localeCompare(b));
}

// Screenshot the editor-canvas region of the tester's iframe (inset so the
// notebookbar/ribbon chrome doesn't pollute the pixel-diff). Returns a PNG
// Buffer or null.
async function snapEditorRegion(page) {
    try {
        const el = await page.$('iframe');
        if (!el) return null;
        const box = await el.boundingBox();
        if (!box) return null;
        const clip = {
            x: Math.max(0, Math.round(box.x + box.width * 0.20)),
            y: Math.max(0, Math.round(box.y + 240)),
            width: Math.round(box.width * 0.60),
            height: Math.round(Math.min(box.height - 280, 360)),
        };
        if (clip.width <= 0 || clip.height <= 0) return null;
        return await page.screenshot({ clip, type: 'png' });
    } catch (e) { return null; }
}

// Decode both PNGs in-page (READ-only use of evaluate) and count pixels whose
// R/G/B differ by >10 — the same noise threshold the legacy test used to kill
// re-paint jitter. Returns the diff count, or -1 on decode/shape failure.
async function pixelDiffOnPage(page, pngA, pngB) {
    if (!pngA || !pngB) return -1;
    try {
        return await page.evaluate(async (a, b) => {
            const load = async data => {
                const img = new Image();
                img.src = 'data:image/png;base64,' + data;
                await img.decode();
                const c = document.createElement('canvas');
                c.width = img.naturalWidth; c.height = img.naturalHeight;
                const ctx = c.getContext('2d');
                ctx.drawImage(img, 0, 0);
                return ctx.getImageData(0, 0, c.width, c.height).data;
            };
            const da = await load(a), db = await load(b);
            if (da.length !== db.length) return -1;
            let diffs = 0;
            for (let i = 0; i < da.length; i += 4) {
                if (Math.abs(da[i] - db[i]) > 10 || Math.abs(da[i + 1] - db[i + 1]) > 10
                    || Math.abs(da[i + 2] - db[i + 2]) > 10) diffs++;
            }
            return diffs;
        }, pngA.toString('base64'), pngB.toString('base64'));
    } catch (e) { return -1; }
}

async function openAndTypeOne(browser, fileName, idx) {
    const filePath = path.join(SAMPLES_DIR, fileName);
    const fmt = formatOf(fileName);
    const safe = String(idx).padStart(2, '0') + '_' + fileName.replace(/[^A-Za-z0-9._-]+/g, '_');
    const r = {
        idx, fileName, fmt, sizeBytes: 0, tOpenMs: -1,
        verify: 'fail', verifyDetail: '', beforeShot: '', afterShot: '',
    };
    try { r.sizeBytes = fs.statSync(filePath).size; }
    catch (e) { r.verifyDetail = 'stat error: ' + e.message; return r; }

    log(`\n[${idx}] ${fileName} (${fmt}, ${(r.sizeBytes / 1024 / 1024).toFixed(2)} MB)`);
    let page = null;
    try {
        // Fresh page per file — a broken/crashed file's page is simply closed
        // and the next file starts clean on the same (warm) browser.
        page = await browser.newPage();
        const tOpen = Date.now();
        await openViaContentViewer(browser, BASE, filePath, {
            page, iframeTimeout: 60000, gotoTimeout: 60000,
        });
        const interactive = await waitCvInteractive(page, LOAD_BUDGET);
        r.tOpenMs = Date.now() - tOpen;
        if (!interactive) throw new Error(`never interactive within ${LOAD_BUDGET}ms`);
        log(`[${idx}] interactive in ${(r.tOpenMs / 1000).toFixed(2)}s`);
        await sleep(2500); // let canvas tiles paint before the BEFORE shot

        r.beforeShot = `${safe}_before.png`;
        try { await page.screenshot({ path: path.join(REPORT_DIR, r.beforeShot) }); }
        catch (e) { r.beforeShot = ''; }
        const beforeRegion = await snapEditorRegion(page);
        const baseChars = await cvCharCount(page);
        log(`[${idx}] baseline chars=${baseChars}`);

        // Click into the document via the iframe bounding box (real mouse).
        const el = await page.$('iframe');
        const box = el ? await el.boundingBox() : null;
        if (!box) throw new Error('editor iframe has no bounding box');
        const cx = box.x + box.width / 2, cy = box.y + 300;
        if (fmt === 'pptx') {
            // Select the title frame, then double-click to enter edit mode.
            await page.mouse.click(cx, cy);
            await sleep(400);
            await page.mouse.click(cx, cy, { clickCount: 2 });
            await sleep(800);
        } else {
            await page.mouse.click(cx, cy);
            await sleep(500);
        }
        await page.keyboard.down('Control');
        await page.keyboard.press('Home');
        await page.keyboard.up('Control');
        await sleep(500);
        await page.keyboard.type(PHRASE, { delay: 50 });
        await sleep(800);
        if (fmt === 'xlsx') { await page.keyboard.press('Enter'); await sleep(800); }
        await sleep(2500); // let the canvas re-paint

        r.afterShot = `${safe}_after.png`;
        try { await page.screenshot({ path: path.join(REPORT_DIR, r.afterShot) }); }
        catch (e) { r.afterShot = ''; }
        const afterRegion = await snapEditorRegion(page);
        const pdiff = await pixelDiffOnPage(page, beforeRegion, afterRegion);
        log(`[${idx}] pixel diff=${pdiff}`);

        if (fmt === 'docx') {
            const afterChars = await cvCharCount(page);
            const delta = (afterChars >= 0 && baseChars >= 0) ? afterChars - baseChars : null;
            log(`[${idx}] after chars=${afterChars} (delta=${delta})`);
            // +11 chars (allow small kit-trim) OR a real canvas change.
            if (delta !== null && delta >= 9 && delta <= 13) {
                r.verify = 'pass';
                r.verifyDetail = `chars +${delta} (expected +11), pxDiff=${pdiff}`;
            } else if (pdiff > 100) {
                r.verify = 'pass';
                r.verifyDetail = `canvas changed pxDiff=${pdiff}, chars delta=${delta}`;
            } else {
                r.verifyDetail = `chars delta=${delta} (expected +11), pxDiff=${pdiff}`;
            }
        } else if (pdiff > 100) {
            r.verify = 'pass';
            r.verifyDetail = `canvas changed pxDiff=${pdiff}`;
        } else {
            r.verifyDetail = pdiff < 0 ? `pixel decode failed (pxDiff=${pdiff})`
                : `pxDiff=${pdiff} below threshold 100`;
        }
    } catch (e) {
        r.verifyDetail = r.verifyDetail || ('error: ' + (e.message || e));
        // Best-effort failure shot so the report shows what the page looked like.
        if (page && !r.afterShot) {
            r.afterShot = `${safe}_fail.png`;
            try { await page.screenshot({ path: path.join(REPORT_DIR, r.afterShot) }); }
            catch (_) { r.afterShot = ''; }
        }
    } finally {
        try { if (page) await page.close(); } catch (_) {}
    }
    return r;
}

const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderReport(results, walltimeMs, allFiles) {
    const passed = results.filter(r => r.verify === 'pass').length;
    const rows = results.map(r => `<tr class="${r.verify === 'pass' ? 'pass' : 'fail'}">
  <td>${r.idx}</td>
  <td class="file">${escHtml(r.fileName)}</td>
  <td>${escHtml(r.fmt)}</td>
  <td class="num">${(r.sizeBytes / 1024 / 1024).toFixed(2)}</td>
  <td class="num">${r.tOpenMs >= 0 ? (r.tOpenMs / 1000).toFixed(2) : 'n/a'}</td>
  <td class="v">${escHtml(r.verify)}</td>
  <td class="detail">${escHtml(r.verifyDetail || '')}</td>
  <td>${r.beforeShot ? `<a href="${escHtml(r.beforeShot)}">before</a>` : '—'} /
      ${r.afterShot ? `<a href="${escHtml(r.afterShot)}">after</a>` : '—'}</td>
</tr>`).join('\n');
    return `<!doctype html><html><head><meta charset="utf-8"/>
<title>CV Bulk Open — test/samples/ignored/</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:1100px;margin:1.5rem auto;padding:0 1rem;color:#222}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border:1px solid #ddd;padding:5px 8px;vertical-align:top}
th{background:#f4f4f4;text-align:left}
td.num{text-align:right;font-variant-numeric:tabular-nums}
td.file{font-family:monospace;font-size:12px}
td.v{text-align:center;font-weight:600}
tr.pass td.v{background:#dfd;color:#0a4d0a}
tr.fail td.v{background:#fdd;color:#7d0a0a}
td.detail{color:#666;font-size:12px;max-width:380px}
.meta{color:#666;font-size:13px;margin-bottom:1rem}
</style></head><body>
<h1>CV Bulk Open — test/samples/ignored/</h1>
<div class="meta">Generated ${escHtml(new Date().toISOString())} · Wall: ${(walltimeMs / 1000).toFixed(1)}s
 · Base: ${escHtml(BASE)} · Files: ${(allFiles || results).length} · Run: ${results.length}
 · Pass: <strong style="color:#0a4d0a">${passed}</strong>
 · Fail: <strong style="color:#7d0a0a">${results.length - passed}</strong></div>
<table><thead><tr>
  <th>#</th><th>File</th><th>Fmt</th><th>Size (MiB)</th><th>Open (s)</th>
  <th>Verify</th><th>Detail</th><th>Shots</th>
</tr></thead><tbody>
${rows}
</tbody></table></body></html>`;
}

(async () => {
    log('=== cv-bulk-open-ignored — discovery ===');
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const files = listFiles();
    if (!files.length) {
        log(`No corpus at ${SAMPLES_DIR} (gitignored, local-only) — skipping. Exit 0.`);
        fs.writeFileSync(REPORT_PATH, renderReport([], 0, []));
        process.exit(0);
    }
    log(`Found ${files.length} files in ${SAMPLES_DIR}`);
    log('viewer: ' + BASE);

    const wallStart = Date.now();
    const { browser } = await launch({ headless: 'new' });
    const results = [];
    try {
        for (let i = 0; i < files.length; i++) {
            let r;
            try { r = await openAndTypeOne(browser, files[i], i + 1); }
            catch (e) {
                r = { idx: i + 1, fileName: files[i], fmt: formatOf(files[i]), sizeBytes: 0,
                      tOpenMs: -1, verify: 'fail', verifyDetail: 'hard error: ' + (e.message || e),
                      beforeShot: '', afterShot: '' };
            }
            check(`open+type: ${r.fileName}`, r.verify === 'pass', r.verifyDetail);
            results.push(r);
            // Incremental report write so a mid-run crash leaves partial data.
            try { fs.writeFileSync(REPORT_PATH, renderReport(results, Date.now() - wallStart, files)); }
            catch (e) { log('partial-report write failed: ' + e.message); }
        }
    } finally {
        try { await browser.close(); } catch (e) {}
    }

    fs.writeFileSync(REPORT_PATH, renderReport(results, Date.now() - wallStart, files));
    log('\n=== summary ===');
    for (const r of results) {
        const t = r.tOpenMs >= 0 ? (r.tOpenMs / 1000).toFixed(2) + 's' : 'n/a';
        log(`  ${r.verify === 'pass' ? 'OK ' : 'X  '} ${t.padStart(8)} ${r.fmt.padEnd(4)} ${r.fileName}`);
    }
    const passed = results.filter(r => r.verify === 'pass').length;
    log(`pass: ${passed} / ${results.length}`);
    log(`Report: ${REPORT_PATH}`);
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    // ALWAYS exit 0 — per-file outcomes live in the report + log; this
    // local-only bulk run must never block a suite.
    process.exit(0);
})();
