// Deep profiling: show exactly where the ~40s document load goes.
// Runs two loads and dumps:
//  1. wasm-loader mark() events (from window.__prewarmTimings)
//  2. Performance Resource Timing (network waterfall for biggest resources)
//  3. CDP Network events for timing breakdown (DNS / TLS / request / response / content)

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');

const EDITOR = env.EDITOR_URL;
const VIEWER = env.FILE_STORAGE_URL;
const DOC_NAME = 'profile-doc.docx';
const DOC_PATH = path.join(__dirname, '..', 'test', 'data', 'test document.docx');
const RENDER_TIMEOUT = 120000;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const T0 = Date.now();
function elapsed() { return ((Date.now() - T0) / 1000).toFixed(1) + 's'; }
function log(m) { console.log(`[${elapsed()}] ${m}`); }

async function waitForDoc(frame, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
        try {
            const r = await frame.evaluate(() => {
                const wc = document.querySelector('#StateWordCount');
                const dp = document.querySelector('#StatusDocPos');
                return {
                    words: wc?.textContent || '',
                    sheet: dp?.textContent || '',
                };
            });
            const m = r.words.match(/([\d,]+)\s+words/);
            const words = m ? parseInt(m[1].replace(/,/g, '')) : 0;
            if (words > 100 || r.sheet.includes('Sheet')) return { ok: true, took: Date.now() - t0 };
        } catch(e) {}
        await sleep(200);
    }
    return { ok: false, took: Date.now() - t0 };
}

