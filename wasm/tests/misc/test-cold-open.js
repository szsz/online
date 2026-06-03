// Test: Open a file during/after cold prewarm.
// Reproduces the bug where clicking a file before prewarm completes
// caused a hot-switch attempt on an uninitialized editor, hanging forever.
// The fix: prewarm with Execute() skipped does NOT set prewarmReady,
// so openFile always takes the cold-reload path for the first file.
//
// Migrated to the viewer flow (lib/open-via-viewer.js).

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { openViaViewer } = require('../../lib/open-via-viewer');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-cold-open';
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const fn = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    await page.screenshot({ path: `${SHOT_DIR}/${fn}` });
    log(`[snap] ${fn}`);
}

(async () => {
    const { browser, cleanup } = await launch();
    let passed = true;
    function check(label, ok, ev) {
        if (ok) log(`  ✓ ${label}`);
        else { log(`  ✗ FAIL: ${label}` + (ev ? ` (${ev})` : '')); passed = false; }
    }

    try {
        // Use a real fixture from test/data — the original
        // /tmp/static-deploy/.wasm-docs/ path is the old
        // editor-static upload-staging dir, gone with the FD migration.
        const fixturePath = path.join(__dirname, '..', 'test', 'data',
            fs.existsSync(path.join(__dirname, '..', 'test', 'data', 'cache-test.docx'))
                ? 'cache-test.docx'
                : 'new.docx');
        const bytes = fs.readFileSync(fixturePath);
        const docName = path.basename(fixturePath);

        const logs = [];
        log('=== Opening viewer with deep-linked file (cold start) ===');
        const { page, editorFrame } = await openViaViewer(browser, VIEWER,
            docName, bytes,
            { viewport: { width: 1280, height: 900 },
              gotoTimeout: 30000,
              iframeTimeout: env.scaleTimeout(60000),
              onPage: p => {
                  p.on('console', msg => {
                      const t = msg.text();
                      logs.push(t);
                      if (t.includes('TIMING') || t.includes('cold') ||
                          t.includes('prewarm') || t.includes('switchdoc') ||
                          t.includes('Activation'))
                          log(`[browser] ${t}`);
                  });
              },
            });
        log('Viewer loaded + editor iframe attached');
        await snap(page, 'viewer_loaded');

        // Wait for the document to be ready inside the editor iframe.
        // Look for Document ready: log OR concrete status-bar content.
        log('Waiting for document ready...');
        let ready = false;
        for (let i = 0; i < 120; i++) {
            if (logs.some(l => l.includes('Document ready:'))) { ready = true; break; }
            const ok = await editorFrame.evaluate(() => {
                const wc = document.querySelector('#StateWordCount')?.textContent || '';
                return /\d+\s+(word|character)/.test(wc);
            }).catch(() => false);
            if (ok) { ready = true; break; }
            await sleep(1000);
            if (i % 10 === 9) log(`  Still waiting... (${i + 1}s)`);
        }
        await snap(page, 'final');
        check('Document became ready', ready);

        // Verify it took the cold-reload path (not hot-switch) — heuristic
        // based on the console traces wasm-loader emits.
        const usedHotSwitch = logs.some(l => l.includes('switchdoc_seen'));
        check('Did NOT use hot-switch path', !usedHotSwitch);

        // PostMessage-ignored count is fragile; allow up to 10 (parent
        // posts before COOL's WOPI handler arms WOPIPostmessageReady).
        // Threshold widened from 5 → 10 post-viewer-flow migration: the
        // new path issues a few additional postMessages during the
        // EditorBridge stage / SW-bridge handshake. Anything >10 still
        // suggests the ready flag never flipped (the real regression).
        const postMsgIgnored = logs.filter(l => l.includes('PostMessage ignored')).length;
        check('No excessive "PostMessage ignored" errors (<=10)',
              postMsgIgnored <= 10, 'count=' + postMsgIgnored);

        // No stuck activation.
        const stuckActivation = logs.filter(l => l.includes('Activation pending')).length;
        check('No excessive activation-pending log lines', stuckActivation < 5);

        log('');
        if (passed) log('✓ COLD OPEN TEST PASSED');
        else { log('✗ COLD OPEN TEST FAILED'); process.exitCode = 1; }
    } catch (err) {
        log('FAIL: ' + err.message);
        console.error(err);
        process.exitCode = 1;
    } finally {
        await cleanup();
    }
})();
