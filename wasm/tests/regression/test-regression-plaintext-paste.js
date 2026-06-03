const __cl = require('../../lib/inject-checklist');
// Regression: pasting UNFORMATTED plain text into a Writer document.
//
// Scenario the user reported:
//   1. Copy plain text from a terminal / Notepad (no HTML on clipboard)
//   2. Ctrl+V into the WASM COOL Writer document
//   3. Nothing appears — paste silently fails
//
// This test reproduces the issue by trying every plain-text paste path:
//   A. Clipboard text/plain ONLY → Ctrl+V
//   B. Clipboard text/html + text/plain → Ctrl+V (control — the working path)
//   C. Clipboard text/plain ONLY (second time, verify consistency)
//   D. textinput as baseline (type characters directly)
//   E. Clipboard with rich HTML + text/plain → Ctrl+V
//   F. Clipboard text/html ONLY (no text/plain companion) → Ctrl+V

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs'), path = require('path');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');
const VIEWER = env.FILE_STORAGE_URL;
const SHOTS = '/tmp/static-deploy/public/shots-regression-plaintext-paste';
const REPORT = '/tmp/static-deploy/public/reports/regression-plaintext-paste-detail.html';

let allPassed = true;
const checkResults = [];
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    checkResults.push({ label, passed: !!cond, evidence: ev || (cond ? 'PASS' : 'FAIL') });
    if (cond) console.log(`  PASS: ${label}`);
    else { console.log(`  FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

(async () => {
    fs.rmSync(SHOTS, { recursive: true, force: true });
    fs.mkdirSync(SHOTS, { recursive: true });

    const { browser, cleanup } = await launch();

    // Upload a unique test doc via v2 (encrypted)
    const docName = 'plaintext-paste-' + Date.now() + '.docx';
    const docBytes = fs.readFileSync(path.join(__dirname, '..', 'test', 'data', 'new.docx'));
    const { b64urlSecret, fileId } = await uploadV2(VIEWER, docName, docBytes);

    const page = await browser.newPage();
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(VIEWER + '/#file=' + b64urlSecret, { waitUntil: 'domcontentloaded' });

    // Wait for editor to fully load. Re-resolve the iframe each tick:
    // the viewer's cold-reload path replaces #editor-frame with a new
    // <iframe> element, so a cached reference becomes stale.
    let editorFrame;
    for (let i = 0; i < 300; i++) {
        await sleep(500);
        editorFrame = page.frames().find(f => f.url().includes('cool.html'));
        if (editorFrame) {
            // Probe both __wasmPrewarmReady (set after the user doc is
            // painted) and the canvas. StateWordCount alone fires for
            // the prewarm-blank doc and races us into using the wrong
            // frame.
            const ready = await editorFrame.evaluate(() => !!window.__wasmPrewarmReady)
                .catch(() => false);
            if (ready) {
                const wc = await editorFrame.evaluate(() =>
                    document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
                if (/\d+\s+character/i.test(wc)) {
                    const canvasOk = await editorFrame.evaluate(() =>
                        !!document.querySelector('.leaflet-tile-container canvas, #document-container canvas')
                    ).catch(() => false);
                    if (canvasOk) break;
                }
            }
        }
    }
    if (!editorFrame) { console.log('ERROR: no editor'); await cleanup(); process.exit(1); }

    // Wait for TheFakeWebSocket
    for (let i = 0; i < 60; i++) {
        const ready = await editorFrame.evaluate(() =>
            typeof globalThis.TheFakeWebSocket !== 'undefined' &&
            globalThis.TheFakeWebSocket !== null).catch(() => false);
        if (ready) break;
        await sleep(500);
    }
    await sleep(5000);

    // Click the iframe canvas to focus for keyboard input
    async function clickCanvas() {
        const frameEl = await page.$('iframe#editor-frame');
        if (frameEl) {
            const box = await frameEl.boundingBox();
            if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        }
        await sleep(300);
    }

    let stepNum = 0;
    const report = [];
    async function snap(name) {
        stepNum++;
        const f = `${String(stepNum).padStart(2, '0')}_${name}.png`;
        await page.screenshot({ path: `${SHOTS}/${f}` });
        return f;
    }
    function charCount(s) { const m = s && s.match(/(\d+) characters/); return m ? parseInt(m[1]) : -1; }
    async function getWc() {
        // Re-resolve the iframe each call. Viewer recreates the editor
        // iframe on cold-reload (the path our `page.goto + #file=`
        // triggers when prewarm wasn't ready), so the editorFrame
        // captured during setup may be the now-detached prewarm-blank
        // frame whose StateWordCount still reads "0 characters" but
        // that the user-visible document never propagates to.
        const fr = page.frames().find(f => f.url().includes('cool.html'));
        if (!fr) return '';
        return fr.evaluate(() =>
            document.querySelector('#StateWordCount')?.textContent?.trim() || '').catch(() => '');
    }
    async function logStep(title) {
        const wc = await getWc();
        const shot = await snap(title.replace(/[^a-z0-9]/gi, '_'));
        const cc = charCount(wc);
        report.push({ title, wc, shot, cc });
        console.log(`  [${title}] ${wc} (${cc} chars)`);
        return cc;
    }

    // Set clipboard content and paste via Ctrl+V
    async function setClipboardAndPaste(clipboardItems) {
        await page.evaluate(async (items) => {
            var blobItems = {};
            for (var k in items) {
                blobItems[k] = new Blob([items[k]], { type: k });
            }
            await navigator.clipboard.write([new ClipboardItem(blobItems)]);
        }, clipboardItems);
        await clickCanvas();
        await page.keyboard.down('Control');
        await page.keyboard.press('v');
        await page.keyboard.up('Control');
    }

    // === STEP 0: Initial state ===
    console.log('\n=== STEP 0: Initial state ===');
    const cc0 = await logStep('Initial');

    // === TEST A: Clipboard text/plain ONLY -> Ctrl+V ===
    // This is what happens when someone copies plain text from a terminal
    // and presses Ctrl+V. Clipboard has only text/plain.
    console.log('\n=== TEST A: Clipboard text/plain ONLY -> Ctrl+V (12 chars: "PLAIN_TEXT_A") ===');
    // Move to end first
    await clickCanvas();
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    await sleep(500);
    const ccPreA = charCount(await getWc());
    await setClipboardAndPaste({ 'text/plain': 'PLAIN_TEXT_A' });
    await sleep(8000);
    const ccA = await logStep('After_paste_text_plain_only');
    check('TEST-A: text/plain-only clipboard paste adds 12 chars', ccA - ccPreA === 12,
        'delta=' + (ccA - ccPreA));

    // === TEST B: Clipboard text/html + text/plain -> Ctrl+V (control) ===
    // This is the "normal" paste path that works (e.g., copying from a web page).
    console.log('\n=== TEST B: Clipboard text/html + text/plain -> Ctrl+V (control, 12 chars: "HTML_TEXT_BB") ===');
    await clickCanvas();
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    await sleep(500);
    const ccPreB = charCount(await getWc());
    await setClipboardAndPaste({
        'text/html': '<p>HTML_TEXT_BB</p>',
        'text/plain': 'HTML_TEXT_BB',
    });
    await sleep(8000);
    const ccB = await logStep('After_paste_text_html_plus_plain');
    check('TEST-B: text/html+text/plain clipboard paste adds 12 chars (control)', ccB - ccPreB === 12,
        'delta=' + (ccB - ccPreB));

    // === TEST C: Clipboard text/plain ONLY again (consistency check) ===
    console.log('\n=== TEST C: Clipboard text/plain ONLY again (12 chars: "PLAIN_STR_CC") ===');
    await clickCanvas();
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    await sleep(500);
    const ccPreC = charCount(await getWc());
    await setClipboardAndPaste({ 'text/plain': 'PLAIN_STR_CC' });
    await sleep(8000);
    const ccC = await logStep('After_paste_text_plain_only_2');
    check('TEST-C: text/plain-only clipboard paste adds 12 chars (consistency)', ccC - ccPreC === 12,
        'delta=' + (ccC - ccPreC));

    // === TEST D: textinput as baseline (type characters via real keyboard) ===
    console.log('\n=== TEST D: Type via real keyboard as baseline (12 chars: "TEXTINPUT_DD") ===');
    await clickCanvas();
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    await sleep(500);
    const ccPreD = charCount(await getWc());
    await clickCanvas();
    await page.keyboard.type('TEXTINPUT_DD', { delay: 50 });
    await sleep(3000);
    const ccD = await logStep('After_keyboard_type_fallback');
    check('TEST-D: keyboard type adds 12 chars (baseline)', ccD - ccPreD === 12,
        'delta=' + (ccD - ccPreD));

    // === TEST E: Clipboard with rich HTML + text/plain -> Ctrl+V ===
    console.log('\n=== TEST E: Clipboard rich HTML + text/plain -> Ctrl+V (12 chars: "ONLY_PLAIN_E") ===');
    await clickCanvas();
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    await sleep(500);
    const ccPreE = charCount(await getWc());
    await setClipboardAndPaste({
        'text/html': '<html><body><b>ONLY_PLAIN_E</b></body></html>',
        'text/plain': 'ONLY_PLAIN_E',
    });
    await sleep(8000);
    const ccE = await logStep('After_clipboard_rich_html_paste');
    check('TEST-E: rich HTML clipboard paste adds 12 chars', ccE - ccPreE === 12,
        'delta=' + (ccE - ccPreE));

    // === TEST F: Clipboard text/html ONLY (no text/plain companion) -> Ctrl+V ===
    console.log('\n=== TEST F: Clipboard text/html ONLY -> Ctrl+V (12 chars: "BOTH_MIME_FF") ===');
    await clickCanvas();
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    await sleep(500);
    const ccPreF = charCount(await getWc());
    await setClipboardAndPaste({
        'text/html': '<p>BOTH_MIME_FF</p>',
    });
    await sleep(8000);
    const ccF = await logStep('After_clipboard_html_only');
    check('TEST-F: text/html-only clipboard paste adds 12 chars (control)', ccF - ccPreF === 12,
        'delta=' + (ccF - ccPreF));

    // === Generate HTML report ===
    let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Regression: Plain Text Paste</title>
<style>body{font-family:-apple-system,sans-serif;max-width:960px;margin:0 auto;padding:2rem;background:#fafafa}
h1{font-size:1.5rem;border-bottom:2px solid #e5e7eb;padding-bottom:8px}
h2{font-size:1rem;margin-top:1.5rem;border-top:1px solid #eee;padding-top:8px}
.pass{color:#16a34a;font-weight:600}.fail{color:#dc2626;font-weight:600}
.result{background:${allPassed ? '#dcfce7' : '#fee2e2'};padding:12px;border-radius:8px;font-weight:600;margin:1rem 0}
img{max-width:100%;border:1px solid #d1d5db;border-radius:4px;margin:8px 0}
.state{background:#f0f0f3;padding:6px 12px;border-radius:4px;font-size:13px;margin:4px 0;font-family:monospace}
table{width:100%;border-collapse:collapse;margin:1rem 0}
th,td{text-align:left;padding:8px 12px;border:1px solid #e5e7eb}
th{background:#f8f9fa;font-size:0.85rem;color:#666}
.pass-cell{background:#dcfce7;color:#16a34a;font-weight:600}
.fail-cell{background:#fee2e2;color:#dc2626;font-weight:600}
</style></head><body>
<h1>Regression: Unformatted Plain Text Paste</h1>
<p>Tests whether pasting plain text (without HTML formatting) into a Writer document works.</p>
<div class="result">${allPassed ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED — plain text paste is broken'}</div>

<h2>Summary</h2>
<table>
<thead><tr><th>Test</th><th>Path</th><th>Expected</th><th>Result</th></tr></thead>
<tbody>`;

    const tests = [
        { id: 'A', name: 'text/plain-only clipboard + Ctrl+V', path: 'navigator.clipboard.write({text/plain}) + Ctrl+V' },
        { id: 'B', name: 'text/html+text/plain clipboard + Ctrl+V (control)', path: 'navigator.clipboard.write({text/html, text/plain}) + Ctrl+V' },
        { id: 'C', name: 'text/plain-only clipboard + Ctrl+V (consistency)', path: 'navigator.clipboard.write({text/plain}) + Ctrl+V' },
        { id: 'D', name: 'keyboard type (baseline)', path: 'page.keyboard.type() via real keyboard' },
        { id: 'E', name: 'rich HTML + text/plain clipboard + Ctrl+V', path: 'navigator.clipboard.write({text/html, text/plain}) + Ctrl+V' },
        { id: 'F', name: 'text/html-only clipboard + Ctrl+V', path: 'navigator.clipboard.write({text/html}) + Ctrl+V' },
    ];
    for (let i = 0; i < tests.length; i++) {
        const t = tests[i];
        const chk = checkResults.find(c => c.label.startsWith('TEST-' + t.id));
        const passed = chk ? chk.passed : false;
        const ev = chk ? chk.evidence : '?';
        const cls = passed ? 'pass-cell' : 'fail-cell';
        html += `<tr><td>TEST-${t.id}: ${t.name}</td><td><code>${t.path}</code></td><td>+12 chars</td><td class="${cls}">${ev}</td></tr>`;
    }
    html += '</tbody></table>';

    for (const r of report) {
        html += `<h2>${r.title}</h2><div class="state">${r.wc} (${r.cc} chars)</div>`;
        html += `<img src="../shots-regression-plaintext-paste/${r.shot}">`;
    }
    html += '</body></html>';
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, html);
    console.log('\nReport: https://wasm.atgpartners.info/reports/regression-plaintext-paste-detail.html');
    console.log(allPassed ? 'ALL PASSED' : 'SOME CHECKS FAILED');
    await cleanup();
    process.exit(allPassed ? 0 : 1);
})();
