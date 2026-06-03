const __cl = require('../../lib/inject-checklist');
// E2E copy/paste — ALL interactions via real keyboard and mouse.
// Runs in Xvfb + headful Chrome so native paste events fire correctly.
const { launch, sleep } = require('../../lib/browser');
const fs = require('fs'), path = require('path');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');
const VIEWER = env.FILE_STORAGE_URL;
const SHOTS = '/tmp/static-deploy/public/shots-e2e-copypaste';
const REPORT = '/tmp/static-deploy/public/reports/e2e-copypaste-detail.html';

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

    const { browser, cleanup } = await launch();
    try {
        // Upload a fresh test doc (v2 encrypted upload)
        const docName = 'e2e-cp-' + Date.now() + '.docx';
        const bytes = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx'));
        const { b64urlSecret, fileId } = await uploadV2(VIEWER, docName, bytes);

        const page = await browser.newPage();
        const cdp = await page.createCDPSession();
        await cdp.send('Browser.grantPermissions', {
            permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
        });
        await page.setViewport({ width: 1280, height: 900 });
        await page.goto(VIEWER + '/#file=' + b64urlSecret, { waitUntil: 'domcontentloaded' });

        // Wait for editor to fully load
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
        if (!editorFrame) { console.log('ERROR: no editor'); await cleanup(); process.exit(1); }

        // Wait for relay activation
        for (let i = 0; i < 60; i++) {
            const ready = await editorFrame.evaluate(() =>
                typeof globalThis.TheFakeWebSocket !== 'undefined').catch(() => false);
            if (ready) break;
            await sleep(500);
        }
        await sleep(5000);

        // ── DOM inspection helpers (read-only, no side effects) ──────
        function charCount(s) {
            const m = s && s.match(/(\d+) characters/);
            return m ? parseInt(m[1]) : -1;
        }
        async function getWc() {
            return editorFrame.evaluate(() =>
                document.querySelector('#StateWordCount')?.textContent?.trim() || ''
            ).catch(() => '');
        }
        let stepNum = 0;
        const report = [];
        async function snap(name) {
            stepNum++;
            const f = `${String(stepNum).padStart(2, '0')}_${name}.png`;
            await page.screenshot({ path: `${SHOTS}/${f}` });
            return f;
        }
        async function logStep(title) {
            const wc = await getWc();
            const shot = await snap(title.replace(/[^a-z0-9]/gi, '_'));
            const cc = charCount(wc);
            report.push({ title, wc, shot, cc });
            console.log(`  [${title}] ${wc} (${cc} chars)`);
            return cc;
        }

        // ── Keyboard/mouse helpers (all via page.keyboard/mouse) ─────
        async function clickEditor() {
            const frameEl = await page.$('iframe#editor-frame');
            if (frameEl) {
                const box = await frameEl.boundingBox();
                if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            }
            await sleep(500);
        }

        // Click editor to focus
        await clickEditor();

        // ═══ STEP 0: Initial state ═══
        const cc0 = await logStep('Initial');

        // ═══ STEP 1: Type "HELLO " via real keyboard ═══
        console.log('\n--- STEP 1: Type "HELLO " ---');
        await clickEditor();
        await page.keyboard.type('HELLO ', { delay: 80 });
        await sleep(3000);
        const cc1 = await logStep('After_type');
        check('STEP1 type: +6', cc1 - cc0 === 6, 'delta=' + (cc1 - cc0));

        // ═══ STEP 2: Select All (Ctrl+A) → Copy (Ctrl+C) ═══
        console.log('\n--- STEP 2: Ctrl+A → Ctrl+C ---');
        await clickEditor();
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await sleep(1000);
        await page.keyboard.down('Control');
        await page.keyboard.press('c');
        await page.keyboard.up('Control');
        await sleep(3000);
        const cc2 = await logStep('After_copy');
        check('STEP2 copy: count unchanged', cc2 === cc1);

        // Verify clipboard was populated (DOM read only)
        const clipAfterCopy = await editorFrame.evaluate(async () => {
            try {
                var items = await navigator.clipboard.read();
                var types = [];
                for (var it of items) for (var t of it.types) types.push(t);
                return { types };
            } catch(e) { return { error: e.message }; }
        });
        check('STEP2 clipboard populated', clipAfterCopy.types && clipAfterCopy.types.length > 0,
            'types=' + JSON.stringify(clipAfterCopy.types || []));

        // ═══ STEP 3: Deselect → End → Ctrl+V (internal paste) ═══
        console.log('\n--- STEP 3: Ctrl+End → Ctrl+V (internal paste) ---');
        await clickEditor();
        // Deselect first: Ctrl+End, then press Right to clear selection
        await page.keyboard.down('Control');
        await page.keyboard.press('End');
        await page.keyboard.up('Control');
        await sleep(300);
        await page.keyboard.press('End'); // plain End deselects and stays at end
        await sleep(500);
        const ccPre3 = charCount(await getWc());
        await page.keyboard.down('Control');
        await page.keyboard.press('v');
        await page.keyboard.up('Control');
        await sleep(8000);
        const cc3 = await logStep('After_internal_paste');
        check('STEP3 internal paste: delta > 0', cc3 > ccPre3, 'delta=' + (cc3 - ccPre3));

        // ═══ STEP 4: External plain text paste (from "Notepad") ═══
        console.log('\n--- STEP 4: External text paste ---');
        // Set system clipboard to plain text only (no HTML) — simulates
        // copying from a terminal or plain text editor
        await page.evaluate(async () => {
            await navigator.clipboard.write([new ClipboardItem({
                'text/plain': new Blob(['FROM_NOTEPAD'], { type: 'text/plain' }),
            })]);
        });
        await sleep(500);
        await clickEditor();
        await page.keyboard.down('Control');
        await page.keyboard.press('End');
        await page.keyboard.up('Control');
        await sleep(500);
        const ccPre4 = charCount(await getWc());
        await page.keyboard.down('Control');
        await page.keyboard.press('v');
        await page.keyboard.up('Control');
        await sleep(8000);
        const cc4 = await logStep('After_external_text_paste');
        check('STEP4 external text: +12', cc4 - ccPre4 === 12, 'delta=' + (cc4 - ccPre4));
        check('STEP4 no double paste', cc4 - ccPre4 <= 20, 'delta=' + (cc4 - ccPre4));

        // ═══ STEP 5: External HTML paste (from "Word") ═══
        console.log('\n--- STEP 5: External HTML paste ---');
        await page.evaluate(async () => {
            await navigator.clipboard.write([new ClipboardItem({
                'text/html': new Blob(['<b>BOLD_TEXT</b>'], { type: 'text/html' }),
                'text/plain': new Blob(['BOLD_TEXT'], { type: 'text/plain' }),
            })]);
        });
        await sleep(500);
        await clickEditor();
        await page.keyboard.down('Control');
        await page.keyboard.press('End');
        await page.keyboard.up('Control');
        await sleep(500);
        const ccPre5 = charCount(await getWc());
        await page.keyboard.down('Control');
        await page.keyboard.press('v');
        await page.keyboard.up('Control');
        await sleep(8000);
        const cc5 = await logStep('After_external_html_paste');
        check('STEP5 external HTML: +9', cc5 - ccPre5 === 9, 'delta=' + (cc5 - ccPre5));

        // ═══ STEP 6: Internal copy+paste AFTER external paste ═══
        console.log('\n--- STEP 6: Internal copy+paste after external ---');
        await clickEditor();
        // Go to start
        await page.keyboard.down('Control');
        await page.keyboard.press('Home');
        await page.keyboard.up('Control');
        await sleep(500);
        // Select first word (Ctrl+Shift+Right)
        await page.keyboard.down('Control');
        await page.keyboard.down('Shift');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.up('Shift');
        await page.keyboard.up('Control');
        await sleep(500);
        // Copy
        await page.keyboard.down('Control');
        await page.keyboard.press('c');
        await page.keyboard.up('Control');
        await sleep(3000);
        // Move to end
        await page.keyboard.down('Control');
        await page.keyboard.press('End');
        await page.keyboard.up('Control');
        await sleep(500);
        const ccPre6 = charCount(await getWc());
        // Paste
        await page.keyboard.down('Control');
        await page.keyboard.press('v');
        await page.keyboard.up('Control');
        await sleep(8000);
        const cc6 = await logStep('After_internal_paste_after_ext');
        check('STEP6 internal paste after external: delta > 0', cc6 > ccPre6, 'delta=' + (cc6 - ccPre6));

        // ═══ STEP 7: External image paste (from "Paint") ═══
        console.log('\n--- STEP 7: External image paste ---');
        await clickEditor();
        await page.keyboard.down('Control');
        await page.keyboard.press('End');
        await page.keyboard.up('Control');
        await sleep(500);
        const ccPre7 = charCount(await getWc());
        // Put a 1x1 PNG on the system clipboard (with empty text to
        // clear any leftover text from previous clipboard writes)
        await page.evaluate(async () => {
            var b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
            var raw = atob(b64);
            var bytes = new Uint8Array(raw.length);
            for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
            await navigator.clipboard.write([new ClipboardItem({
                'image/png': new Blob([bytes], { type: 'image/png' }),
                'text/plain': new Blob([''], { type: 'text/plain' }),
            })]);
        });
        await sleep(500);
        await page.keyboard.down('Control');
        await page.keyboard.press('v');
        await page.keyboard.up('Control');
        await sleep(8000);
        const cc7 = await logStep('After_image_paste');
        check('STEP7 image paste: no text double-paste', Math.abs(cc7 - ccPre7) <= 2,
            'delta=' + (cc7 - ccPre7));

        // ═══ Generate report ═══
        let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>E2E Copy/Paste</title>
<style>body{font-family:-apple-system,sans-serif;max-width:960px;margin:0 auto;padding:2rem;background:#fafafa}
h1{font-size:1.5rem;border-bottom:2px solid #e5e7eb;padding-bottom:8px}
h2{font-size:1rem;margin-top:1.5rem;border-top:1px solid #eee;padding-top:8px}
.result{background:${allPassed ? '#dcfce7' : '#fee2e2'};padding:12px;border-radius:8px;font-weight:600;margin:1rem 0}
img{max-width:100%;border:1px solid #d1d5db;border-radius:4px;margin:8px 0}
.state{background:#f0f0f3;padding:6px 12px;border-radius:4px;font-size:13px;margin:4px 0;font-family:monospace}
</style></head><body>
<h1>E2E Copy/Paste (Xvfb + headful Chrome, keyboard/mouse only)</h1>
<div class="result">${allPassed ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}</div>`;
        for (const r of report) {
            html += `<h2>${r.title}</h2><div class="state">${r.wc} (${r.cc} chars)</div>`;
            html += `<img src="../shots-e2e-copypaste/${r.shot}">`;
        }
        html += '</body></html>';
        fs.mkdirSync(path.dirname(REPORT), { recursive: true });
        fs.writeFileSync(REPORT, html);
        console.log('\nReport: https://wasm.atgpartners.info/reports/e2e-copypaste-detail.html');
        console.log(allPassed ? 'ALL PASSED' : 'SOME CHECKS FAILED');
    } finally {
        await cleanup();
    }
    process.exit(allPassed ? 0 : 1);
})();
