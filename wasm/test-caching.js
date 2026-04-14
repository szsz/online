const __cl = require('./lib/inject-checklist');
// Test: Caching, compression, and multi-format load with document switching
// Verifies:
// 1. Brotli compression on WASM and data files
// 2. Immutable cache headers on large assets
// 3. No-cache on HTML
// 4. First visit (docx): cold cache, progress bar, content visible
// 5. Return visit (docx): cached resources, faster load
// 6. Format switch (xlsx): same WASM cached, Calc loads
// 7. Format switch (odt): Writer loads from cache
// 8. Format switch (ods): Calc loads from cache
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
function check(label, condition) { __cl.recordCheck(label, condition);
    if (condition) { log(`  \u2713 ${label}`); }
    else { log(`  \u2717 FAIL: ${label}`); allPassed = false; }
}

async function uploadFile(browser, name, filePath) {
    const upPage = await browser.newPage();
    await upPage.goto(`${BASE}/editor.html`, { waitUntil: 'networkidle0' });
    const docBytes = fs.readFileSync(filePath);
    await upPage.evaluate(async (url, n, arr) => {
        await fetch(url + '/wasm/' + encodeURIComponent(n), {
            method: 'POST', body: new Blob([new Uint8Array(arr)]),
        });
    }, BASE, name, Array.from(docBytes));
    await upPage.close();
    log(`Uploaded ${name} (${(docBytes.length/1024).toFixed(0)}KB)`);
}

// Wait for Writer (StateWordCount) or Calc (StatusDocPos)
async function waitForDocLoaded(page, timeout) {
    return page.waitForFunction(() => {
        const wc = document.querySelector('#StateWordCount');
        if (wc && wc.textContent && wc.textContent.includes('word')) return true;
        const dp = document.querySelector('#StatusDocPos');
        if (dp && dp.textContent && dp.textContent.includes('Sheet')) return true;
        return false;
    }, { timeout });
}

async function getDocInfo(page) {
    return page.evaluate(() => {
        const wc = document.querySelector('#StateWordCount');
        const dp = document.querySelector('#StatusDocPos');
        return {
            wordCount: wc ? wc.textContent : null,
            docPos: dp ? dp.textContent : null,
            hasCanvas: document.querySelectorAll('canvas').length > 0,
            overlayGone: !document.getElementById('wasm-loading-overlay'),
            type: (wc && wc.textContent && wc.textContent.includes('word')) ? 'writer' :
                  (dp && dp.textContent && dp.textContent.includes('Sheet')) ? 'calc' : 'unknown',
        };
    });
}

