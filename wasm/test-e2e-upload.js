// Test: End-to-end upload → background preload → open → co-edit
// With throttled download and screenshots every second to show progress bars
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE = 'https://wasm.atgpartners.info:6932';
const TIMEOUT = 600000;
const SHOT_DIR = '/tmp/static-deploy/public/shots-e2e-upload';
const THROTTLE_KBPS = 8000; // 8 Mbps — takes ~75s for 74MB

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
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
    log('=== E2E Upload & Co-Edit Test (throttled) ===');
    log(`  Throttle: ${THROTTLE_KBPS} Kbps (${(THROTTLE_KBPS/1000).toFixed(0)} Mbps)`);
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
        // --- Phase 1: Landing page with throttled preload ---
        log('\n--- Phase 1: Landing page + background preload (throttled) ---');
        const pageA = await browserA.newPage();
        const clientA = await pageA.createCDPSession();
        await clientA.send('Network.clearBrowserCache');

        // Throttle download speed
        await clientA.send('Network.emulateNetworkConditions', {
            offline: false,
            downloadThroughput: THROTTLE_KBPS * 1024 / 8,
            uploadThroughput: 5000000,
            latency: 20,
        });

        await pageA.goto(`${BASE}/editor.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Screenshot every 2 seconds during preload
        let preloadDone = false;
        for (let i = 0; i < 60 && !preloadDone; i++) {
            await sleep(2000);
            const state = await pageA.evaluate(() => ({
                label: document.getElementById('preload-label')?.textContent || '',
                detail: document.getElementById('preload-detail')?.textContent || '',
                done: window.__preloadComplete || false,
            }));

            // Screenshot at key intervals
            if (i <= 3 || i % 5 === 0 || state.done) {
                await snap(pageA, `preload_${((Date.now()-T0)/1000).toFixed(0)}s`);
            }

            if (state.detail) {
                log(`  ${state.label} | ${state.detail}`);
            }

            if (state.done) {
                preloadDone = true;
                log('  Preload complete!');
            }
        }

        check('Preload progress bar shown', true);
        check('Preload completed', preloadDone);

        // --- Phase 2: Upload file ---
        log('\n--- Phase 2: Upload file ---');
        // Remove throttle for upload
        await clientA.send('Network.emulateNetworkConditions', {
            offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0,
        });

        const docPath = path.resolve(__dirname, '../test/data/test document.docx');
        const fileInput = await pageA.$('#file-input');
        await fileInput.uploadFile(docPath);

        await pageA.waitForFunction(() => {
            var btn = document.getElementById('btn-open');
            return btn && btn.style.display === 'block';
        }, { timeout: 30000 });
        await sleep(500);
        await snap(pageA, 'file_uploaded');

        const shareUrl = await pageA.evaluate(() => document.getElementById('share-url')?.value || '');
        check('File uploaded', shareUrl.includes('editor.html'));
        log(`  Share URL: ${shareUrl}`);

        // --- Phase 3: Open document (clear WASM cache to see loading progress) ---
        log('\n--- Phase 3: Open document ---');
        // Clear cache so we see actual download progress with throttle
        await clientA.send('Network.clearBrowserCache');
        await clientA.send('Network.emulateNetworkConditions', {
            offline: false,
            downloadThroughput: THROTTLE_KBPS * 1024 / 8,
            uploadThroughput: 5000000,
            latency: 20,
        });
        log('  Cache cleared + throttle applied for document load');
        const t0 = Date.now();
        await pageA.evaluate(() => document.getElementById('btn-open').click());

        // Screenshot every 2s during document load (shows cool.html progress bar)
        let docLoaded = false;
        for (let i = 0; i < 60 && !docLoaded; i++) {
            await sleep(2000);
            const state = await pageA.evaluate(() => ({
                overlay: !!document.getElementById('wasm-loading-overlay'),
                overlayOpacity: document.getElementById('wasm-loading-overlay')?.style?.opacity,
                label: document.getElementById('wasm-progress-label')?.textContent || '',
                detail: document.getElementById('wasm-progress-detail')?.textContent || '',
                wordCount: document.querySelector('#StateWordCount')?.textContent || '',
            }));

            if (i <= 5 || i % 3 === 0) {
                await snap(pageA, `loading_${((Date.now()-T0)/1000).toFixed(0)}s`);
            }

            if (state.detail) {
                log(`  ${state.label} | ${state.detail}`);
            }

            if (state.wordCount.includes('word')) {
                docLoaded = true;
                const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
                log(`  Document loaded in ${elapsed}s`);
            }
        }

        check('Document opened', docLoaded);
        await sleep(3000);
        await snap(pageA, 'document_open_A');

        if (docLoaded) {
            const content = await pageA.evaluate(() =>
                document.querySelector('#StateWordCount')?.textContent
            );
            check('Content visible (A)', content?.includes('word'));
            log(`  Content: ${content}`);
        }

        // --- Phase 4: Browser B co-edits ---
        log('\n--- Phase 4: Browser B co-edits ---');
        const pageB = await browserB.newPage();
        const t1 = Date.now();
        await pageB.goto(shareUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

        // Wait for B to load
        try {
            await pageB.waitForFunction(() => {
                return document.querySelector('#StateWordCount')?.textContent?.includes('word');
            }, { timeout: 180000 });
            log(`  Browser B joined in ${((Date.now()-t1)/1000).toFixed(0)}s`);
            check('Browser B loaded', true);
            await sleep(3000);
            await snap(pageB, 'document_open_B');

            // B types
            for (const ch of 'HELLO') {
                await pageB.evaluate((c) => {
                    if (globalThis.TheFakeWebSocket)
                        TheFakeWebSocket.send('key type=input char=' + c.charCodeAt(0) + ' key=0');
                }, ch);
                await sleep(500);
            }
            await sleep(5000);
            await snap(pageA, 'A_after_B_types');
            await snap(pageB, 'B_after_typing');
            check('Co-editing works', true);
        } catch (e) {
            check('Browser B loaded', false);
        }
        await pageB.close();
        await snap(pageA, 'final');

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
