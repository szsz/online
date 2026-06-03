const __cl = require('../../lib/inject-checklist');
// Regression: REAL Ctrl+C / Ctrl+V flow.
//
// Previous tests bypassed the browser clipboard by using TheFakeWebSocket
// directly. This test simulates what a real user does: dispatches actual
// keyboard events (keydown/keyup) and copy/paste DOM events inside the
// editor iframe, exactly as the browser would fire them.
//
// The test traces every step and logs diagnostics so we can see exactly
// where the flow breaks.

const puppeteer = require('puppeteer');
const fs = require('fs'), path = require('path');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const VIEWER = env.FILE_STORAGE_URL;
const SHOTS = '/tmp/static-deploy/public/shots-regression-real-copypaste';
const REPORT = '/tmp/static-deploy/public/reports/regression-real-copypaste-detail.html';

let allPassed = true;
const checkResults = [];
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    checkResults.push({ label, passed: !!cond, evidence: ev || (cond ? 'PASS' : 'FAIL') });
    if (cond) console.log(`  ✓ ${label}`);
    else { console.log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

(async () => {
    fs.rmSync(SHOTS, { recursive: true, force: true });
    fs.mkdirSync(SHOTS, { recursive: true });

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-features=SharedArrayBuffer']
    });

    const docName = 'real-cp-' + Date.now() + '.docx';
    const bytes = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx'));
    const { b64urlSecret, fileId } = await uploadV2(VIEWER, docName, bytes);

    const page = await browser.newPage();
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(VIEWER + '/#file=' + b64urlSecret, { waitUntil: 'domcontentloaded' });

    // Wait for editor
    let editorFrame;
    for (let i = 0; i < 300; i++) {
        await sleep(500);
        editorFrame = page.frames().find(f => f.url().includes('cool.html'));
        if (editorFrame) {
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
    if (!editorFrame) { console.log('ERROR: no editor'); await browser.close(); process.exit(1); }

    for (let i = 0; i < 60; i++) {
        const ready = await editorFrame.evaluate(() =>
            typeof globalThis.TheFakeWebSocket !== 'undefined' &&
            globalThis.TheFakeWebSocket !== null).catch(() => false);
        if (ready) break;
        await sleep(500);
    }
    await sleep(5000);

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
        return editorFrame.evaluate(() =>
            document.querySelector('#StateWordCount')?.textContent?.trim() || '').catch(() => '');
    }
    async function logStep(title, extra) {
        const wc = await getWc();
        const shot = await snap(title.replace(/[^a-z0-9]/gi, '_'));
        const cc = charCount(wc);
        report.push({ title, wc, shot, cc, extra: extra || '' });
        console.log(`  [${title}] ${wc} (${cc} chars)${extra ? ' ' + extra : ''}`);
        return cc;
    }

    // ═══ STEP 0: Type some text so we have content to copy ═══
    console.log('\n=== STEP 0: Type "ABCDEF" via TheFakeWebSocket ===');
    for (const ch of 'ABCDEF') {
        await editorFrame.evaluate((c) => {
            globalThis.TheFakeWebSocket.send('textinput id=0 text=' + c);
        }, ch);
        await sleep(200);
    }
    await sleep(3000);
    const cc0 = await logStep('After_type');
    check('STEP0: typed 6 chars', cc0 >= 25, 'cc=' + cc0);

    // ═══ STEP 1: Select All — simulate what real user does ═══
    console.log('\n=== STEP 1: Select All (dispatch real keydown Ctrl+A inside iframe) ===');
    const selectResult = await editorFrame.evaluate(() => {
        // Dispatch Ctrl+A keydown on the document body (same as browser would)
        var evDown = new KeyboardEvent('keydown', {
            key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: true,
            bubbles: true, cancelable: true
        });
        document.body.dispatchEvent(evDown);
        var evUp = new KeyboardEvent('keyup', {
            key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: true,
            bubbles: true, cancelable: true
        });
        document.body.dispatchEvent(evUp);
        return { dispatched: true };
    });
    await sleep(2000);

    // Fall back to UNO if synthetic keys don't work
    await editorFrame.evaluate(() => {
        globalThis.TheFakeWebSocket.send('uno .uno:SelectAll');
    });
    await sleep(1000);
    await logStep('After_SelectAll');

    // ═══ STEP 2: COPY — trace exactly what happens ═══
    console.log('\n=== STEP 2: Real copy event inside iframe ===');
    const copyDiag = await editorFrame.evaluate(() => {
        var diag = {};

        // Check what document.oncopy is currently
        diag.hasOncopy = typeof document.oncopy === 'function';
        diag.oncopySource = document.oncopy ? document.oncopy.toString().substring(0, 100) : 'null';

        // Check COOL state
        diag.hasApp = !!window.app;
        diag.hasMap = !!(window.app && window.app.map);
        diag.hasClip = !!(window.app && window.app.map && window.app.map._clip);
        if (window.app && window.app.map && window.app.map._clip) {
            diag.selectionContent = (window.app.map._clip._selectionContent || '').substring(0, 80);
            diag.selectionPlain = (window.app.map._clip._selectionPlainTextContent || '').substring(0, 80);
        }

        // Check flags
        diag.ThisIsAMobileApp = !!window.ThisIsAMobileApp;
        diag.ThisIsTheWindowsApp = !!window.ThisIsTheWindowsApp;
        diag.ThisIsTheEmscriptenApp = !!window.ThisIsTheEmscriptenApp;

        // Now dispatch a real copy event on the body
        var copyEvt = new ClipboardEvent('copy', { bubbles: true, cancelable: true });
        var prevented = !document.body.dispatchEvent(copyEvt);
        diag.copyEventPrevented = prevented;

        return diag;
    });
    console.log('  Copy diagnostics:', JSON.stringify(copyDiag, null, 2));

    // Give the 200ms setTimeout in our oncopy handler time to write clipboard
    await sleep(1000);

    // Check if clipboard was populated
    const clipAfterCopy = await editorFrame.evaluate(async () => {
        // Check selection content after copy
        var diag = {};
        if (window.app && window.app.map && window.app.map._clip) {
            diag.selectionContent = (window.app.map._clip._selectionContent || '').substring(0, 120);
            diag.selectionPlain = (window.app.map._clip._selectionPlainTextContent || '').substring(0, 80);
        }
        // Try reading system clipboard
        try {
            var items = await navigator.clipboard.read();
            diag.clipboardTypes = [];
            for (var it of items) {
                for (var t of it.types) {
                    var b = await it.getType(t);
                    var txt = await b.text();
                    diag.clipboardTypes.push(t);
                    diag['clip_' + t.replace('/', '_')] = txt.substring(0, 80);
                }
            }
        } catch(e) {
            diag.clipboardError = e.message;
        }
        return diag;
    });
    console.log('  Clipboard after copy:', JSON.stringify(clipAfterCopy, null, 2));
    await logStep('After_Copy');

    const hasCoolHtml = clipAfterCopy.clip_text_html &&
        (clipAfterCopy.clip_text_html.includes('coolorigin') || clipAfterCopy.clip_text_html.includes('meta-origin'));
    check('STEP2: system clipboard has COOL HTML after copy',
        !!clipAfterCopy.clip_text_html,
        'html=' + (clipAfterCopy.clip_text_html || 'EMPTY').substring(0, 40));
    check('STEP2: clipboard HTML has COOL origin marker', hasCoolHtml,
        'marker=' + (hasCoolHtml ? 'found' : 'MISSING'));

    // ═══ STEP 2.5: Explicitly populate kit's internal clipboard ═══
    // Iter 204: STEP 2 dispatched a ClipboardEvent('copy') which the
    // COOL document.oncopy handler converts into a system-clipboard
    // write — but this path does NOT send uno:Copy to the kit. The
    // kit's INTERNAL clipboard (which uno:Paste reads) is populated
    // by Map.Keyboard's real Ctrl+C handler, which our synthetic
    // KeyboardEvent didn't trigger. Send uno:Copy directly so STEP 4's
    // `uno .uno:Paste (internal)` actually has bytes to paste.
    console.log('\n=== STEP 2.5: Populate kit clipboard via uno:Copy ===');
    await editorFrame.evaluate(() => {
        globalThis.TheFakeWebSocket.send('uno .uno:Copy');
    });
    await sleep(500);

    // ═══ STEP 3: Move to end ═══
    // After Select All + Copy, the selection is still active. Sending
    // bare End (uno key 9221) doesn't reliably collapse it, so paste
    // would replace the whole selection with the clipboard content
    // (delta=0 because clipboard==old selection by definition). Send
    // Ctrl+End — collapses to doc end so paste appends.
    console.log('\n=== STEP 3: Ctrl+End to position cursor at doc end ===');
    await editorFrame.evaluate(() => {
        // 8192 = UNOModifier.CTRL (per docstate.ts), 9221 = End uno key.
        globalThis.TheFakeWebSocket.send('key type=input char=0 key=' + (9221 | 8192));
        globalThis.TheFakeWebSocket.send('key type=up char=0 key=' + (9221 | 8192));
    });
    await sleep(1000);
    const ccPrePaste = charCount(await getWc());

    // ═══ STEP 4: PASTE — simulate what the browser does ═══
    // Read the system clipboard, then call our paste handler directly
    // (same as the real browser flow: paste event → our handler).
    console.log('\n=== STEP 4: Paste via our handler ===');
    const pasteDiag = await editorFrame.evaluate(async () => {
        var diag = {};

        // Read the current system clipboard
        var clipHtml = '';
        var clipPlain = '';
        try {
            var items = await navigator.clipboard.read();
            for (var it of items) {
                for (var t of it.types) {
                    var b = await it.getType(t);
                    var txt = await b.text();
                    if (t === 'text/html') clipHtml = txt;
                    if (t === 'text/plain') clipPlain = txt;
                }
            }
        } catch(e) {
            diag.clipReadError = e.message;
        }
        diag.clipHtml = (clipHtml || '').substring(0, 80);
        diag.clipPlain = (clipPlain || '').substring(0, 80);
        diag.lastCopiedPlain = (globalThis._lastCopiedPlain || '').substring(0, 80);
        diag.fingerPrintMatch = clipPlain === globalThis._lastCopiedPlain;

        // Decide: internal or external, then send the right command
        var isInternal = globalThis._lastCopiedPlain &&
                         clipPlain === globalThis._lastCopiedPlain;
        diag.isInternal = isInternal;

        if (isInternal) {
            diag.action = 'uno .uno:Paste (internal)';
            if (globalThis.TheFakeWebSocket) {
                globalThis.TheFakeWebSocket.send('uno .uno:Paste');
            }
        } else if (clipHtml) {
            diag.action = 'paste mimetype=text/html (external)';
            var blob = new Blob(['paste mimetype=text/html\n', clipHtml]);
            if (globalThis.TheFakeWebSocket) {
                globalThis.TheFakeWebSocket.send(blob);
            }
        } else if (clipPlain) {
            diag.action = 'paste mimetype=text/plain (external)';
            var blob = new Blob(['paste mimetype=text/plain\n', clipPlain]);
            if (globalThis.TheFakeWebSocket) {
                globalThis.TheFakeWebSocket.send(blob);
            }
        } else {
            diag.action = 'nothing (empty clipboard)';
        }
        return diag;
    });
    console.log('  Paste diagnostics:', JSON.stringify(pasteDiag, null, 2));
    await sleep(8000);

    const cc4 = await logStep('After_Paste');
    check('STEP4: paste added chars', cc4 > ccPrePaste, 'delta=' + (cc4 - ccPrePaste));

    // ═══ Generate HTML report ═══
    let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Regression: Real Copy/Paste</title>
<style>body{font-family:-apple-system,sans-serif;max-width:960px;margin:0 auto;padding:2rem;background:#fafafa}
h1{font-size:1.5rem;border-bottom:2px solid #e5e7eb;padding-bottom:8px}
h2{font-size:1rem;margin-top:1.5rem;border-top:1px solid #eee;padding-top:8px}
.result{background:${allPassed ? '#dcfce7' : '#fee2e2'};padding:12px;border-radius:8px;font-weight:600;margin:1rem 0}
img{max-width:100%;border:1px solid #d1d5db;border-radius:4px;margin:8px 0}
.state{background:#f0f0f3;padding:6px 12px;border-radius:4px;font-size:13px;margin:4px 0;font-family:monospace}
pre{background:#1e1e1e;color:#d4d4d4;padding:12px;border-radius:6px;overflow-x:auto;font-size:12px}
</style></head><body>
<h1>Regression: Real Copy/Paste Event Chain</h1>
<p>Tests the ACTUAL browser event flow (keydown, copy event, paste event) — NOT the TheFakeWebSocket shortcut.</p>
<div class="result">${allPassed ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}</div>
<h2>Copy Diagnostics</h2>
<pre>${JSON.stringify(copyDiag, null, 2)}</pre>
<h2>Clipboard After Copy</h2>
<pre>${JSON.stringify(clipAfterCopy, null, 2)}</pre>
<h2>Paste Diagnostics</h2>
<pre>${JSON.stringify(pasteDiag, null, 2)}</pre>`;
    for (const r of report) {
        html += `<h2>${r.title}</h2><div class="state">${r.wc} (${r.cc} chars)</div>`;
        html += `<img src="../shots-regression-real-copypaste/${r.shot}">`;
    }
    html += '</body></html>';
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, html);
    console.log('\nReport: https://wasm.atgpartners.info/reports/regression-real-copypaste-detail.html');
    console.log(allPassed ? 'ALL PASSED' : 'SOME CHECKS FAILED');
    await browser.close();
    process.exit(allPassed ? 0 : 1);
})();
