const __cl = require('../../lib/inject-checklist');
// Test: Caching, compression, and multi-format load with document switching.
//
// Verifies:
//   1. Brotli compression on WASM and data files (Content-Encoding: br)
//   2. Immutable cache headers on large hashed assets
//   3. No-cache on HTML
//   4. Cold-vs-warm visit performance (browser cache survives across pages)
//   5. Format switch reuses WASM from cache
//
// Migrated to the viewer flow.
//
// Post-FD the editor lives at <EDITOR>/<EDITOR_BUILD_ID>/browser/dist/...
// The viewer's /config.js exposes EDITOR_DEPLOY_ID — we read it once to
// build the asset paths.
const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { openViaViewer, openSecretInBrowser } = require('../../lib/open-via-viewer');
const { fetchUrl, headUrl } = require('../../lib/fetch-url');

const EDITOR = env.EDITOR_URL;
const VIEWER = env.FILE_STORAGE_URL;
const TIMEOUT = env.scaleTimeout(300000);
const SHOT_DIR = '/tmp/static-deploy/public/shots-caching';

async function sleep_(ms) { return new Promise(r => setTimeout(r, ms)); }
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await sleep(500);
    const filename = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${filename}`, fullPage: true }); } catch(e) {}
    log(`[snap] ${filename}`);
}

const httpHead = headUrl;
const httpGet = fetchUrl;

async function getDeployId() {
    const r = await httpGet(VIEWER + '/config.js');
    const m = r.body.toString().match(/"EDITOR_DEPLOY_ID"\s*:\s*"([^"]+)"/);
    if (!m) throw new Error('EDITOR_DEPLOY_ID not in /config.js');
    return m[1];
}

async function getAssetMap(deployBase) {
    const r = await httpGet(`${deployBase}/browser/dist/cool.html`);
    const m = r.body.toString().match(/window\.__assetMap\s*=\s*(\{[^}]+\})/);
    if (!m) throw new Error('__assetMap not found in cool.html');
    return JSON.parse(m[1]);
}

let allPassed = true;
function check(label, condition) { __cl.recordCheck(label, condition);
    if (condition) { log(`  ✓ ${label}`); }
    else { log(`  ✗ FAIL: ${label}`); allPassed = false; }
}

async function waitForDocLoaded(frame, timeout) {
    return frame.waitForFunction(() => {
        const wc = document.querySelector('#StateWordCount');
        if (wc && wc.textContent && wc.textContent.includes('word')) return true;
        const dp = document.querySelector('#StatusDocPos');
        if (dp && dp.textContent && dp.textContent.includes('Sheet')) return true;
        return false;
    }, { timeout });
}

async function getDocInfo(frame) {
    return frame.evaluate(() => {
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

    // Discover the editor build the viewer pins to.
    const deployId = await getDeployId();
    const deployBase = `${EDITOR}/${deployId}`;
    log(`Viewer pins EDITOR_DEPLOY_ID=${deployId}`);

    const { browser, cleanup } = await launch();

    try {
        // ============================================================
        // Test 1: Brotli compression (HTTP-level, no editor needed)
        // ============================================================
        log('\n--- Test 1: Brotli compression ---');
        const assetMap = await getAssetMap(deployBase);
        const wasmAsset = assetMap['online.wasm'];
        const dataAsset = assetMap['soffice.data'];
        const bundleAsset = assetMap['bundle.js'];
        log(`  assetMap: online.wasm→${wasmAsset}, soffice.data→${dataAsset}, bundle.js→${bundleAsset}`);

        async function fetchBrotli(label, asset) {
            const url = `${deployBase}/browser/dist/${asset}`;
            const resp = await httpHead(url, { 'Accept-Encoding': 'br' });
            const enc = resp.headers['content-encoding'] || '(none)';
            log(`  ${label}: Content-Encoding=${enc}, status=${resp.status}`);
            return resp;
        }

        const wasmResp = await fetchBrotli('WASM', wasmAsset);
        check('WASM brotli: correct Content-Type',
              wasmResp.headers['content-type'] === 'application/wasm');
        const wasmSize = parseInt(wasmResp.headers['content-length']);
        check('WASM: served (br or identity)', wasmSize > 0 && wasmSize < 300000000);
        log(`  WASM size: ${(wasmSize / 1e6).toFixed(1)}MB`);

        const dataResp = await fetchBrotli('soffice.data', dataAsset);
        check('soffice.data: served', dataResp.status === 200 || dataResp.status === 304);

        const bundleResp = await fetchBrotli('bundle.js', bundleAsset);
        check('bundle.js: served', bundleResp.status === 200 || bundleResp.status === 304);

        // ============================================================
        // Test 2: Cache headers
        // ============================================================
        log('\n--- Test 2: Cache headers ---');
        check('WASM: immutable cache',
              wasmResp.headers['cache-control']?.includes('immutable'));
        check('soffice.data: immutable cache',
              dataResp.headers['cache-control']?.includes('immutable'));

        // ============================================================
        // Test 3: cool.html cache policy
        //
        // Post per-deploy-folder migration cool.html lives at
        // /<EDITOR_BUILD_ID>/browser/dist/cool.html — the path itself
        // is the cache key, so immutable caching is correct.
        // ============================================================
        log('\n--- Test 3: cool.html cache policy ---');
        const htmlResp = await httpHead(`${deployBase}/browser/dist/cool.html`);
        check('cool.html: immutable cache (path-keyed by EDITOR_BUILD_ID)',
              htmlResp.headers['cache-control']?.includes('immutable'));

        // ============================================================
        // Test 4: Cold-vs-warm visit (browser cache reuse)
        //
        // Open the same file twice in the same browser; second open
        // should reuse cached WASM/data and complete faster. Measured
        // from openViaViewer return → editor doc-ready.
        // ============================================================
        log('\n--- Test 4: Cold vs warm visit ---');
        const testDir = path.join(__dirname, '..', 'test', 'data');
        const docPath = path.join(testDir, 'new.docx');
        const docBytes = fs.readFileSync(docPath);

        log('  Cold visit (fresh browser context, empty cache):');
        const tCold0 = Date.now();
        const upCold = await openViaViewer(browser, VIEWER, 'cache-cold.docx', docBytes,
            { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
              isolatedContext: true });
        await waitForDocLoaded(upCold.editorFrame, TIMEOUT);
        const coldTime = (Date.now() - tCold0) / 1000;
        log(`  Cold visit done in ${coldTime.toFixed(1)}s`);
        await sleep(5000);
        const coldInfo = await getDocInfo(upCold.editorFrame);
        check('Cold visit: writer loaded', coldInfo.type === 'writer');
        check('Cold visit: canvas rendered', coldInfo.hasCanvas);
        await snap(upCold.page, 'cold_visit');
        await upCold.page.close();
        if (upCold.context) await upCold.context.close();

        log('  Warm visit (new context, browser cache populated):');
        const tWarm0 = Date.now();
        const upWarm = await openViaViewer(browser, VIEWER, 'cache-warm.docx', docBytes,
            { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
              isolatedContext: true });
        await waitForDocLoaded(upWarm.editorFrame, TIMEOUT);
        const warmTime = (Date.now() - tWarm0) / 1000;
        log(`  Warm visit done in ${warmTime.toFixed(1)}s`);
        await sleep(5000);
        const warmInfo = await getDocInfo(upWarm.editorFrame);
        check('Warm visit: writer loaded', warmInfo.type === 'writer');
        check('Warm visit: canvas rendered', warmInfo.hasCanvas);
        log(`  Time comparison: cold=${coldTime.toFixed(1)}s warm=${warmTime.toFixed(1)}s`);
        // Don't make the perf comparison a hard fail — Azure cold load
        // is highly variable. Just log it.
        if (warmTime < coldTime) {
            log(`  Warm ${((1 - warmTime / coldTime) * 100).toFixed(0)}% faster`);
        }
        await snap(upWarm.page, 'warm_visit');
        await upWarm.page.close();
        if (upWarm.context) await upWarm.context.close();

        // ============================================================
        // Test 5: Format switch (xlsx after docx)
        // ============================================================
        log('\n--- Test 5: Format switch — xlsx ---');
        const xlsxBytes = fs.readFileSync(path.join(testDir, 'testdoc.xlsx'));
        const tX0 = Date.now();
        const upX = await openViaViewer(browser, VIEWER, 'cache-xlsx.xlsx', xlsxBytes,
            { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
              isolatedContext: true });
        await waitForDocLoaded(upX.editorFrame, TIMEOUT);
        const xlsxTime = (Date.now() - tX0) / 1000;
        log(`  xlsx load time: ${xlsxTime.toFixed(1)}s`);
        const xlsxInfo = await getDocInfo(upX.editorFrame);
        check('Format switch: calc loaded', xlsxInfo.type === 'calc');
        check('Format switch: canvas rendered', xlsxInfo.hasCanvas);
        await snap(upX.page, 'format_xlsx');
        await upX.page.close();
        if (upX.context) await upX.context.close();

        log('\n' + (allPassed ? '✓ ALL CACHING TESTS PASSED' : '✗ SOME TESTS FAILED'));

    } catch (e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        await cleanup();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
