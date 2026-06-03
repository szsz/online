const __cl = require('../../lib/inject-checklist');
// Regression: HTML <table> paste → docx <w:tbl> round-trip.
//
// Gap (ai/tasks/in-progress/paste-table-html-roundtrip): no existing
// clipboard test exercises table paste. External apps (Gmail, Word,
// browser-rendered tables, Google Sheets) routinely put `<table>` in
// text/html — wasm-loader's paste handler writes the HTML straight to
// the kit via `paste mimetype=text/html\n<bytes>`, and the kit runs
// its HTML import filter. If that filter regresses on tables, the
// only signal is user reports. This test catches it.
//
// Approach (all REAL puppeteer mouse + keyboard, no sendUnoCommand,
// no `page.evaluate(()=>el.click())`):
//   CASE 1. Build a 2×2 HTML table, write it to navigator.clipboard
//           via page.evaluate (clipboard population is the legitimate
//           way to seed an external paste — this is data setup, NOT
//           a UI shortcut). Then real keyboard Ctrl+End + Ctrl+V.
//           Assert charcount increased by ≥ 16 (4 cells × ≥4 chars).
//   CASE 2. Save via real Ctrl+S keystroke. Download via downloadV2.
//           Use the system `unzip` binary to extract `word/document.xml`
//           from the docx. Assert it contains `<w:tbl`, at least 2
//           `<w:tr`, at least 4 `<w:tc`, and the cell content strings.
//
// Cases 3 (nested) and 4 (Sheets-style) are deferred — the task
// description marks 3 as a tolerated soft-fail and 4 as the most
// user-impacting but harder to mock authentically. Add when 1+2 are
// proven on dev.

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer');
const env = require('../../lib/test-env');
const { uploadV2, downloadV2 } = require('../../lib/v2-upload');
const { evalInFrame, waitInFrame } = require('../../lib/two-tab');

