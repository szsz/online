// Test: Save conflict detection.
// 1. Upload and open a document
// 2. Type some content (creates unsaved changes)
// 3. Externally modify the file on storage via API (simulates another user)
// 4. Trigger Ctrl+S save
// 5. Check if COOL shows a conflict dialog or overwrites silently
// 6. Capture screenshots at each step
//
// Generates an HTML report at /tmp/static-deploy/public/reports/save-conflict-report.html

const puppeteer = require('puppeteer');
const { launch, sleep } = require('./lib/browser');
const env = require('./lib/test-env');
const fs = require('fs');
const path = require('path');

const BASE = env.EDITOR_URL;
const VIEWER = env.VIEWER_URL || 'https://viewer.szebeni.hu';
const REPORT_DIR = '/tmp/static-deploy/public/reports';
const DOC_NAME = 'conflict-test.docx';
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
const screenshots = [];
async function snap(page, name, caption) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const filename = `save-conflict-${String(++shotNum).padStart(2, '0')}_${name}.png`;
    await page.screenshot({ path: `${REPORT_DIR}/${filename}`, fullPage: true });
    log(`[snap] ${filename}`);
    screenshots.push({ name: filename, caption });
    return filename;
}

async function waitForEditor(page, timeoutMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const ready = await page.evaluate(() => !!(window.__wasmPrewarmReady));
        if (ready) return Date.now() - start;
        await sleep(500);
    }
    throw new Error('Editor did not become ready within ' + timeoutMs + 'ms');
}

async function getWordCount(page) {
    return page.evaluate(() => {
        const el = document.getElementById('StateWordCount');
        return el ? el.textContent : null;
    });
}

// Upload a file to the editor's WASM storage
async function uploadToEditor(page, name, content) {
    return page.evaluate(async (n, data) => {
        const resp = await fetch('/wasm/' + encodeURIComponent(n), {
            method: 'POST',
            body: new Uint8Array(data),
        });
        return resp.status;
    }, name, Array.from(content));
}

// Upload a file to the viewer's file storage (simulates external modification)
async function uploadToViewer(name, content) {
    const resp = await fetch(VIEWER + '/api/files/' + encodeURIComponent(name), {
        method: 'POST',
        body: content,
        headers: { 'Content-Type': 'application/octet-stream' },
    });
    return resp.status;
}

const findings = [];

