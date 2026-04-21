// Test: Open a file during/after cold prewarm.
// Reproduces the bug where clicking a file before prewarm completes
// caused a hot-switch attempt on an uninitialized editor, hanging forever.
// The fix: prewarm with Execute() skipped does NOT set prewarmReady,
// so openFile always takes the cold-reload path for the first file.

const { launch, sleep } = require('./lib/browser');
const fs = require('fs');
const env = require('./lib/test-env');

const VIEWER = env.VIEWER_URL || 'http://localhost:6934';
const BASE = env.EDITOR_URL;
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
    function check(label, ok) {
        if (ok) log(`  ✓ ${label}`);
        else { log(`  ✗ FAIL: ${label}`); passed = false; }
    }

    try {
        // Open the viewer with a deep-linked file — this tests the
        // "open file on cold start" path (no prewarm ready yet).
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });

        const logs = [];
        page.on('console', msg => {
            const t = msg.text();
            logs.push(t);
            if (t.includes('TIMING') || t.includes('cold') || t.includes('prewarm') ||
                t.includes('switchdoc') || t.includes('Activation'))
                log(`[browser] ${t}`);
        });

        // Upload a test file to the editor first
        const docName = 'cold-open-test.docx';
        const samplePath = '/tmp/static-deploy/.wasm-docs/cache-test.docx';
        if (fs.existsSync(samplePath)) {
            const up = await browser.newPage();
            await up.goto(BASE, { waitUntil: 'networkidle0', timeout: 30000 });
            const bytes = fs.readFileSync(samplePath);
            await up.evaluate(async (url, name, arr) => {
                await fetch(url + '/wasm/' + encodeURIComponent(name), {
                    method: 'POST', body: new Blob([new Uint8Array(arr)])
                });
            }, BASE, docName, Array.from(bytes));
            await up.close();
            log(`Uploaded ${docName}`);
        }

        // Clear snapshot so this is a true cold start
        await page.goto(BASE + '/browser/favicon.ico').catch(() => {});
        await page.evaluate(() => caches.delete('wasm-snapshot').catch(() => {}));
        log('Snapshot cleared');

        // Navigate to viewer with deep link
        log('=== Opening viewer with deep-linked file ===');
        await page.goto(VIEWER + '/#file=' + encodeURIComponent(docName), {
            waitUntil: 'domcontentloaded', timeout: 30000
        });
        log('Viewer loaded');
        await snap(page, 'viewer_loaded');

        // Wait for the document to become ready (up to 120s for cold start)
        log('Waiting for document ready...');
        let ready = false;
        for (let i = 0; i < 120; i++) {
            const docReady = logs.some(l => l.includes('Document ready:'));
            if (docReady) { ready = true; break; }
            await sleep(1000);
            if (i % 10 === 9) log(`  Still waiting... (${i + 1}s)`);
        }

        await snap(page, 'final');

        check('Document became ready', ready);

        // Verify it took the cold-reload path (not hot-switch)
        const usedColdReload = logs.some(l => l.includes('cold reload'));
        const usedHotSwitch = logs.some(l => l.includes('switchdoc_seen'));
        check('Used cold-reload path (not hot-switch)', usedColdReload || !usedHotSwitch);

        // Verify no "PostMessage ignored" errors
        const postMsgIgnored = logs.some(l => l.includes('PostMessage ignored'));
        check('No "PostMessage ignored" errors', !postMsgIgnored);

        // Verify no stuck activation
        const stuckActivation = logs.filter(l => l.includes('Activation pending')).length;
        check('No excessive activation pending messages', stuckActivation < 5);

        log('');
        if (passed) {
            log('✓ COLD OPEN TEST PASSED');
        } else {
            log('✗ COLD OPEN TEST FAILED');
            process.exitCode = 1;
        }

    } catch (err) {
        log('FAIL: ' + err.message);
        console.error(err);
        process.exitCode = 1;
    } finally {
        await cleanup();
    }
})();
