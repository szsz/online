// Test: Loading progress bar with throttled download speed
// Verifies:
// 1. Progress bar shows during loading
// 2. Per-resource progress bars visible (WASM, data, bundle)
// 3. Download size and speed displayed
// 4. Progress bar disappears after document loads
// Takes screenshots at different progress stages with artificially slow download.
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE = 'https://wasm.atgpartners.info:6932';
const SHOT_DIR = '/tmp/static-deploy/public/shots-progress';
const THROTTLE_KBPS = 5000; // 2 Mbps — slow enough to see progress

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
    log('=== Loading Progress Bar Test ===');
    log(`  Download throttle: ${THROTTLE_KBPS} Kbps (${(THROTTLE_KBPS/1000).toFixed(0)} Mbps)`);
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    try {
        // Upload document
        const up = await browser.newPage();
        await up.goto(`${BASE}/editor.html`, { waitUntil: 'networkidle0' });
        const docPath = path.resolve(__dirname, '../test/data/test document.docx');
        const docBytes = fs.readFileSync(docPath);
        await up.evaluate(async (url, arr) => {
            await fetch(url + '/wasm/' + encodeURIComponent('test document.docx'), {
                method: 'POST', body: new Blob([new Uint8Array(arr)])
            });
        }, BASE, Array.from(docBytes));
        await up.close();
        log('Document uploaded');

        // --- Test with throttled speed ---
        log('\n--- Loading with throttled download ---');
        const page = await browser.newPage();
        const client = await page.createCDPSession();

        // Clear cache for fresh download
        await client.send('Network.clearBrowserCache');

        // Throttle network to see progress
        await client.send('Network.emulateNetworkConditions', {
            offline: false,
            downloadThroughput: THROTTLE_KBPS * 1024 / 8, // Convert Kbps to bytes/s
            uploadThroughput: 1000000,
            latency: 50,
        });
        log('Network throttled');

        const loadStart = Date.now();
        await page.goto(`${BASE}/browser/cool.html?WOPISrc=test%20document.docx&access_token=test`, {
            waitUntil: 'domcontentloaded', timeout: 600000,
        });

        // Take screenshots at intervals to show progress
        let progressStates = [];
        let docLoaded = false;

        for (let i = 0; i < 60 && !docLoaded; i++) {
            await sleep(3000);
            const elapsed = ((Date.now() - loadStart) / 1000).toFixed(0);

            const state = await page.evaluate(() => {
                var overlay = document.getElementById('wasm-loading-overlay');
                var label = document.getElementById('wasm-progress-label');
                var fill = document.getElementById('wasm-progress-bar-fill');
                var detail = document.getElementById('wasm-progress-detail');
                var resources = document.getElementById('wasm-progress-resources');
                var wordCount = document.querySelector('#StateWordCount');

                return {
                    overlayVisible: overlay && overlay.style.opacity !== '0',
                    label: label ? label.textContent : '',
                    barWidth: fill ? fill.style.width : '0%',
                    detail: detail ? detail.textContent : '',
                    resourceCount: resources ? resources.querySelectorAll('.wasm-res-row').length : 0,
                    resourcesHtml: resources ? resources.innerHTML.substring(0, 500) : '',
                    docLoaded: wordCount && wordCount.textContent && wordCount.textContent.includes('word'),
                };
            });

            progressStates.push({ elapsed, ...state });

            if (state.overlayVisible && state.detail) {
                log(`  ${elapsed}s: ${state.barWidth} - ${state.detail} (${state.resourceCount} resources)`);
            }

            // Take screenshot at key moments
            if (i === 1 || i === 3 || i === 7 || i === 15 || i === 25) {
                await snap(page, `progress_${elapsed}s`);
            }

            if (state.docLoaded) {
                docLoaded = true;
                log(`Document loaded at ${elapsed}s`);
            }
        }

        // Remove throttle for final steps
        await client.send('Network.emulateNetworkConditions', {
            offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0,
        });

        if (!docLoaded) {
            // Wait longer without throttle
            try {
                await page.waitForFunction(() => {
                    var el = document.querySelector('#StateWordCount');
                    return el && el.textContent && el.textContent.includes('word');
                }, { timeout: 120000 });
                docLoaded = true;
                log('Document loaded after throttle removed');
            } catch (e) {
                log('Document failed to load');
            }
        }

        // Final screenshot
        await sleep(3000);
        await snap(page, docLoaded ? 'document_loaded' : 'load_failed');

        // Verify progress bar behavior
        const hadOverlay = progressStates.some(s => s.overlayVisible);
        const hadDetail = progressStates.some(s => s.detail && s.detail.includes('MB'));
        const hadResources = progressStates.some(s => s.resourceCount > 0);
        const hadProgress = progressStates.some(s => s.barWidth && s.barWidth !== '0%');

        check('Progress overlay shown during loading', hadOverlay);
        check('Download size/speed displayed', hadDetail);
        check('Per-resource progress bars visible', hadResources);
        check('Progress bar advanced', hadProgress);
        check('Document loaded successfully', docLoaded);

        if (docLoaded) {
            const content = await page.evaluate(() => ({
                wordCount: document.querySelector('#StateWordCount')?.textContent,
                overlayGone: !document.getElementById('wasm-loading-overlay'),
            }));
            check('Progress bar removed after load', content.overlayGone);
            check('Document content visible', content.wordCount?.includes('word'));
            log(`  Content: ${content.wordCount}`);
        }

        // Log all captured states
        log('\n--- Progress timeline ---');
        for (const s of progressStates) {
            if (s.detail) {
                log(`  ${s.elapsed}s: ${s.barWidth} | ${s.detail} | ${s.resourceCount} resources`);
            }
        }

        await page.close();

        log('\n' + (allPassed ? '✓ ALL PROGRESS TESTS PASSED' : '✗ SOME PROGRESS TESTS FAILED'));

    } catch (e) {
        log('Error: ' + e.message);
        allPassed = false;
    } finally {
        await browser.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