async function profileLoad(browser, label, url, useCdp) {
    log(`\n═══ ${label} ═══`);
    const context = await browser.createBrowserContext(); // clean cache per context
    const page = await context.newPage();

    // CDP network events for waterfall
    const client = await page.createCDPSession();
    await client.send('Network.enable');
    const net = new Map(); // requestId -> {url, timings}

    client.on('Network.requestWillBeSent', e => {
        net.set(e.requestId, { url: e.request.url, method: e.request.method, sendTime: e.wallTime, timing: {} });
    });
    client.on('Network.responseReceived', e => {
        const r = net.get(e.requestId);
        if (!r) return;
        r.status = e.response.status;
        r.fromCache = !!e.response.fromDiskCache;
        r.fromSwCache = !!e.response.fromServiceWorker;
        r.contentEncoding = e.response.headers['content-encoding'] || '';
        r.contentLength = parseInt(e.response.headers['content-length'] || '0');
        r.mimeType = e.response.mimeType;
        r.timing = e.response.timing || {};
    });
    client.on('Network.loadingFinished', e => {
        const r = net.get(e.requestId);
        if (!r) return;
        r.encodedDataLength = e.encodedDataLength;
        r.finishTime = e.timestamp;
    });

    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    const t0 = Date.now();
    log(`[${label}] navigating...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    log(`[${label}] domcontentloaded at ${Date.now() - t0}ms`);

    const res = await waitForDoc(page.mainFrame(), RENDER_TIMEOUT);
    const totalMs = Date.now() - t0;
    log(`[${label}] doc rendered=${res.ok} total=${totalMs}ms`);

    // Pull timings from the page
    const marks = await page.evaluate(() =>
        window.__prewarmTimings ? window.__prewarmTimings.events.slice() : []
    );
    log(`[${label}] ── wasm-loader events (${marks.length}) ──`);
    let prev = 0;
    for (const m of marks) {
        const delta = m.t - prev;
        console.log(`  +${m.t.toFixed(1).padStart(8)}ms  (Δ${delta.toFixed(0).padStart(5)}ms)  ${m.name}${m.detail ? '  ' + m.detail : ''}`);
        prev = m.t;
    }

    // Performance Resource Timing — top 10 by duration
    const resources = await page.evaluate(() =>
        performance.getEntriesByType('resource')
            .map(e => ({
                name: e.name.substring(e.name.lastIndexOf('/')+1).split('?')[0],
                duration: e.duration,
                transfer: e.transferSize,
                decoded: e.decodedBodySize,
                startTime: e.startTime,
            }))
    );
    const heaviest = resources.sort((a,b) => b.duration - a.duration).slice(0, 10);
    log(`[${label}] ── Top 10 slowest network requests ──`);
    heaviest.forEach(r => {
        console.log(`   ${r.duration.toFixed(0).padStart(6)}ms  ${(r.transfer/1024).toFixed(0).padStart(6)}KB xfer  ${(r.decoded/1024).toFixed(0).padStart(7)}KB decoded  ${r.name}`);
    });

    // CDP timing breakdown for .wasm and .data
    log(`[${label}] ── CDP detailed timing (wasm/data) ──`);
    for (const [id, r] of net) {
        if (!/online\.wasm|soffice\.data/.test(r.url)) continue;
        const t = r.timing || {};
        const totalConn = (t.connectEnd - t.connectStart) || 0;
        const ttfb = (t.receiveHeadersEnd - t.sendEnd) || 0;
        console.log(`   ${r.url.substring(r.url.lastIndexOf('/')+1)}` +
            `  status=${r.status}  cache=${r.fromCache ? 'DISK' : 'NET'}` +
            `  encoding=${r.contentEncoding}` +
            `  bytes=${r.encodedDataLength || r.contentLength}` +
            `  conn=${totalConn.toFixed(0)}ms  ttfb=${ttfb.toFixed(0)}ms`);
    }

    if (pageErrors.length) {
        log(`[${label}] Page errors (${pageErrors.length}):`);
        pageErrors.slice(0, 5).forEach(e => console.log('    ' + e.substring(0, 200)));
    }

    // Summary: key durations
    const eventMap = {};
    marks.forEach(m => { eventMap[m.name] = m.t; });
    const summary = [
        ['Script start → online.js written',  eventMap['loader:online.js_written']],
        ['→ Module defined',                   eventMap['emscripten:module_defined']],
        ['→ WASM exports ready',               eventMap['emscripten:wasmExports_ready']],
        ['→ FS ready',                          eventMap['emscripten:FS_ready']],
        ['→ Module.calledRun',                  eventMap['emscripten:calledRun']],
        ['→ First canvas',                      eventMap['dom:first_canvas']],
        ['→ Status element appeared',           eventMap['dom:status_appeared']],
        ['→ Document fully loaded',             eventMap['doc:loaded']],
        ['→ prewarm:ready',                     eventMap['prewarm:ready']],
    ];
    log(`[${label}] ── Milestone timeline ──`);
    let lastT = 0;
    for (const [name, t] of summary) {
        if (t === undefined) continue;
        console.log(`   +${t.toFixed(0).padStart(6)}ms  (Δ${(t - lastT).toFixed(0).padStart(5)}ms)  ${name}`);
        lastT = t;
    }

    await context.close();
    return { totalMs, marks, pageErrors };
}

(async () => {
    log('=== Document Load Profile ===');

    if (!fs.existsSync(DOC_PATH)) { log('Fixture missing'); process.exit(1); }

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    try {
        // Upload the doc
        const up = await browser.newPage();
        await up.goto(EDITOR, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
        const bytes = fs.readFileSync(DOC_PATH);
        await up.evaluate(async (url, name, arr) => {
            await fetch(url + '/wasm/' + encodeURIComponent(name), {
                method: 'POST', body: new Blob([new Uint8Array(arr)]),
            });
        }, EDITOR, DOC_NAME, Array.from(bytes));
        await up.close();

        const editorUrl = EDITOR + '/browser/cool.html?WOPISrc=' + encodeURIComponent(DOC_NAME) + '&access_token=test';

        // Profile 1: cold (fresh context)
        const cold = await profileLoad(browser, 'COLD (fresh cache)', editorUrl, true);

        // Profile 2: warm (re-use browser, disk cache should help)
        // We need to hit the same origin in the same browser context after the cold run
        // but since we used createBrowserContext, caches are isolated. Let's do a warm
        // load using a 2nd context that pre-warms assets first.
        log('\n═══ Pre-warming context for WARM run ═══');
        const warmCtx = await browser.createBrowserContext();
        const warmPre = await warmCtx.newPage();
        await warmPre.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await waitForDoc(warmPre.mainFrame(), RENDER_TIMEOUT);
        await warmPre.close();
        log('Pre-warm done; now measuring warm load in same context');

        // Open a new page in the same context (shares cache)
        const warmPage = await warmCtx.newPage();
        const client = await warmPage.createCDPSession();
        await client.send('Network.enable');
        const net = new Map();
        client.on('Network.requestWillBeSent', e => net.set(e.requestId, { url: e.request.url }));
        client.on('Network.responseReceived', e => {
            const r = net.get(e.requestId); if (!r) return;
            r.status = e.response.status;
            r.fromCache = !!e.response.fromDiskCache;
            r.contentEncoding = e.response.headers['content-encoding'] || '';
        });

        const wt0 = Date.now();
        await warmPage.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const wres = await waitForDoc(warmPage.mainFrame(), RENDER_TIMEOUT);
        const warmMs = Date.now() - wt0;
        log(`\n[WARM] rendered=${wres.ok} total=${warmMs}ms`);

        const wmarks = await warmPage.evaluate(() => window.__prewarmTimings?.events || []);
        log(`[WARM] wasm-loader events (${wmarks.length}):`);
        let p = 0;
        wmarks.forEach(m => {
            console.log(`  +${m.t.toFixed(1).padStart(8)}ms  (Δ${(m.t - p).toFixed(0).padStart(5)}ms)  ${m.name}${m.detail?'  '+m.detail:''}`);
            p = m.t;
        });
        // WASM/data cache status
        log('[WARM] critical resources cache status:');
        for (const [, r] of net) {
            if (/online\.wasm|soffice\.data|online\.js($|\?)|bundle\.js/.test(r.url)) {
                console.log(`   ${r.url.substring(r.url.lastIndexOf('/')+1)}  status=${r.status}  diskCache=${r.fromCache}  encoding=${r.contentEncoding}`);
            }
        }

        await warmCtx.close();

        log(`\n═══ SUMMARY ═══`);
        log(`Cold total: ${cold.totalMs}ms`);
        log(`Warm total: ${warmMs}ms`);
        log(`Speedup:    ${cold.totalMs - warmMs}ms`);
    } finally {
        await browser.close();
    }
})();
