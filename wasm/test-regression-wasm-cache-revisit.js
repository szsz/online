const __cl = require('./lib/inject-checklist');
// Regression test: a return visit (closing the browser, coming back) must
// NOT re-download online.wasm + soffice.data. The user reports that every
// time they visit the site, the full 60+ MB downloads again — that's the
// scenario this test reproduces.
//
// Method: launch puppeteer with a PERSISTENT userDataDir, prewarm the
// viewer (full 60+ MB cold download), close the browser entirely, then
// launch again with the SAME userDataDir and re-open the viewer. The
// disk cache from session 1 must serve the heavy assets in session 2.
//
// Read transferSize via performance.getEntriesByType('resource') inside
// each iframe (page-level CDP misses OOPIF traffic). transferSize is 0
// for cache hits, on-the-wire bytes otherwise.
const puppeteer = require('puppeteer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const env = require('./lib/test-env');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-wasm-cache-revisit';

const HEAVY_ASSETS = [
    /\/online(\.[a-f0-9]+)?\.wasm(\?|$)/,
    /\/soffice\.data(\?|$)/,
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2,'0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch(e) {}
}

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}${ev?' ['+ev+']':''}`); allPassed = false; }
}

function isHeavy(url) { return HEAVY_ASSETS.some(re => re.test(url)); }

async function readHeavyTransfers(page) {
    const out = [];
    for (const fr of page.frames()) {
        try {
            const entries = await fr.evaluate(() =>
                performance.getEntriesByType('resource').map(e => ({
                    url: e.name,
                    transferSize: e.transferSize,
                    encodedBodySize: e.encodedBodySize,
                    decodedBodySize: e.decodedBodySize,
                    nextHopProtocol: e.nextHopProtocol,
                    responseStart: e.responseStart,
                    responseEnd: e.responseEnd,
                })));
            for (const e of entries) if (isHeavy(e.url)) out.push(e);
        } catch(err) {}
    }
    return out;
}

async function waitForPrewarmReady(page, label, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const fr = page.frames().find(f => f.url().includes('cool.html'));
        if (fr) {
            try {
                if (await fr.evaluate(() => !!window.__wasmPrewarmReady)) {
                    log(`[${label}] Prewarm ready`);
                    return true;
                }
            } catch(e) {}
        }
        await sleep(500);
    }
    log(`[${label}] Prewarm TIMEOUT`);
    return false;
}

(async () => {
    log('=== Regression: return-visit cache (persistent userDataDir) ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    // Use a persistent user data dir so the disk cache survives the
    // browser-close + re-launch cycle. Tests usually run with a fresh
    // tmp dir per launch — that's exactly why ordinary tests don't catch
    // a cache-on-return-visit regression.
    const USER_DATA_DIR = path.join(os.tmpdir(),
        'wasm-cache-revisit-' + Date.now() + '-' + process.pid);
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    log(`Persistent userDataDir: ${USER_DATA_DIR}`);

    const launchOpts = {
        headless: 'new', protocolTimeout: 600000,
        userDataDir: USER_DATA_DIR,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    };

    let session1Bytes = 0, session2Bytes = 0;

    try {
        // ── SESSION 1: cold cache, full download ───────────────────
        log('\n--- Session 1: first visit (cold cache) ---');
        let browser = await puppeteer.launch(launchOpts);
        let page = await browser.newPage();
        await page.setCacheEnabled(true);
        await page.setViewport({ width: 1280, height: 900 });
        await page.goto(VIEWER + '/', { waitUntil: 'domcontentloaded' });

        const ok1 = await waitForPrewarmReady(page, 'session1', 180000);
        check('Session 1: prewarm reaches ready', ok1);
        await snap(page, 'session1_loaded');

        const t1 = await readHeavyTransfers(page);
        session1Bytes = t1.reduce((s, t) => s + t.transferSize, 0);
        log(`Session 1: ${t1.length} heavy entries, ${(session1Bytes/1048576).toFixed(1)}MB on the wire`);
        for (const t of t1) {
            const isCache = t.transferSize === 0 && t.decodedBodySize > 0;
            log(`  ${t.url.split('/').pop()}: ` +
                `transfer=${(t.transferSize/1048576).toFixed(2)}MB ` +
                `decoded=${(t.decodedBodySize/1048576).toFixed(2)}MB ` +
                `${isCache ? 'CACHE HIT' : 'WIRE'}`);
        }
        check('Session 1: heavy assets actually downloaded (cold cache)',
              session1Bytes > 10 * 1048576,   // at least 10 MB (we expect ~74 MB)
              (session1Bytes/1048576).toFixed(1) + 'MB');

        // Close ALL pages and the browser cleanly so the disk cache
        // is flushed.
        await page.close();
        await browser.close();
        log('Session 1: browser closed');

        // ── SESSION 2: re-launch with the SAME userDataDir ─────────
        log('\n--- Session 2: return visit (warm disk cache) ---');
        browser = await puppeteer.launch(launchOpts);
        page = await browser.newPage();
        await page.setCacheEnabled(true);
        await page.setViewport({ width: 1280, height: 900 });
        await page.goto(VIEWER + '/', { waitUntil: 'domcontentloaded' });

        const ok2 = await waitForPrewarmReady(page, 'session2', 180000);
        check('Session 2: prewarm reaches ready', ok2);
        await snap(page, 'session2_loaded');

        const t2 = await readHeavyTransfers(page);
        session2Bytes = t2.reduce((s, t) => s + t.transferSize, 0);
        log(`Session 2: ${t2.length} heavy entries, ${(session2Bytes/1048576).toFixed(1)}MB on the wire`);
        for (const t of t2) {
            const isCache = t.transferSize === 0 && t.decodedBodySize > 0;
            log(`  ${t.url.split('/').pop()}: ` +
                `transfer=${(t.transferSize/1048576).toFixed(2)}MB ` +
                `decoded=${(t.decodedBodySize/1048576).toFixed(2)}MB ` +
                `${isCache ? 'CACHE HIT' : 'WIRE'}`);
        }

        // The hard assertion: session 2 must hit the cache. A 304
        // round-trip per asset is acceptable (header bytes only) but
        // re-downloading the body would be tens of MB. 100 KB total
        // ceiling generously absorbs 304s and any small auxiliary
        // requests; a real re-download would be ~74 MB.
        const TOTAL_CEIL_BYTES = 100 * 1024;
        check('Session 2: heavy assets come from cache (< 100KB total on the wire)',
              session2Bytes < TOTAL_CEIL_BYTES,
              `session1=${(session1Bytes/1048576).toFixed(1)}MB session2=${(session2Bytes/1048576).toFixed(1)}MB`);

        await browser.close();

        log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    } catch(e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        // Clean up the persistent dir
        try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }); } catch(e) {}
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
