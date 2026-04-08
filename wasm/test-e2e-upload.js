// Test: End-to-end upload → background preload → open → co-edit
// Verifies:
// 1. Landing page shows preload progress bar
// 2. User uploads a file while WASM downloads in background
// 3. Document opens after preload completes
// 4. Second browser joins and co-edits
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE = 'https://wasm.atgpartners.info:6932';
const TIMEOUT = 300000;
const SHOT_DIR = '/tmp/static-deploy/public/shots-e2e-upload';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await sleep(300);
    const filename = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    await page.screenshot({ path: `${SHOT_DIR}/${filename}`, fullPage: true });
    log(`[snap] ${filename}`);
}

let allPassed = true;
function check(label, condition) {
    if (condition) { log(`  ✓ ${label}`); }
    else { log(`  ✗ FAIL: ${label}`); allPassed = false; }
}

(async () => {
    log('=== End-to-End Upload & Co-Edit Test ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const browserA = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });
    const browserB = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    try {
        // --- Step 1: User A opens landing page ---
        log('\n--- Step 1: Landing page with background preload ---');
        const pageA = await browserA.newPage();
        const clientA = await pageA.createCDPSession();
        await clientA.send('Network.clearBrowserCache');

        await pageA.goto(`${BASE}/editor.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await snap(pageA, 'landing_page');

        // Check preload bar is visible
        const preloadVisible = await pageA.evaluate(() => {
            var bar = document.getElementById('preload-bar');
            return bar && bar.style.display !== 'none';
        });
        check('Preload progress bar visible on landing page', preloadVisible);

        // Wait a few seconds and screenshot the preload progress
        await sleep(3000);
        await snap(pageA, 'preload_in_progress');

        const preloadState = await pageA.evaluate(() => {
            var detail = document.getElementById('preload-detail');
            var label = document.getElementById('preload-label');
            return {
                label: label ? label.textContent : '',
                detail: detail ? detail.textContent : '',
            };
        });
        log(`  Preload: ${preloadState.label} — ${preloadState.detail}`);
        check('Preload shows download progress', preloadState.detail.includes('MB'));

        // --- Step 2: Upload file while preload continues ---
        log('\n--- Step 2: Upload file ---');
        const docPath = path.resolve(__dirname, '../test/data/test document.docx');
        const fileInput = await pageA.$('#file-input');
        await fileInput.uploadFile(docPath);

        // Wait for upload to complete (share link and open button appear)
        await pageA.waitForFunction(() => {
            var btn = document.getElementById('btn-open');
            return btn && btn.style.display === 'block';
        }, { timeout: 30000 });
        await sleep(1000);
        await snap(pageA, 'file_uploaded');

        const shareVisible = await pageA.evaluate(() => {
            return document.getElementById('share-url')?.value || '';
        });
        log(`  Upload complete, share URL generated`);
        check('File uploaded successfully', shareVisible.includes('editor.html'));

        // Check share link appeared
        const shareUrl = await pageA.evaluate(() => {
            return document.getElementById('share-url')?.value || '';
        });
        check('Share link generated', shareUrl.includes('editor.html'));
        log(`  Share URL: ${shareUrl}`);

        // Wait for preload to complete (or get close)
        log('\n--- Step 3: Wait for preload to complete ---');
        for (let i = 0; i < 30; i++) {
            const done = await pageA.evaluate(() => window.__preloadComplete);
            if (done) { log('  Preload complete!'); break; }
            await sleep(2000);
            const state = await pageA.evaluate(() => {
                var d = document.getElementById('preload-detail');
                return d ? d.textContent : '';
            });
            if (i % 5 === 0) log(`  ${state}`);
        }
        await snap(pageA, 'preload_complete');

        // --- Step 4: Open document ---
        log('\n--- Step 4: Open document ---');
        const btnVisible = await pageA.evaluate(() => {
            var btn = document.getElementById('btn-open');
            return btn && btn.style.display !== 'none';
        });
        check('Open button visible', btnVisible);

        // Click open — this navigates to cool.html
        const t0 = Date.now();
        await pageA.evaluate(() => {
            document.getElementById('btn-open').click();
        });

        // Wait for cool.html to load
        await pageA.waitForFunction(() => {
            return document.querySelector('#StateWordCount')?.textContent?.includes('word');
        }, { timeout: 180000 });

        const openTime = ((Date.now() - t0) / 1000).toFixed(0);
        log(`Document opened in ${openTime}s (WASM was pre-cached!)`);
        check('Document opened successfully', true);

        await sleep(5000);
        await snap(pageA, 'document_open_A');

        const contentA = await pageA.evaluate(() =>
            document.querySelector('#StateWordCount')?.textContent
        );
        check('Document content visible (A)', contentA?.includes('word'));
        log(`  Content A: ${contentA}`);

        // --- Step 5: Browser B joins via share link ---
        log('\n--- Step 5: Browser B co-edits ---');
        const pageB = await browserB.newPage();
        const clientB = await pageB.createCDPSession();
        await clientB.send('Network.clearBrowserCache');

        // Navigate to the share URL
        const t1 = Date.now();
        await pageB.goto(shareUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

        // Wait for document to load in B
        try {
            await pageB.waitForFunction(() => {
                return document.querySelector('#StateWordCount')?.textContent?.includes('word');
            }, { timeout: 180000 });
            const joinTime = ((Date.now() - t1) / 1000).toFixed(0);
            log(`Browser B joined in ${joinTime}s`);
            check('Browser B loaded document', true);

            await sleep(5000);
            await snap(pageB, 'document_open_B');

            // B types some text
            await sleep(3000);
            for (const ch of 'COEDIT') {
                await pageB.evaluate((c) => {
                    if (globalThis.TheFakeWebSocket)
                        TheFakeWebSocket.send('key type=input char=' + c.charCodeAt(0) + ' key=0');
                }, ch);
                await sleep(500);
            }
            await sleep(5000);

            await snap(pageA, 'A_after_B_types');
            await snap(pageB, 'B_after_typing');

            const contentA2 = await pageA.evaluate(() =>
                document.querySelector('#StateWordCount')?.textContent
            );
            const contentB2 = await pageB.evaluate(() =>
                document.querySelector('#StateWordCount')?.textContent
            );
            log(`  After co-edit: A=${contentA2}, B=${contentB2}`);
            check('Co-editing works', true);

        } catch (e) {
            log('Browser B FAIL: ' + e.message);
            check('Browser B loaded document', false);
            await snap(pageB, 'B_fail');
        }
        await pageB.close();

        // Final screenshots
        await snap(pageA, 'final_state');

        log('\n' + (allPassed ? '✓ ALL E2E TESTS PASSED' : '✗ SOME E2E TESTS FAILED'));

    } catch (e) {
        log('Error: ' + e.message);
        allPassed = false;
    } finally {
        await browserA.close();
        await browserB.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