const VIEWER  = env.FILE_STORAGE_URL;
const FIXTURE = path.join(__dirname, '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-paste-table';

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

const TABLE_HTML = `<html><body><table border="1">
<tr><td>R1C1</td><td>R1C2</td></tr>
<tr><td>R2C1</td><td>R2C2</td></tr>
</table></body></html>`;
const TABLE_PLAIN = 'R1C1\tR1C2\nR2C1\tR2C2';

(async () => {
    log('=== Regression: HTML <table> paste → docx <w:tbl> round-trip ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(FIXTURE)) {
        log(`SKIP: fixture missing: ${FIXTURE}`);
        process.exit(2);
    }

    const bytes = fs.readFileSync(FIXTURE);
    const name  = `paste-table-${Date.now()}.docx`;
    const up    = await uploadV2(VIEWER, name, bytes);
    log(`uploaded ${name}`);

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });
    try {
        const page = await browser.newPage();
        const cdp = await page.createCDPSession();
        await cdp.send('Browser.grantPermissions', {
            permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
        });
        await page.setViewport({ width: 1280, height: 900 });

        await page.goto(`${VIEWER}/#file=${up.b64urlSecret}`,
            { waitUntil: 'domcontentloaded',
              timeout: env.scaleTimeout(120000) });

        // Wait for editor + doc-loaded.
        let frame = null;
        for (let i = 0; i < 90 && !frame; i++) {
            frame = page.frames().find(f => f.url().includes('cool.html'));
            if (frame && !(await frame.$('#document-canvas').catch(() => null))) frame = null;
            if (!frame) await sleep(1000);
        }
        if (!frame) throw new Error('editor frame never loaded');
        await waitInFrame(page,
            () => window.__wasmInitialDocLoaded === true,
            { timeout: env.scaleTimeout(60000) });
        await waitInFrame(page,
            () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''),
            { timeout: env.scaleTimeout(30000) });
        await sleep(3000);
        await snap(page, 'loaded');

        const readChars = () => evalInFrame(page, () => {
            const t = document.querySelector('#StateWordCount')?.textContent || '';
            const m = t.match(/(\d+)\s+character/i);
            return m ? parseInt(m[1], 10) : -1;
        }).catch(() => -1);
        const wc0 = await readChars();
        log(`initial #StateWordCount: ${wc0}`);

        // Seed the system clipboard with the HTML table — this is
        // legitimate data setup for an external-paste test (mimics the
        // user having copied a table from Gmail / Word / a browser).
        await page.evaluate(async ({ html, plain }) => {
            const item = new ClipboardItem({
                'text/html':  new Blob([html],  { type: 'text/html' }),
                'text/plain': new Blob([plain], { type: 'text/plain' }),
            });
            await navigator.clipboard.write([item]);
        }, { html: TABLE_HTML, plain: TABLE_PLAIN });
        log('clipboard primed with 2×2 HTML table');

        // Click into the doc canvas to place the caret (no specific
        // coordinate needed — anywhere inside #document-canvas works
        // since the fixture's body is empty enough that any caret lands
        // in editable space). Then move to end + paste.
        const canvasBox = await evalInFrame(page, () => {
            const c = document.querySelector('#document-canvas');
            if (!c) return null;
            const r = c.getBoundingClientRect();
            return { x: r.left, y: r.top, w: r.width, h: r.height };
        });
        await page.mouse.click(canvasBox.x + canvasBox.w/2, canvasBox.y + 200);
        await sleep(500);
        await page.keyboard.down('Control');
        await page.keyboard.press('End');
        await page.keyboard.up('Control');
        await sleep(400);
        await snap(page, 'before_paste');

        // Real Ctrl+V — drives wasm-loader's document.onpaste handler,
        // which reads ev.clipboardData and forwards
        // `paste mimetype=text/html\n<bytes>` to the kit.
        await page.keyboard.down('Control');
        await page.keyboard.press('v');
        await page.keyboard.up('Control');
        await sleep(3000);
        await snap(page, 'after_paste');

        const wcAfterPaste = await readChars();
        log(`after-paste #StateWordCount: ${wcAfterPaste}`);
        // 4 cells × 4 chars = 16. Allow up to 64 for whitespace padding.
        // A regression where cells get serialized as inline text with
        // separators would land somewhere in (4..64); a regression where
        // the table is dropped entirely lands at 0.
        check('CASE 1: paste increased char count by 16–64 (table content landed)',
              wcAfterPaste - wc0 >= 16 && wcAfterPaste - wc0 <= 64,
              `delta=${wcAfterPaste - wc0}`);

        // CASE 2 — save + download + unzip + grep document.xml.
        log('--- saving via Ctrl+S + waiting for checkpoint ---');
        await page.keyboard.down('Control');
        await page.keyboard.press('s');
        await page.keyboard.up('Control');
        // The viewer-side save flow uploads a checkpoint asynchronously;
        // poll until downloadV2's size differs from the original or 30 s
        // elapses (the original new.docx is ~12 KB; with a table the
        // saved docx will be 1-2 KB larger).
        const initialBytes = bytes.length;
        let savedBytes = null;
        for (let i = 0; i < 30; i++) {
            await sleep(1000);
            try {
                const d = await downloadV2(VIEWER, up.secret || up.secretBuf || up.secretBuffer);
                if (d.bytes.length !== initialBytes) {
                    savedBytes = d.bytes;
                    log(`download succeeded after ${i+1}s, size=${d.bytes.length} (was ${initialBytes})`);
                    break;
                }
            } catch (e) {
                log(`download attempt ${i+1} failed: ${e.message.substring(0, 80)}`);
            }
        }
        check('CASE 2: saved docx download succeeded + size differs from original',
              savedBytes !== null,
              savedBytes ? `len=${savedBytes.length}` : 'no save observed');

        if (savedBytes) {
            // Write to /tmp + extract document.xml via system unzip.
            const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-table-'));
            const docxPath = path.join(tmp, 'saved.docx');
            fs.writeFileSync(docxPath, savedBytes);
            let documentXml = '';
            try {
                documentXml = execFileSync('unzip',
                    ['-p', docxPath, 'word/document.xml'],
                    { maxBuffer: 16 * 1024 * 1024 }).toString();
            } catch (e) {
                log(`unzip failed: ${e.message.substring(0, 200)}`);
            }
            try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

            check('CASE 2: word/document.xml contains <w:tbl',
                  documentXml.indexOf('<w:tbl') >= 0,
                  documentXml.length === 0 ? 'document.xml empty' : 'present');

            const trCount = (documentXml.match(/<w:tr[ >\/]/g) || []).length;
            const tcCount = (documentXml.match(/<w:tc[ >\/]/g) || []).length;
            check('CASE 2: ≥ 2 <w:tr (table rows)',
                  trCount >= 2, `count=${trCount}`);
            check('CASE 2: ≥ 4 <w:tc (table cells)',
                  tcCount >= 4, `count=${tcCount}`);

            const hasR1C1 = documentXml.indexOf('R1C1') >= 0;
            const hasR2C2 = documentXml.indexOf('R2C2') >= 0;
            check('CASE 2: cell content R1C1 + R2C2 round-tripped',
                  hasR1C1 && hasR2C2,
                  `R1C1=${hasR1C1} R2C2=${hasR2C2}`);
        }

        log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    } finally {
        await browser.close();
    }

    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e.stack || e.message);
    process.exit(2);
});
