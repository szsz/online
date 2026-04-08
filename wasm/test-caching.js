// Test: Caching, compression, and load time comparison
// Verifies:
// 1. Brotli compression on WASM and data files
// 2. Immutable cache headers on large assets
// 3. No-cache on HTML
// 4. First visit: document loads with content visible, progress bar works
// 5. Return visit: resources served from cache, document content loads, time comparison
const puppeteer = require('puppeteer');
const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE = 'https://wasm.atgpartners.info:6932';
const SHOT_DIR = '/tmp/static-deploy/public/shots-caching';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await sleep(500);
    const filename = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    await page.screenshot({ path: `${SHOT_DIR}/${filename}`, fullPage: true });
    log(`[snap] ${filename}`);
}

function httpHead(url, headers) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const req = https.request({
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname,
            method: 'HEAD',
            headers: headers || {},
            rejectUnauthorized: false,
        }, (res) => resolve({ status: res.statusCode, headers: res.headers }));
        req.on('error', reject);
        req.end();
    });
}

let allPassed = true;
function check(label, condition) {
    if (condition) { log(`  ✓ ${label}`); }
    else { log(`  ✗ FAIL: ${label}`); allPassed = false; }
}

(async () => {
    log('=== Caching & Compression Tests ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    // === Test 1: Brotli compression ===
    log('\n--- Test 1: Brotli compression ---');
    const wasmResp = await httpHead(`${BASE}/browser/online.wasm`, { 'Accept-Encoding': 'br' });
    check('WASM brotli: Content-Encoding=br', wasmResp.headers['content-encoding'] === 'br');
    check('WASM brotli: correct Content-Type', wasmResp.headers['content-type'] === 'application/wasm');
    const wasmBrSize = parseInt(wasmResp.headers['content-length']);
    check('WASM brotli: compressed (< 100MB)', wasmBrSize < 100000000);
    log(`  WASM compressed: ${(wasmBrSize / 1e6).toFixed(1)}MB`);

    const dataResp = await httpHead(`${BASE}/browser/soffice.data`, { 'Accept-Encoding': 'br' });
    check('soffice.data brotli: Content-Encoding=br', dataResp.headers['content-encoding'] === 'br');
    const dataBrSize = parseInt(dataResp.headers['content-length']);
    log(`  soffice.data compressed: ${(dataBrSize / 1e6).toFixed(1)}MB`);

    const bundleResp = await httpHead(`${BASE}/browser/bundle.js`, { 'Accept-Encoding': 'br' });
    check('bundle.js brotli: Content-Encoding=br', bundleResp.headers['content-encoding'] === 'br');
    const bundleBrSize = parseInt(bundleResp.headers['content-length']);
    log(`  bundle.js compressed: ${(bundleBrSize / 1e6).toFixed(1)}MB`);

    // === Test 2: Cache headers ===
    log('\n--- Test 2: Cache headers ---');
    check('WASM: immutable cache', wasmResp.headers['cache-control']?.includes('immutable'));
    check('soffice.data: immutable cache', dataResp.headers['cache-control']?.includes('immutable'));

    // === Test 3: No-cache on HTML ===
    log('\n--- Test 3: No-cache on HTML ---');
    const htmlResp = await httpHead(`${BASE}/browser/cool.html`);
    check('cool.html: no-cache', htmlResp.headers['cache-control'] === 'no-cache');

    // Upload document
    const upPage = await browser.newPage();
    await upPage.goto(`${BASE}/editor.html`, { waitUntil: 'networkidle0' });
    const docPath = path.join(__dirname, '..', 'test', 'data', 'test document.docx');
    const docBytes = fs.readFileSync(docPath);
    await upPage.evaluate(async (url, arr) => {
        await fetch(url + '/wasm/' + encodeURIComponent('test document.docx'), {
            method: 'POST', body: new Blob([new Uint8Array(arr)]),
        });
    }, BASE, Array.from(docBytes));
    await upPage.close();
    log('Document uploaded');

    // === Test 4: First visit — cold cache ===
    log('\n--- Test 4: First visit (cold cache) ---');
    const page1 = await browser.newPage();
    const client1 = await page1.createCDPSession();
    await client1.send('Network.clearBrowserCache');
    await client1.send('Network.clearBrowserCookies');
    log('Browser cache cleared');

    // Enable network tracking
    await client1.send('Network.enable');
    const firstVisitRequests = [];
    client1.on('Network.loadingFinished', (params) => {
        firstVisitRequests.push(params);
    });

    const t1 = Date.now();
    await page1.goto(`${BASE}/browser/cool.html?WOPISrc=test%20document.docx&access_token=test`, {
        waitUntil: 'domcontentloaded', timeout: 300000,
    });

    // Check progress bar
    const progressSeen = await page1.evaluate(() => !!document.getElementById('wasm-loading-overlay'));
    check('Progress bar visible on first visit', progressSeen);

    try {
        await page1.waitForFunction(() => {
            const el = document.querySelector('#StateWordCount');
            return el && el.textContent && el.textContent.includes('word');
        }, { timeout: 300000 });

        const firstTime = ((Date.now() - t1) / 1000).toFixed(1);
        log(`First visit load time: ${firstTime}s`);
        check('First visit: document loaded', true);

        // Verify actual content is rendered
        await sleep(5000);
        const firstContent = await page1.evaluate(() => ({
            wordCount: document.querySelector('#StateWordCount')?.textContent,
            hasCanvas: document.querySelectorAll('canvas').length > 0,
            overlayGone: !document.getElementById('wasm-loading-overlay'),
        }));
        check('First visit: word count visible', firstContent.wordCount?.includes('word'));
        check('First visit: canvas rendered', firstContent.hasCanvas);
        check('First visit: progress bar removed', firstContent.overlayGone);
        log(`  Content: ${firstContent.wordCount}`);

        await snap(page1, 'first_visit_content');

    } catch (e) {
        log('First visit FAIL: ' + e.message);
        check('First visit: document loaded', false);
        await snap(page1, 'first_visit_fail');
    }
    const firstLoadTime = (Date.now() - t1) / 1000;
    await page1.close();

    // === Test 5: Return visit — warm cache ===
    log('\n--- Test 5: Return visit (warm cache) ---');
    const page2 = await browser.newPage();
    const client2 = await page2.createCDPSession();
    await client2.send('Network.enable');

    const t2 = Date.now();
    await page2.goto(`${BASE}/browser/cool.html?WOPISrc=test%20document.docx&access_token=test`, {
        waitUntil: 'domcontentloaded', timeout: 300000,
    });

    try {
        await page2.waitForFunction(() => {
            const el = document.querySelector('#StateWordCount');
            return el && el.textContent && el.textContent.includes('word');
        }, { timeout: 300000 });

        const returnTime = ((Date.now() - t2) / 1000).toFixed(1);
        log(`Return visit load time: ${returnTime}s`);
        check('Return visit: document loaded', true);

        // Verify content
        await sleep(5000);
        const returnContent = await page2.evaluate(() => ({
            wordCount: document.querySelector('#StateWordCount')?.textContent,
            hasCanvas: document.querySelectorAll('canvas').length > 0,
        }));
        check('Return visit: word count visible', returnContent.wordCount?.includes('word'));
        check('Return visit: canvas rendered', returnContent.hasCanvas);
        log(`  Content: ${returnContent.wordCount}`);

        await snap(page2, 'return_visit_content');

        // Check which resources were served from cache
        const resources = await page2.evaluate(() => {
            return performance.getEntriesByType('resource').map(e => ({
                name: e.name.split('/').pop().substring(0, 50),
                transfer: e.transferSize,
                decoded: e.decodedBodySize,
                cached: e.transferSize === 0 && e.decodedBodySize > 0,
            })).filter(e =>
                e.name.includes('wasm') || e.name.includes('soffice') ||
                e.name.includes('bundle') || e.name.includes('online')
            );
        });

        log('  Resource transfer on return visit:');
        let cachedCount = 0;
        let downloadedCount = 0;
        for (const r of resources) {
            const status = r.cached ? 'CACHED' : `${(r.transfer / 1048576).toFixed(1)}MB`;
            log(`    ${r.name}: ${status} (decoded: ${(r.decoded / 1048576).toFixed(1)}MB)`);
            if (r.cached) cachedCount++;
            else downloadedCount++;
        }
        check('Large resources served from cache', cachedCount > 0);
        log(`  Cached: ${cachedCount}, Downloaded: ${downloadedCount}`);

        // Compare times
        const returnLoadTime = (Date.now() - t2) / 1000;
        log(`\n  Time comparison: first=${firstLoadTime.toFixed(1)}s, return=${returnLoadTime.toFixed(1)}s`);
        if (returnLoadTime < firstLoadTime) {
            log(`  Return visit ${((1 - returnLoadTime / firstLoadTime) * 100).toFixed(0)}% faster`);
        }

    } catch (e) {
        log('Return visit FAIL: ' + e.message);
        check('Return visit: document loaded', false);
        await snap(page2, 'return_visit_fail');
    }
    await page2.close();

    await browser.close();
    log('\n' + (allPassed ? '✓ ALL CACHING TESTS PASSED' : '✗ SOME CACHING TESTS FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
