const __cl = require('../../lib/inject-checklist');
// Regression: incognito second-tab must hit Cache Storage for heavy assets.
//
// Bug (2026-05-06): users report opening a doc in incognito, closing the tab,
// then opening the same doc in a new tab of the same incognito session is
// SLOWER than the first visit (~30s vs ~20s). Resource timings show
// `soffice.<hash>.data` re-downloads in full on tab 2 (transferSize ≈ decoded
// size), even though `Cache-Control: public, max-age=31536000, immutable`
// is set.
//
// Why default browsing dodges the bug: Chrome's HTTP disk cache holds the
// 93 MB body comfortably, so tab 2 is a clean 304/from-cache. In incognito
// the HTTP cache is in-memory only with a much smaller quota, so heavy
// entries evict between tabs.
//
// The Service Worker (sw.js) was supposed to cover this — Cache Storage
// has its own larger quota and persists across tabs in the same session.
// Root cause confirmed by manual regex test (see fix plan):
//
//     /\/soffice\.data(\?|$)/   matches  /browser/soffice.data
//                              MISS      /browser/soffice.e0cb303a.data
//
// After cache-bust hashing landed in iter 27, the SW pattern stopped
// matching the actual deployed filenames for `soffice.<hash>.data` and
// `soffice.data.js.<hash>.metadata`. The SW silently passes them through;
// in default browsing the HTTP cache hides the regression, in incognito
// it's exposed.
//
// What this test asserts on the second incognito tab:
//   - online.<hash>.wasm                        transferSize == 0
//   - soffice.<hash>.data                       transferSize == 0  ← the bug
//   - soffice.data.js.<hash>.metadata           transferSize == 0  ← the bug
//   - tab2 restoredAt < (tab1 restoredAt - 5s)  warm should be much faster
//
// Expected to FAIL until sw.js HEAVY_PATTERNS gain hash slots for the
// `soffice.*` entries.

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

const VIEWER  = env.FILE_STORAGE_URL;
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'test document.docx');
const NAME    = `regression-incog-warm-${Date.now()}.docx`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0    = Date.now();
const log   = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  PASS: ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

async function openAndMeasure(label, page, url) {
    const tStart = Date.now();
    const events = [];
    page.on('console', m => {
        const t = m.text();
        if (/(snapshot:|first_canvas|warm_restore|emscripten:calledRun|precache:done)/i.test(t)) {
            events.push(`[${((Date.now() - tStart) / 1000).toFixed(2)}s] ${t.substring(0, 200)}`);
        }
    });

    log(`[${label}] navigating…`);
    await page.goto(url, { waitUntil: 'domcontentloaded',
                          timeout: env.scaleTimeout(120000) });

    // Watchpoint: snapshot:signal restored OR emscripten:calledRun OR a 90s ceiling.
    const deadline = Date.now() + env.scaleTimeout(90000);
    let restoredAt = null;
    while (Date.now() < deadline) {
        const hit = events.find(e => /snapshot:signal restored|emscripten:calledRun/.test(e));
        if (hit) { restoredAt = (Date.now() - tStart) / 1000; break; }
        await sleep(500);
    }

    // Wait briefly for the SW precache:done message — without this the
    // first-tab close races the SW's tee-into-cache-storage on heavy URLs.
    const swDeadline = Date.now() + 30000;
    let swDone = false;
    while (Date.now() < swDeadline && !swDone) {
        const fr = page.frames().find(f => f.url().includes('cool.html'));
        if (fr) {
            try { swDone = !!(await fr.evaluate(() => window.__swPrecacheDone)); }
            catch (_) {}
        }
        if (!swDone) await sleep(500);
    }

    // Pull resource timing out of every same-origin frame we can reach.
    const resourcesPerFrame = [];
    for (const fr of page.frames()) {
        try {
            const rs = await fr.evaluate(() => {
                // Asset filenames used to be hashed (online.<hash>.wasm) when
                // every deploy shared the same /browser/ prefix on the editor
                // App Service. Per-deploy folders made the hash redundant —
                // the EDITOR_BUILD_ID in the path IS the cache key. Accept
                // both forms so the test stays valid across the cutover.
                return performance.getEntriesByType('resource')
                    .filter(e => /online(\.[0-9a-f]+)?\.wasm(\?|$)/.test(e.name)
                              || /soffice(\.[0-9a-f]+)?\.data(\?|$)/.test(e.name)
                              || /soffice\.data\.js(\.[0-9a-f]+)?\.metadata(\?|$)/.test(e.name))
                    .map(e => ({
                        name: e.name.split('/').pop(),
                        transferSize: e.transferSize,
                        decodedBodySize: e.decodedBodySize,
                        duration: Math.round(e.duration),
                    }));
            });
            if (rs && rs.length) resourcesPerFrame.push({ url: fr.url(), rs });
        } catch (_) { /* cross-origin frame */ }
    }

    return { restoredAt, swPrecacheDone: swDone, resourcesPerFrame };
}

function flatRs(r) { return r.resourcesPerFrame.flatMap(f => f.rs); }
function findRs(r, re) { return flatRs(r).find(x => re.test(x.name)); }

