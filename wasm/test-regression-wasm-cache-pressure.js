const __cl = require('./lib/inject-checklist');
// Regression test: heavy WASM assets must survive Chrome's disk-cache LRU
// under realistic cache pressure.
//
// The user-reported bug: every visit to the site re-downloads 60+ MB of
// WASM, even though the response carries Cache-Control: public, max-age=
// 31536000, immutable. The HTTP cache headers are correct — Chrome WILL
// cache the bytes — but Chrome's disk cache also has a per-origin quota
// and an LRU eviction policy. Users with limited disk space or heavy
// browsing activity routinely have one of online.wasm (~57 MB brotli) or
// soffice.data (~20 MB brotli) evicted between visits, forcing a re-fetch.
//
// We REPRODUCE this here by launching Chrome with --disk-cache-size=
// 50000000 (50 MB) — small enough that LRU evicts at least one of the
// two heavy assets between sessions. The wire-transfer count on session 2
// then exceeds zero, which is what the user actually sees.
//
// The fix lives at the application layer, not in HTTP cache headers: the
// editor registers a Service Worker that pre-caches the heavy assets in
// Cache Storage. Cache Storage has its own (much larger) per-origin
// quota, separate from the HTTP cache, and entries placed there persist
// until the SW (or the user) deletes them.
//
// After the SW lands this test must pass even with --disk-cache-size=50000000:
// session 2 reads the assets through the SW, not the HTTP cache, so the
// HTTP cache eviction is irrelevant.
const puppeteer = require('puppeteer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const env = require('./lib/test-env');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-wasm-cache-pressure';

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

// Attach a browser-level CDP listener that captures Network events from
// EVERY target (page + every cross-origin iframe + the service worker
// itself). Returns { tracker, detach } — tracker.bytes() is the running
// total of on-the-wire bytes for heavy assets so far, regardless of
// whether a Service Worker is in the request path.
async function trackBrowserNetwork(browser) {
    const browserCdp = await browser.target().createCDPSession();
    // Auto-attach to all current and future child targets in flat mode so
    // their Network events arrive on this same session.
    await browserCdp.send('Target.setAutoAttach', {
        autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
    });

    const heavyResponses = [];   // {url, encodedDataLength, fromCache}
    const sessions = new Set();
    const reqUrls = new Map();   // requestId → url (per-session not needed
                                 // because IDs come prefixed in flat mode)

    function attachToSession(session) {
        if (sessions.has(session)) return;
        sessions.add(session);
        session.send('Network.enable').catch(() => {});
        session.on('Network.requestWillBeSent', (e) => {
            reqUrls.set(e.requestId, e.request.url);
        });
        session.on('Network.responseReceived', (e) => {
            const url = reqUrls.get(e.requestId) || e.response.url;
            if (!isHeavy(url)) return;
            heavyResponses.push({
                url,
                encodedDataLength: e.response.encodedDataLength || 0,
                fromCache: !!(e.response.fromDiskCache || e.response.fromServiceWorker),
                fromSW: !!e.response.fromServiceWorker,
                fromDisk: !!e.response.fromDiskCache,
            });
        });
        session.on('Network.loadingFinished', (e) => {
            const url = reqUrls.get(e.requestId);
            if (!url || !isHeavy(url)) return;
            const entry = heavyResponses.find(r => r.url === url && !r._final);
            if (entry) {
                entry.encodedDataLength = Math.max(entry.encodedDataLength, e.encodedDataLength || 0);
                entry._final = true;
            }
        });
    }
    attachToSession(browserCdp);
    browserCdp.on('sessionattached', (s) => attachToSession(s));

    return {
        bytes: () => heavyResponses.reduce((s, r) => s + r.encodedDataLength, 0),
        responses: () => heavyResponses.slice(),
        clear: () => { heavyResponses.length = 0; reqUrls.clear(); },
    };
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
    log('=== Regression: WASM cache survives disk-cache pressure ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    // Persistent userDataDir + small disk cache: between sessions Chrome's
    // disk cache LRU has to choose what to keep. With < (online.wasm +
    // soffice.data) = 75 MB of cache room, at least one heavy asset is
    // evicted by the next visit's other resources (HTML, CSS, fonts, doc
    // listing, etc.).
    const USER_DATA_DIR = path.join(os.tmpdir(),
        'wasm-cache-pressure-' + Date.now() + '-' + process.pid);
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    log(`Persistent userDataDir: ${USER_DATA_DIR}`);
    log('Chrome --disk-cache-size limited to 50 MB (deliberately undersized)');

    const launchOpts = {
        headless: 'new', protocolTimeout: 600000,
        userDataDir: USER_DATA_DIR,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer',
               '--disk-cache-size=50000000'],   // 50 MB
    };

    let session1Bytes = 0, session2Bytes = 0;

    try {
        // ── Session 1: cold, full download expected ─────────────
        log('\n--- Session 1: cold cache, full WASM download ---');
        let browser = await puppeteer.launch(launchOpts);
        let tracker = await trackBrowserNetwork(browser);
        let page = await browser.newPage();
        page.on('dialog', d => d.accept().catch(() => {}));
        await page.setCacheEnabled(true);
        await page.setViewport({ width: 1280, height: 900 });
        await page.goto(VIEWER + '/', { waitUntil: 'domcontentloaded' });
        check('Session 1: prewarm reaches ready',
              await waitForPrewarmReady(page, 'session1', 300000));
        await sleep(1000);   // let any tail-end fetches settle
        await snap(page, 'session1_loaded');

        const r1 = tracker.responses();
        session1Bytes = tracker.bytes();
        log(`Session 1: ${r1.length} heavy responses, ${(session1Bytes/1048576).toFixed(1)} MB on the wire`);
        for (const r of r1) {
            log(`  ${r.url.split('/').pop()}: ` +
                `bytes=${(r.encodedDataLength/1048576).toFixed(2)} MB ` +
                `fromCache=${r.fromCache} fromSW=${r.fromSW}`);
        }
        check('Session 1: heavy assets detected',
              r1.length >= 1,
              r1.length + ' entries, ' + (session1Bytes/1048576).toFixed(1) + ' MB');

        await page.close();
        await browser.close();

        // ── Session 2: re-launch with the SAME userDataDir ───────
        log('\n--- Session 2: return visit, must come from CACHE ---');
        browser = await puppeteer.launch(launchOpts);
        tracker = await trackBrowserNetwork(browser);
        page = await browser.newPage();
        page.on('dialog', d => d.accept().catch(() => {}));
        await page.setCacheEnabled(true);
        await page.setViewport({ width: 1280, height: 900 });
        await page.goto(VIEWER + '/', { waitUntil: 'domcontentloaded' });
        check('Session 2: prewarm reaches ready',
              await waitForPrewarmReady(page, 'session2', 300000));
        await sleep(1000);
        await snap(page, 'session2_loaded');

        const r2 = tracker.responses();
        session2Bytes = tracker.bytes();
        log(`Session 2: ${r2.length} heavy responses, ${(session2Bytes/1048576).toFixed(1)} MB on the wire`);
        for (const r of r2) {
            log(`  ${r.url.split('/').pop()}: ` +
                `bytes=${(r.encodedDataLength/1048576).toFixed(2)} MB ` +
                `fromCache=${r.fromCache} fromSW=${r.fromSW}`);
        }

        // The hard assertion: under realistic cache pressure the heavy
        // assets MUST still come from a persistent cache (Cache Storage
        // via the Service Worker). 1 MB total ceiling absorbs small
        // metadata/headers without masking a real re-download (which
        // would be ≥ 20 MB).
        const TOTAL_CEIL_MB = 1;
        check(`Session 2: heavy assets cached even under disk-cache pressure (< ${TOTAL_CEIL_MB} MB total wire)`,
              session2Bytes < TOTAL_CEIL_MB * 1048576,
              `s1=${(session1Bytes/1048576).toFixed(1)}MB  s2=${(session2Bytes/1048576).toFixed(1)}MB`);

        await browser.close();

        log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    } catch(e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }); } catch(e) {}
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
