// Test: WASM caching, brotli compression, and load times
// Verifies:
// 1. Brotli compression headers on hashed files
// 2. Immutable cache headers on hashed files
// 3. No-cache on HTML/manifest files
// 4. First-visit load time with progress bar
// 5. Returning-visit uses cache (near-instant load)
const puppeteer = require('puppeteer');
const https = require('https');
const fs = require('fs');

const BASE = 'https://wasm.atgpartners.info:6932';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); }

// HTTP request helper
function httpGet(url, headers) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const req = https.request({
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname,
            method: 'HEAD',
            headers: headers || {},
            rejectUnauthorized: false,
        }, (res) => {
            resolve({
                status: res.statusCode,
                headers: res.headers,
            });
        });
        req.on('error', reject);
        req.end();
    });
}

let allPassed = true;
function check(label, condition) {
    if (condition) { log(`✓ ${label}`); }
    else { log(`✗ FAIL: ${label}`); allPassed = false; }
}

(async () => {
    log('=== Caching & Compression Tests ===');

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    // === Test 1: Brotli compression on WASM ===
    log('\n--- Test 1: Brotli compression ---');
    const wasmResp = await httpGet(`${BASE}/browser/online.wasm`, { 'Accept-Encoding': 'br' });
    check('WASM brotli: Content-Encoding=br', wasmResp.headers['content-encoding'] === 'br');
    check('WASM brotli: correct Content-Type', wasmResp.headers['content-type'] === 'application/wasm');
    const brSize = parseInt(wasmResp.headers['content-length']);
    check('WASM brotli: compressed (< 100MB)', brSize < 100000000);
    log(`  Compressed: ${(brSize / 1e6).toFixed(1)}MB`);

    const dataResp = await httpGet(`${BASE}/browser/soffice.data`, { 'Accept-Encoding': 'br' });
    check('soffice.data brotli: Content-Encoding=br', dataResp.headers['content-encoding'] === 'br');
    const dataBrSize = parseInt(dataResp.headers['content-length']);
    log(`  soffice.data compressed: ${(dataBrSize / 1e6).toFixed(1)}MB`);

    // === Test 2: Immutable cache on large files ===
    log('\n--- Test 2: Cache headers ---');
    check('WASM: immutable cache', wasmResp.headers['cache-control']?.includes('immutable'));
    check('soffice.data: immutable cache', dataResp.headers['cache-control']?.includes('immutable'));

    // === Test 3: No-cache on HTML files ===
    log('\n--- Test 3: No-cache on HTML ---');
    const htmlResp = await httpGet(`${BASE}/browser/cool.html`);
    check('cool.html: no-cache', htmlResp.headers['cache-control'] === 'no-cache');

    // Upload doc for loading tests
    const upPage = await browser.newPage();
    await upPage.goto(`${BASE}/editor.html`, { waitUntil: 'networkidle0' });
    const docBytes = require('fs').readFileSync(require('path').join(__dirname, '..', 'test', 'data', 'test document.docx'));
    await upPage.evaluate(async (url, arr) => {
        await fetch(url + '/wasm/' + encodeURIComponent('test document.docx'), {
            method: 'POST', body: new Blob([new Uint8Array(arr)]),
        });
    }, BASE, Array.from(docBytes));
    await upPage.close();
    log('Document uploaded');

    // === Test 4: First-visit load time ===
    log('\n--- Test 4: First-visit load time ---');
    const page = await browser.newPage();

    // Clear cache
    const client = await page.createCDPSession();
    await client.send('Network.clearBrowserCache');
    await client.send('Network.clearBrowserCookies');
    log('Browser cache cleared');

    const loadStart = Date.now();
    await page.goto(`${BASE}/browser/cool.html?WOPISrc=test%20document.docx&access_token=test`, {
        waitUntil: 'domcontentloaded', timeout: 300000,
    });

    // Check progress bar appears
    let progressSeen = false;
    for (let i = 0; i < 60; i++) {
        const hasOverlay = await page.evaluate(() => !!document.getElementById('wasm-loading-overlay'));
        if (hasOverlay) { progressSeen = true; break; }
        await sleep(500);
    }
    check('Progress bar appeared on first visit', progressSeen);

    // Wait for document to load
    try {
        await page.waitForFunction(() => {
            const el = document.querySelector('#StateWordCount');
            return el && el.textContent && el.textContent.includes('word');
        }, { timeout: 300000 });
        const firstLoadTime = ((Date.now() - loadStart) / 1000).toFixed(1);
        log(`First-visit load time: ${firstLoadTime}s`);
        check('First visit loaded successfully', true);

        // Check progress bar removed
        const overlayGone = await page.evaluate(() => !document.getElementById('wasm-loading-overlay'));
        check('Progress bar removed after load', overlayGone);

        await page.screenshot({ path: '/tmp/static-deploy/public/shots-caching/first_visit.png' });
    } catch (e) {
        log('First visit failed: ' + e.message);
        check('First visit loaded', false);
    }

    // === Test 5: Returning-visit (cached) ===
    log('\n--- Test 5: Returning-visit (cached) ---');
    const page2 = await browser.newPage();
    const returnStart = Date.now();
    await page2.goto(`${BASE}/browser/cool.html?WOPISrc=test%20document.docx&access_token=test`, {
        waitUntil: 'domcontentloaded', timeout: 300000,
    });

    try {
        await page2.waitForFunction(() => {
            const el = document.querySelector('#StateWordCount');
            return el && el.textContent && el.textContent.includes('word');
        }, { timeout: 300000 });
        const returnLoadTime = ((Date.now() - returnStart) / 1000).toFixed(1);
        log(`Returning-visit load time: ${returnLoadTime}s`);

        // Check resources came from cache
        const entries = await page2.evaluate(() => {
            return performance.getEntriesByType('resource').map(e => ({
                name: e.name.split('/').pop().substring(0, 40),
                transferSize: e.transferSize,
                size: e.decodedBodySize,
            })).filter(e => e.name.includes('wasm') || e.name.includes('soffice.data'));
        });
        log('Key resource transfer sizes:');
        let anyCached = false;
        for (const e of entries) {
            log(`  ${e.name}: transfer=${e.transferSize} decoded=${e.size}`);
            if (e.transferSize === 0 && e.size > 0) anyCached = true;
        }
        check('At least one large resource from cache', anyCached);

        check('Returning visit loaded', true);
        fs.mkdirSync('/tmp/static-deploy/public/shots-caching', { recursive: true });
        await page2.screenshot({ path: '/tmp/static-deploy/public/shots-caching/return_visit.png' });
    } catch (e) {
        log('Return visit failed: ' + e.message);
        check('Return visit loaded', false);
    }

    await browser.close();

    log('\n' + (allPassed ? '✓ ALL CACHING TESTS PASSED' : '✗ SOME CACHING TESTS FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