(async () => {
    const { browser, cleanup } = await launch();
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        page.on('console', msg => {
            const text = msg.text();
            if (text.includes('conflict') || text.includes('Conflict') ||
                text.includes('documentconflict') || text.includes('error:') ||
                text.includes('save') || text.includes('Save')) {
                log(`[browser] ${text}`);
            }
        });
        page.on('pageerror', err => log(`[browser ERROR] ${err.message}`));

        // ── Step 1: Upload test document using an existing sample ──
        log('=== Step 1: Upload test document ===');
        // Use an existing docx from the WASM docs directory
        const samplePath = '/tmp/static-deploy/.wasm-docs/cache-test.docx';
        let blankBuf;
        if (fs.existsSync(samplePath)) {
            blankBuf = fs.readFileSync(samplePath);
        } else {
            // Fallback: use the test data
            blankBuf = fs.readFileSync(path.join(__dirname, '..', 'test', 'data', '3pages.odt'));
        }
        log(`Sample doc: ${blankBuf.length} bytes`);

        // Navigate to editor origin first so we can use fetch
        await page.goto(`${BASE}/browser/favicon.ico`).catch(() => {});
        await sleep(500);
        const uploadStatus = await uploadToEditor(page, DOC_NAME, blankBuf);
        log(`Uploaded ${DOC_NAME} to editor: HTTP ${uploadStatus}`);

        log('Viewer storage upload skipped (not needed for this test)');

        // ── Step 2: Open the document ──
        log('=== Step 2: Open document in editor ===');
        const url = `${BASE}/browser/cool.html?WOPISrc=${encodeURIComponent(DOC_NAME)}&access_token=test&lang=en`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
        const readyMs = await waitForEditor(page);
        log(`Editor ready in ${(readyMs / 1000).toFixed(1)}s`);
        await snap(page, 'loaded', 'Step 2: Document loaded in editor');

        // ── Step 3: Type some content ──
        log('=== Step 3: Type content ===');
        await sleep(2000);
        // Click in the document area
        await page.mouse.click(640, 450);
        await sleep(500);
        // Type some text
        await page.keyboard.type('Hello from the editor! This text was typed locally.', { delay: 30 });
        await sleep(2000);
        const wc1 = await getWordCount(page);
        log(`Word count after typing: ${wc1}`);
        await snap(page, 'typed', 'Step 3: Typed text in editor');
        findings.push(`After typing: word count = "${wc1}"`);

        // ── Step 4: Externally modify the file on storage ──
        log('=== Step 4: Externally modify file on storage ===');
        // Create a modified version — just upload a different blank docx
        // (In a real scenario this would be a completely different file version)
        const modifiedContent = new Uint8Array(blankBuf.length + 100);
        modifiedContent.set(new Uint8Array(blankBuf));
        // Append some garbage to make the file different
        for (let i = blankBuf.length; i < modifiedContent.length; i++) {
            modifiedContent[i] = Math.floor(Math.random() * 256);
        }

        // Upload modified file to the editor's WASM storage (overwriting the original)
        const modStatus = await uploadToEditor(page, DOC_NAME, modifiedContent);
        log(`Externally modified ${DOC_NAME} on editor storage: HTTP ${modStatus}`);
        findings.push(`External modification: uploaded ${modifiedContent.length} bytes (was ${blankBuf.length})`);

        log('External modification applied to editor storage');

        await snap(page, 'modified_externally', 'Step 4: File modified externally on storage');

        // ── Step 5: Trigger save (Ctrl+S) ──
        log('=== Step 5: Trigger Ctrl+S save ===');
        await page.keyboard.down('Control');
        await page.keyboard.press('s');
        await page.keyboard.up('Control');
        log('Sent Ctrl+S');

        // Wait for save response / conflict dialog
        await sleep(3000);
        await snap(page, 'after_save', 'Step 5: After Ctrl+S (3s wait)');

        // Check for conflict dialog
        const conflictDialog = await page.evaluate(() => {
            // Look for the COOL conflict dialog
            const dialogs = document.querySelectorAll('.lokdialog, .vex-dialog, [id*="conflict"], [class*="conflict"]');
            const alerts = document.querySelectorAll('.vex-overlay, .modal-dialog');
            const errorMsgs = [];
            // Check for error messages in the status bar or popups
            document.querySelectorAll('[class*="error"], [class*="alert"], [class*="warning"]').forEach(el => {
                if (el.textContent.trim()) errorMsgs.push(el.textContent.trim().substring(0, 200));
            });
            return {
                dialogCount: dialogs.length,
                alertCount: alerts.length,
                errorMessages: errorMsgs,
                hasConflict: document.body.innerHTML.includes('documentconflict') ||
                             document.body.innerHTML.includes('Document has been changed'),
            };
        });

        log(`Conflict dialog check: ${JSON.stringify(conflictDialog)}`);
        findings.push(`Conflict dialog found: ${conflictDialog.hasConflict}`);
        findings.push(`Dialogs: ${conflictDialog.dialogCount}, Alerts: ${conflictDialog.alertCount}`);
        if (conflictDialog.errorMessages.length > 0) {
            findings.push(`Error messages: ${conflictDialog.errorMessages.join('; ')}`);
        }

        // Wait more and check again
        await sleep(5000);
        await snap(page, 'after_save_8s', 'Step 5: After Ctrl+S (8s total)');

        // Check console for save-related messages
        const consoleSaveMessages = await page.evaluate(() => {
            // Check if there's a save toast or status change
            const toast = document.getElementById('save-toast');
            const statusBar = document.getElementById('StateWordCount');
            return {
                toastVisible: toast ? window.getComputedStyle(toast).opacity !== '0' : false,
                wordCount: statusBar ? statusBar.textContent : null,
            };
        });
        log(`Save status: ${JSON.stringify(consoleSaveMessages)}`);

        // ── Step 6: Try sending .uno:Save directly via postMobileMessage ──
        log('=== Step 6: Try .uno:Save via postMobileMessage ===');
        await page.evaluate(() => {
            if (window.postMobileMessage) {
                window.postMobileMessage('uno .uno:Save');
            }
        });
        await sleep(3000);
        await snap(page, 'after_uno_save', 'Step 6: After .uno:Save via postMobileMessage');

        // Final check for any dialogs/popups
        const finalCheck = await page.evaluate(() => {
            const body = document.body.innerHTML;
            return {
                hasConflictText: body.includes('conflict') || body.includes('Conflict'),
                hasChangedText: body.includes('changed in storage') || body.includes('Document has been changed'),
                hasOverwrite: body.includes('overwrite') || body.includes('Overwrite'),
                visibleDialogs: document.querySelectorAll('.lokdialog:not([style*="display: none"])').length,
            };
        });
        log(`Final check: ${JSON.stringify(finalCheck)}`);
        findings.push(`Final state: conflict=${finalCheck.hasConflictText}, changed=${finalCheck.hasChangedText}, overwrite=${finalCheck.hasOverwrite}`);

        await snap(page, 'final', 'Final state');

        // ── Generate HTML report ──
        const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Save Conflict Test Report</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
h1 { color: #333; border-bottom: 2px solid #e53935; padding-bottom: 10px; }
h2 { color: #1976D2; margin-top: 30px; }
.findings { background: white; border-radius: 8px; padding: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin: 20px 0; }
.findings li { margin: 8px 0; font-size: 14px; }
.screenshots { display: grid; grid-template-columns: repeat(auto-fit, minmax(500px, 1fr)); gap: 20px; margin: 20px 0; }
.shot { background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
.shot img { width: 100%; display: block; }
.shot .caption { padding: 10px; font-size: 14px; color: #333; text-align: center; font-weight: 500; }
.meta { color: #999; font-size: 12px; margin-top: 30px; border-top: 1px solid #ddd; padding-top: 10px; }
</style>
</head>
<body>
<h1>Save Conflict Test Report</h1>
<p>Generated: ${new Date().toLocaleString()}</p>
<p>Test: Open a document, type content, externally modify the file on storage, then trigger Ctrl+S. Check if COOL detects the conflict.</p>

<h2>Findings</h2>
<div class="findings">
<ul>
${findings.map(f => `<li>${f}</li>`).join('\n')}
</ul>
</div>

<h2>Screenshots</h2>
<div class="screenshots">
${screenshots.map(s => `<div class="shot"><img src="${s.name}" alt="${s.caption}"><div class="caption">${s.caption}</div></div>`).join('\n')}
</div>

<div class="meta">
<p>Test: test-save-conflict.js</p>
<p>In WASM mode, the WOPI storage is the local Emscripten VFS. Conflict detection relies on the WOPI host returning HTTP 409 on PutFile when timestamps mismatch. Since the WASM "host" is local, the standard conflict path may not trigger. This test documents the current behavior.</p>
</div>
</body>
</html>`;
        fs.writeFileSync(`${REPORT_DIR}/save-conflict-report.html`, html);
        log(`Report: ${REPORT_DIR}/save-conflict-report.html`);
        log('PASS: test-save-conflict completed (documented current behavior)');

    } catch (err) {
        log('FAIL: ' + err.message);
        console.error(err);
        process.exitCode = 1;
    } finally {
        await cleanup();
    }
})();
