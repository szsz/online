const __cl = require('../../lib/inject-checklist');
// Regression: Bug iter 26 — preformatted style buttons in the
// notebookbar's #stylesview render visually stacked on top of one
// another instead of in distinct grid cells.
//
// Root cause (browser/css/notebookbar.css:584-591, pre-fix):
//   grid-template-rows: repeat(auto-fit, minmax(33px, 1fr));
// defines an *explicit* row template. The container's height is pinned
// to --notebookbar-element-height (~64px), so only one explicit row
// fits — every entry past the first lands in the implicit grid (default
// grid-auto-rows: auto) and stamps into the same cell. With row-gap: 0
// the visible result is N entries whose bounding rectangles overlap.
//
// Fix: drop the explicit grid-template-rows and use
//   grid-auto-rows: 33px;
//   grid-auto-flow: row;
// so the implicit grid gives each entry its own 33-px row and the
// container's overflow:auto handles overflow.
//
// This test asserts that no two visible .ui-iconview-entry rectangles
// inside #stylesview overlap (allowing 1 px tolerance for sub-pixel
// rounding). With the bug the entries collapse onto rect#0 → all pairs
// overlap.

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

const VIEWER  = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-stylesview-overlap';
const DOC_NAME = 'stylesview-overlap-' + Date.now() + '.docx';
const DOC_PATH = path.join(__dirname, '..', 'test', 'data', 'new.docx');

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch (e) {}
}

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  PASS: ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

async function getEditorFrame(page, fileId) {
    return page.frames().find(f =>
        f.url().includes('cool.html') && (!fileId || f.url().includes(fileId)));
}
async function getStatus(frame) {
    if (!frame) return '';
    try {
        return await frame.evaluate(() =>
            document.querySelector('#StateWordCount')?.textContent?.trim() || '');
    } catch (e) { return ''; }
}

(async () => {
    log('=== Regression iter 26: stylesview entries do not overlap ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(DOC_PATH)) {
        log('ERROR: fixture missing: ' + DOC_PATH);
        process.exit(1);
    }

    const { browser, cleanup } = await launch({ width: 1920, height: 1080 });
    try {
        const bytes = fs.readFileSync(DOC_PATH);
        const up = await uploadV2(VIEWER, DOC_NAME, bytes);
        log(`Uploaded ${DOC_NAME} (${(bytes.length / 1024).toFixed(1)} KB)`);

        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        page.on('pageerror', e => log(`[pageerror] ${e.message}`));

        const url = VIEWER + '/?singleuser&planc=1#file=' + up.b64urlSecret;
        log(`Navigating to ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

        let frame = null;
        const deadline = Date.now() + 240000;
        while (Date.now() < deadline) {
            await sleep(500);
            frame = await getEditorFrame(page, up.fileId);
            if (!frame) continue;
            const st = await getStatus(frame);
            if (/\d+\s+character/i.test(st)) break;
        }
        check('Editor frame loaded', frame && /\d+\s+character/i.test(await getStatus(frame)));
        if (!frame) throw new Error('editor frame never loaded');

        // Notebookbar takes another moment to render the iconview entries
        // after the doc is loaded — they're populated from the kit's
        // .uno:StyleApply state-change message.
        await sleep(5000);
        await snap(page, 'editor_loaded');

        const result = await frame.evaluate(() => {
            const root = document.getElementById('stylesview');
            if (!root) return { error: 'no #stylesview' };
            const entries = Array.from(root.querySelectorAll('.ui-iconview-entry'));
            if (!entries.length) return { error: 'no entries' };
            const rects = entries.map(el => {
                const r = el.getBoundingClientRect();
                return {
                    id: el.id,
                    x: Math.round(r.left), y: Math.round(r.top),
                    w: Math.round(r.width), h: Math.round(r.height),
                };
            });
            // Find every overlapping pair, with 1px tolerance for sub-pixel rounding.
            const TOL = 1;
            function overlaps(a, b) {
                const aRight = a.x + a.w, aBottom = a.y + a.h;
                const bRight = b.x + b.w, bBottom = b.y + b.h;
                if (aRight - TOL <= b.x || bRight - TOL <= a.x) return false;
                if (aBottom - TOL <= b.y || bBottom - TOL <= a.y) return false;
                return true;
            }
            const overlapping = [];
            for (let i = 0; i < rects.length; i++) {
                for (let j = i + 1; j < rects.length; j++) {
                    if (overlaps(rects[i], rects[j])) {
                        overlapping.push([rects[i], rects[j]]);
                    }
                }
            }
            const cs = window.getComputedStyle(root);
            return {
                rects, overlapping,
                gridTemplateRows: cs.gridTemplateRows,
                gridAutoRows: cs.gridAutoRows,
                gridTemplateColumns: cs.gridTemplateColumns,
            };
        }).catch(e => ({ error: 'eval failed: ' + e.message }));

        if (result.error) {
            check('stylesview readable', false, result.error);
            throw new Error('cannot probe stylesview: ' + result.error);
        }
        log(`grid-template-rows = ${result.gridTemplateRows}`);
        log(`grid-auto-rows     = ${result.gridAutoRows}`);
        log(`entries: ${result.rects.length}`);
        for (const r of result.rects.slice(0, 6)) {
            log(`  ${r.id}: ${r.x},${r.y} ${r.w}x${r.h}`);
        }
        check('stylesview has multiple entries', result.rects.length >= 2,
              'count=' + result.rects.length);
        check('no entry rectangles overlap', result.overlapping.length === 0,
              result.overlapping.length
                ? 'first overlap: ' +
                  result.overlapping[0][0].id + ' vs ' + result.overlapping[0][1].id
                : '0 overlapping pairs');

        await snap(page, 'stylesview_layout');
    } catch (e) {
        log('Error: ' + e.message);
        allPassed = false;
    } finally {
        await cleanup();
        log(allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED');
        process.exit(allPassed ? 0 : 1);
    }
})();