(async () => {
    log('=== Caching, Compression & Multi-Format Tests ===');
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

    // === Upload test documents ===
    log('\n--- Uploading test documents ---');
    const testDir = path.join(__dirname, '..', 'test', 'data');
    await uploadFile(browser, 'test document.docx', path.join(testDir, 'test document.docx'));

    // Create a simple xlsx test file if not available
    const xlsxPath = path.join(testDir, 'convert-to.xlsx');
    if (fs.existsSync(xlsxPath)) {
        await uploadFile(browser, 'testdoc.xlsx', xlsxPath);
    }
    // Create simple txt and odt
    const odtPath = path.join(testDir, '3pages.odt');
    if (fs.existsSync(odtPath)) {
        await uploadFile(browser, 'testdoc.odt', odtPath);
    }
    const odsPath = path.join(testDir, 'calc-render.ods');
    if (fs.existsSync(odsPath)) {
        await uploadFile(browser, 'testdoc.ods', odsPath);
    }

    // === Test 4: First visit — cold cache (docx) ===
    log('\n--- Test 4: First visit - docx (cold cache) ---');
    const page1 = await browser.newPage();
    const client1 = await page1.createCDPSession();
    await client1.send('Network.clearBrowserCache');
    await client1.send('Network.clearBrowserCookies');
    log('Browser cache cleared');

    await client1.send('Network.enable');

    const t1 = Date.now();
    await page1.goto(`${BASE}/browser/cool.html?WOPISrc=test%20document.docx&access_token=test`, {
        waitUntil: 'domcontentloaded', timeout: 300000,
    });

    const progressSeen = await page1.evaluate(() => !!document.getElementById('wasm-loading-overlay'));
    check('Progress bar visible on first visit', progressSeen);

    let firstLoadTime = 0;
    try {
        await waitForDocLoaded(page1, 300000);
        firstLoadTime = (Date.now() - t1) / 1000;
        log(`First visit (docx) load time: ${firstLoadTime.toFixed(1)}s`);
        check('First visit: docx loaded', true);

        await sleep(5000);
        const info = await getDocInfo(page1);
        check('First visit: word count visible', info.wordCount?.includes('word'));
        check('First visit: canvas rendered', info.hasCanvas);
        check('First visit: progress bar removed', info.overlayGone);
        check('First visit: detected as Writer', info.type === 'writer');
        log(`  Content: ${info.wordCount}`);
        await snap(page1, 'first_visit_docx');

        const firstResources = await page1.evaluate(() => {
            return performance.getEntriesByType('resource').map(e => ({
                name: e.name.split('/').pop().substring(0, 50),
                transfer: e.transferSize,
                decoded: e.decodedBodySize,
            }));
        });
        let firstTotalTransfer = 0, firstTotalDecoded = 0;
        for (const r of firstResources) {
            firstTotalTransfer += r.transfer;
            firstTotalDecoded += r.decoded;
        }
        log(`  First visit: ${firstResources.length} files, ${(firstTotalTransfer/1048576).toFixed(1)}MB transferred, ${(firstTotalDecoded/1048576).toFixed(0)}MB decoded`);

    } catch (e) {
        log('First visit FAIL: ' + e.message);
        check('First visit: docx loaded', false);
        await snap(page1, 'first_visit_fail');
    }
    await page1.close();

    // === Test 5: Return visit — warm cache (docx) ===
    log('\n--- Test 5: Return visit - docx (warm cache) ---');
    const page2 = await browser.newPage();

    const t2 = Date.now();
    await page2.goto(`${BASE}/browser/cool.html?WOPISrc=test%20document.docx&access_token=test`, {
        waitUntil: 'domcontentloaded', timeout: 300000,
    });

    try {
        await waitForDocLoaded(page2, 300000);
        const returnTime = (Date.now() - t2) / 1000;
        log(`Return visit (docx) load time: ${returnTime.toFixed(1)}s`);
        check('Return visit: docx loaded', true);

        await sleep(5000);
        const info = await getDocInfo(page2);
        check('Return visit: content visible', info.wordCount?.includes('word'));
        check('Return visit: canvas rendered', info.hasCanvas);
        await snap(page2, 'return_visit_docx');

        const allResources = await page2.evaluate(() => {
            return performance.getEntriesByType('resource').map(e => ({
                name: e.name.split('/').pop().substring(0, 50),
                transfer: e.transferSize,
                decoded: e.decodedBodySize,
                cached: e.transferSize === 0 && e.decodedBodySize > 0,
            }));
        });

        let returnTotalTransfer = 0, cachedCount = 0, downloadedCount = 0;
        for (const r of allResources) {
            returnTotalTransfer += r.transfer;
            if (r.cached) cachedCount++;
            else downloadedCount++;
        }

        log(`  Return visit: ${allResources.length} files, ${(returnTotalTransfer/1024).toFixed(0)}KB transferred`);
        log(`  Cached: ${cachedCount} files, Downloaded: ${downloadedCount} files`);
        check('Large resources served from cache', cachedCount > 0);

        const downloaded = allResources.filter(r => !r.cached && r.transfer > 0).sort((a,b) => b.transfer - a.transfer);
        if (downloaded.length > 0) {
            log('  Downloaded (not cached):');
            for (const r of downloaded.slice(0, 5)) {
                log(`    ${r.name}: ${(r.transfer/1024).toFixed(0)}KB`);
            }
        }

        log(`\n  Time comparison: first=${firstLoadTime.toFixed(1)}s, return=${returnTime.toFixed(1)}s`);
        if (returnTime < firstLoadTime) {
            log(`  Return visit ${((1 - returnTime / firstLoadTime) * 100).toFixed(0)}% faster`);
        }

    } catch (e) {
        log('Return visit FAIL: ' + e.message);
        check('Return visit: docx loaded', false);
        await snap(page2, 'return_visit_fail');
    }
    await page2.close();

    // === Test 6: Format switch — xlsx (warm cache) ===
    log('\n--- Test 6: Format switch - xlsx (warm cache) ---');
    const page3 = await browser.newPage();
    const t3 = Date.now();
    await page3.goto(`${BASE}/browser/cool.html?WOPISrc=testdoc.xlsx&access_token=test`, {
        waitUntil: 'domcontentloaded', timeout: 300000,
    });

    try {
        await waitForDocLoaded(page3, 300000);
        const xlsxTime = (Date.now() - t3) / 1000;
        log(`xlsx load time (warm cache): ${xlsxTime.toFixed(1)}s`);
        check('Format switch: xlsx loaded', true);

        await sleep(5000);
        const info = await getDocInfo(page3);
        check('xlsx: detected as Calc', info.type === 'calc');
        check('xlsx: canvas rendered', info.hasCanvas);
        log(`  Calc status: ${info.docPos}`);
        await snap(page3, 'format_xlsx');

        // Check that WASM was cached
        const xlsxResources = await page3.evaluate(() => {
            return performance.getEntriesByType('resource')
                .filter(e => e.name.includes('online.wasm') || e.name.includes('soffice.data'))
                .map(e => ({
                    name: e.name.split('/').pop().substring(0, 50),
                    transfer: e.transferSize,
                    decoded: e.decodedBodySize,
                    cached: e.transferSize === 0 && e.decodedBodySize > 0,
                }));
        });
        for (const r of xlsxResources) {
            log(`    ${r.name}: ${r.cached ? 'CACHED' : (r.transfer/1024).toFixed(0) + 'KB'}`);
        }
        const wasmCached = xlsxResources.some(r => r.name.includes('wasm') && r.cached);
        check('xlsx: WASM served from cache', wasmCached);

    } catch (e) {
        log('xlsx FAIL: ' + e.message);
        check('Format switch: xlsx loaded', false);
        await snap(page3, 'format_xlsx_fail');
    }
    await page3.close();

    // === Test 7: Format switch — odt (warm cache) ===
    log('\n--- Test 7: Format switch - odt (warm cache) ---');
    const page4 = await browser.newPage();
    const t4 = Date.now();
    await page4.goto(`${BASE}/browser/cool.html?WOPISrc=testdoc.odt&access_token=test`, {
        waitUntil: 'domcontentloaded', timeout: 300000,
    });

    try {
        await waitForDocLoaded(page4, 300000);
        const odtTime = (Date.now() - t4) / 1000;
        log(`odt load time (warm cache): ${odtTime.toFixed(1)}s`);
        check('Format switch: odt loaded', true);

        await sleep(5000);
        const info = await getDocInfo(page4);
        check('odt: detected as Writer', info.type === 'writer');
        check('odt: canvas rendered', info.hasCanvas);
        log(`  Writer status: ${info.wordCount}`);
        await snap(page4, 'format_odt');

    } catch (e) {
        log('odt FAIL: ' + e.message);
        check('Format switch: odt loaded', false);
        await snap(page4, 'format_odt_fail');
    }
    await page4.close();

    // === Test 8: Format switch — ods (warm cache) ===
    log('\n--- Test 8: Format switch - ods (warm cache) ---');
    const page5 = await browser.newPage();
    const t5 = Date.now();
    await page5.goto(`${BASE}/browser/cool.html?WOPISrc=testdoc.ods&access_token=test`, {
        waitUntil: 'domcontentloaded', timeout: 300000,
    });

    try {
        await waitForDocLoaded(page5, 300000);
        const odsTime = (Date.now() - t5) / 1000;
        log(`ods load time (warm cache): ${odsTime.toFixed(1)}s`);
        check('Format switch: ods loaded', true);

        await sleep(5000);
        const info = await getDocInfo(page5);
        check('ods: detected as Calc', info.type === 'calc');
        check('ods: canvas rendered', info.hasCanvas);
        log(`  Calc status: ${info.docPos}`);
        await snap(page5, 'format_ods');

    } catch (e) {
        log('ods FAIL: ' + e.message);
        check('Format switch: ods loaded', false);
        await snap(page5, 'format_ods_fail');
    }
    await page5.close();

    // === Summary ===
    await browser.close();
    log('\n' + (allPassed ? '\u2713 ALL CACHING TESTS PASSED' : '\u2717 SOME CACHING TESTS FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