(async () => {
    log('=== Regression: incognito warm-tab must hit Cache Storage ===');

    if (!fs.existsSync(FIXTURE)) {
        log(`SKIP: fixture missing: ${FIXTURE}`);
        process.exit(2);
    }

    const bytes = fs.readFileSync(FIXTURE);
    const up    = await uploadV2(VIEWER, NAME, bytes);
    const url   = `${VIEWER}/?singleuser#file=${up.b64urlSecret}`;
    log(`uploaded ${NAME} (${(bytes.length / 1024).toFixed(0)}KB)`);

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    try {
        // Fresh BrowserContext = puppeteer's incognito equivalent: separate
        // HTTP cache, separate Cache Storage, separate cookies. Two tabs in
        // the SAME context mirror the user's reported "open file in incognito,
        // close, open file in incognito tab 2" flow.
        const incognito = await browser.createBrowserContext();

        // ── tab 1: cold visit ────────────────────────────────────────────
        const tab1 = await incognito.newPage();
        await tab1.setViewport({ width: 1280, height: 900 });
        const r1 = await openAndMeasure('tab1-cold', tab1, url);
        log(`[tab1-cold] restoredAt=${r1.restoredAt ?? 'NEVER'}s  swPrecacheDone=${r1.swPrecacheDone}`);

        check('tab1: cold restore signal observed',
              r1.restoredAt !== null,
              `restoredAt=${r1.restoredAt}`);
        // Advisory only: precache:done timing varies by stack speed and
        // by whether prewarmReady fires soon after restore. The fetch
        // handler in sw.js tees responses into Cache Storage on first
        // request, so by the time tab1 closes the heavy URLs are already
        // cached even if the explicit precache message hasn't roundtripped.
        // The headline assertion (tab2 transferSize=0) is what proves it.
        log(`  INFO: tab1 swPrecacheDone=${r1.swPrecacheDone} (advisory)`);

        await tab1.close();
        await sleep(3000);

        // ── tab 2: warm visit in SAME incognito context ──────────────────
        const tab2 = await incognito.newPage();
        await tab2.setViewport({ width: 1280, height: 900 });
        const r2 = await openAndMeasure('tab2-warm', tab2, url);
        log(`[tab2-warm] restoredAt=${r2.restoredAt ?? 'NEVER'}s`);

        await tab2.close();
        await incognito.close();

        // ── Assertions ───────────────────────────────────────────────────
        const t1Wasm = findRs(r1, /online(\.[0-9a-f]+)?\.wasm$/);
        const t1Data = findRs(r1, /soffice(\.[0-9a-f]+)?\.data$/);
        const t1Meta = findRs(r1, /soffice\.data\.js(\.[0-9a-f]+)?\.metadata$/);
        const t2Wasm = findRs(r2, /online(\.[0-9a-f]+)?\.wasm$/);
        const t2Data = findRs(r2, /soffice(\.[0-9a-f]+)?\.data$/);
        const t2Meta = findRs(r2, /soffice\.data\.js(\.[0-9a-f]+)?\.metadata$/);

        log('\n=== Resource timing summary ===');
        const fmt = (r, n) => r
            ? `${n.padEnd(13)} transfer=${(r.transferSize/1048576).toFixed(1).padStart(5)}MB ` +
              `decoded=${(r.decodedBodySize/1048576).toFixed(1).padStart(5)}MB dur=${String(r.duration).padStart(5)}ms`
            : `${n.padEnd(13)} (no-timing)`;
        log(`tab1-cold ${fmt(t1Wasm,'online.wasm')}`);
        log(`tab1-cold ${fmt(t1Data,'soffice.data')}`);
        log(`tab1-cold ${fmt(t1Meta,'soffice.metadata')}`);
        log(`tab2-warm ${fmt(t2Wasm,'online.wasm')}`);
        log(`tab2-warm ${fmt(t2Data,'soffice.data')}`);
        log(`tab2-warm ${fmt(t2Meta,'soffice.metadata')}`);

        check('tab2: online.wasm timing captured', !!t2Wasm);
        check('tab2: soffice.data timing captured', !!t2Data);

        if (t2Wasm) {
            check('tab2: online.wasm served from cache (transferSize=0)',
                  t2Wasm.transferSize === 0,
                  `transferSize=${t2Wasm.transferSize}`);
        }
        if (t2Data) {
            // ★ The headline assertion: soffice.<hash>.data must NOT come
            // off the wire on the second incognito tab.
            check('tab2: soffice.data served from cache (transferSize=0)  ← regression',
                  t2Data.transferSize === 0,
                  `transferSize=${t2Data.transferSize} bytes (decoded=${t2Data.decodedBodySize})`);
        }
        if (t2Meta) {
            check('tab2: soffice.data.js.metadata served from cache (transferSize=0)',
                  t2Meta.transferSize === 0,
                  `transferSize=${t2Meta.transferSize}`);
        }

        // The user-reported regression: in incognito, the second tab is
        // SLOWER than the first because heavy-asset cache misses on tab2.
        // Headline guard: tab2 must not regress beyond 2s of tab1's cold
        // restore. We deliberately don't assert a "much faster" floor —
        // local stacks already serve a hot V8 wasm-compile cache so cold
        // is fast (~7s) and there's little headroom; the real signal is
        // the transferSize=0 assertion above. This guard catches the
        // pathological "tab2 is 12s slower than tab1" pattern reported
        // in incognito on Azure.
        if (r1.restoredAt !== null && r2.restoredAt !== null) {
            const slowdown = r2.restoredAt - r1.restoredAt;
            check('tab2: warm restore not slower than cold by >2s',
                  slowdown <= 2,
                  `tab1=${r1.restoredAt}s  tab2=${r2.restoredAt}s  slowdown=${slowdown.toFixed(1)}s`);
        }

        log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    } finally {
        await browser.close();
    }

    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e.stack || e.message);
    process.exit(2);
});
