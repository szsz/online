const __cl = require('./lib/inject-checklist');
// Prewarm Benchmark: measures document open timing for every phase.
// Tests each doc type (docx, xlsx, pptx) with simple + complex files.
// For each: first visit (cold, WASM compile) and return visit (warm, code cache).
// Generates a detailed HTML report with timing tables.

const { launch, sleep } = require('./lib/browser');
const fs = require('fs'), path = require('path');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');
const VIEWER = env.FILE_STORAGE_URL;
const EDITOR = env.EDITOR_URL;
const SHOTS = '/tmp/static-deploy/public/shots-prewarm-benchmark';
const REPORT = '/tmp/static-deploy/public/reports/prewarm-benchmark-detail.html';

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) console.log(`  ✓ ${label}`);
    else { console.log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

const TEST_DOCS = [
    { name: 'new.docx',           type: 'writer',  complexity: 'simple',  src: 'test/data/new.docx' },
    { name: 'chart-test.docx',    type: 'writer',  complexity: 'complex', src: 'test/data/chart-test.docx' },
    { name: 'rare-fonts.xlsx',    type: 'calc',     complexity: 'simple',  src: 'test/data/rare-fonts.xlsx' },
    { name: 'load12.ods',         type: 'calc',     complexity: 'complex', src: 'test/data/load12.ods' },
    // rare-fonts.pptx and graphicviewselection.odp: LO-WASM on Azure never
    // fires the "Slide N of M" statusbar signal for these even at 7+ min;
    // skip from the benchmark matrix until impress-ready detection is
    // fixed. Impress paths are still covered by test-pptx-viewer +
    // test-pptx-coedit.
    // { name: 'rare-fonts.pptx',    type: 'impress',  ...
    // { name: 'graphicviewselection.odp', type: 'impress', ...
];

(async () => {
    fs.rmSync(SHOTS, { recursive: true, force: true });
    fs.mkdirSync(SHOTS, { recursive: true });

    const results = []; // { doc, visit, timings, perfEntries }

    // Upload all test docs via v2 (encrypted). Each doc gets its own
    // {fileId, b64urlSecret}; we store them on the TEST_DOCS entry so
    // the measurement phase can navigate to /#file=<secret>.
    for (const doc of TEST_DOCS) {
        const bytes = fs.readFileSync(path.join(__dirname, '..', doc.src));
        const up = await uploadV2(VIEWER, doc.name, bytes);
        doc.fileId = up.fileId;
        doc.b64urlSecret = up.b64urlSecret;
        console.log('[setup] Uploaded v2 ' + doc.name + ' (' + bytes.length + 'B) → ' + up.fileId.substring(0,8) + '…');
    }

    // Measure each doc: first visit (fresh browser) + return visit (same browser, reload)
    for (const doc of TEST_DOCS) {
        console.log('\n========================================');
        console.log('  ' + doc.name + ' (' + doc.type + ', ' + doc.complexity + ')');
        console.log('========================================');

        for (const visit of ['first', 'return']) {
            console.log('\n--- ' + visit + ' visit ---');
            // For "first visit": fresh browser (no cache, no compiled WASM)
            // For "return visit": same browser instance, navigate away then back
            const { browser, cleanup } = await launch();
            const page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 900 });

            if (visit === 'return') {
                // First load to warm the cache + compile WASM
                console.log('  (warming cache...)');
                await page.goto(VIEWER + '/#file=' + doc.b64urlSecret, {
                    waitUntil: 'domcontentloaded' });
                // Wait for editor to be fully ready, with a hard 240s
                // wall deadline. Abort early on __wasmInitialDocLoaded
                // — a transient miss on the heuristic regex would
                // otherwise burn the full 7.5min loop.
                {
                    const warmDeadline = Date.now() + env.scaleTimeout(240000);
                    while (Date.now() < warmDeadline) {
                        await sleep(500);
                        const fr = page.frames().find(f => f.url().includes('cool.html'));
                        if (fr) {
                            const probe = await fr.evaluate(() => {
                                var wc = document.querySelector('#StateWordCount')?.textContent || '';
                                var dp = document.querySelector('#StatusDocPos')?.textContent || '';
                                return {
                                    status: wc + '|' + dp,
                                    docLoaded: !!window.__wasmInitialDocLoaded,
                                    hasWs: typeof globalThis.TheFakeWebSocket !== 'undefined',
                                };
                            }).catch(() => ({ status: '', docLoaded: false, hasWs: false }));
                            const statusOk = /character|Sheet \d|Slide \d/i.test(probe.status);
                            if ((statusOk || probe.docLoaded) && probe.hasWs) break;
                        }
                    }
                }
                console.log('  (cache warm, navigating away...)');
                await page.goto('about:blank');
                await sleep(2000);
                console.log('  (now timing the return visit...)');
            }

            const t0 = Date.now();
            await page.goto(VIEWER + '/#file=' + doc.b64urlSecret, {
                waitUntil: 'domcontentloaded' });
            const tDom = Date.now() - t0;

            let editorFrame;
            {
                // Hard 450 s deadline — matches the assert at line ~195
                // (`tTotal < 450000`). Aborts early on
                // __wasmInitialDocLoaded so a heuristic-regex miss
                // doesn't burn the full budget. Scaled under JOBS_SCALE
                // so contention runs don't spuriously time out.
                const visitDeadline = Date.now() + env.scaleTimeout(450000);
                while (Date.now() < visitDeadline) {
                    await sleep(500);
                    editorFrame = page.frames().find(f => f.url().includes('cool.html'));
                    if (editorFrame) {
                        const probe = await editorFrame.evaluate(() => {
                            var wc = document.querySelector('#StateWordCount')?.textContent || '';
                            var dp = document.querySelector('#StatusDocPos')?.textContent || '';
                            return {
                                status: wc + '|' + dp,
                                docLoaded: !!window.__wasmInitialDocLoaded,
                                hasWs: typeof globalThis.TheFakeWebSocket !== 'undefined',
                            };
                        }).catch(() => ({ status: '', docLoaded: false, hasWs: false }));
                        const statusOk = /character|Sheet \d|Slide \d/i.test(probe.status);
                        if ((statusOk || probe.docLoaded) && probe.hasWs) break;
                    }
                }
            }
            const tTotal = Date.now() - t0;

            // Extract profiling timeline
            let timings = null;
            let perfEntries = [];
            if (editorFrame) {
                timings = await editorFrame.evaluate(() => {
                    if (!window.__prewarmTimings) return null;
                    return { events: window.__prewarmTimings.events };
                }).catch(() => null);

                perfEntries = await editorFrame.evaluate(() => {
                    return performance.getEntriesByType('resource').map(e => ({
                        name: e.name.split('/').pop().split('?')[0],
                        start: Math.round(e.startTime),
                        duration: Math.round(e.duration),
                        transfer: e.transferSize,
                        decoded: e.decodedBodySize,
                        cached: e.transferSize === 0 && e.decodedBodySize > 0,
                    })).filter(e => e.decoded > 10000).sort((a, b) => a.start - b.start);
                }).catch(() => []);

                await page.screenshot({ path: `${SHOTS}/${doc.name}_${visit}.png` });
            }

            // Parse key phases from timeline
            const phases = {};
            if (timings && timings.events.length > 0) {
                const ev = timings.events;
                const find = (name) => ev.find(e => e.name === name);
                const findT = (name) => { const e = find(name); return e ? e.t : null; };

                phases.loaderStart = findT('loader:start') || 0;
                phases.wasmFetchStart = findT('net:fetch_start');
                phases.wasmFetchEnd = ev.filter(e => e.name === 'net:fetch_end' && (e.detail || '').includes('online.wasm'))[0]?.t;
                phases.calledRun = findT('emscripten:calledRun');
                phases.docLoaded = findT('doc:loaded');
                phases.prewarmReady = findT('prewarm:ready');
                phases.switchSeen = findT('bridge:switchdoc_seen');
                phases.switchSent = findT('bridge:switchdoc_sent');
                phases.canvasVisible = findT('bridge:canvas_visible');
                phases.docReady = findT('bridge:doc_ready');

                // Derived durations
                phases.wasmFetchMs = (phases.wasmFetchEnd && phases.wasmFetchStart) ?
                    Math.round(phases.wasmFetchEnd - phases.wasmFetchStart) : null;
                phases.wasmCompileMs = (phases.calledRun && phases.wasmFetchEnd) ?
                    Math.round(phases.calledRun - phases.wasmFetchEnd) : null;
                phases.loInitMs = (phases.docLoaded && phases.calledRun) ?
                    Math.round(phases.docLoaded - phases.calledRun) : null;
                phases.hotSwitchMs = (phases.canvasVisible && phases.switchSent) ?
                    Math.round(phases.canvasVisible - phases.switchSent) : null;
            }

            // Check WASM cache status
            const wasmEntry = perfEntries.find(e => e.name.includes('online.wasm'));
            const wasmCached = wasmEntry ? wasmEntry.cached : false;

            const result = {
                doc: doc.name, type: doc.type, complexity: doc.complexity,
                visit, tTotal, tDom, phases, wasmCached, perfEntries
            };
            results.push(result);

            const wasmFetch = phases.wasmFetchMs != null ? phases.wasmFetchMs + 'ms' : '?';
            const wasmCompile = phases.wasmCompileMs != null ? phases.wasmCompileMs + 'ms' : '?';
            const loInit = phases.loInitMs != null ? phases.loInitMs + 'ms' : '?';
            const hotSwitch = phases.hotSwitchMs != null ? phases.hotSwitchMs + 'ms' : 'N/A';

            console.log(`  Total: ${tTotal}ms | WASM fetch: ${wasmFetch} (${wasmCached ? 'CACHE' : 'NET'}) | Compile: ${wasmCompile} | LO init: ${loInit} | Hot-switch: ${hotSwitch}`);

            // 450s: impress + rare fonts or ODP with complex graphics
            // push past 360s on Azure due to font prefetch + tile render
            // compounded with WAN RTT. Local still completes in <60s.
            //
            // Scaled under JOBS_SCALE so contention runs widen — when
            // measuring real perf, run with JOBS_SCALE=1 (default solo).
            check(doc.name + ' ' + visit + ': loaded',
                  tTotal < env.scaleTimeout(450000),
                  'total=' + tTotal + 'ms');

            await cleanup();
        }
    }

    // Check return visits are faster
    for (const doc of TEST_DOCS) {
        const first = results.find(r => r.doc === doc.name && r.visit === 'first');
        const ret = results.find(r => r.doc === doc.name && r.visit === 'return');
        if (first && ret) {
            check(doc.name + ': return faster than first',
                ret.tTotal < first.tTotal,
                'first=' + first.tTotal + 'ms return=' + ret.tTotal + 'ms');
        }
    }

    // Generate HTML report
    let html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Prewarm Benchmark</title>
<style>
body{font-family:-apple-system,sans-serif;max-width:1100px;margin:0 auto;padding:2rem;background:#fafafa}
h1{font-size:1.5rem;border-bottom:2px solid #e5e7eb;padding-bottom:8px}
h2{font-size:1.1rem;margin-top:2rem}
table{border-collapse:collapse;width:100%;margin:1rem 0;font-size:13px}
th,td{padding:6px 10px;border:1px solid #e5e7eb;text-align:right}
th{background:#f8f9fa;text-align:left;font-weight:600}
td:first-child{text-align:left;font-weight:500}
.cache{color:#16a34a;font-weight:600}
.net{color:#dc2626}
.fast{background:#dcfce7}
.slow{background:#fee2e2}
.result{background:${allPassed ? '#dcfce7' : '#fee2e2'};padding:12px;border-radius:8px;font-weight:600;margin:1rem 0}
img{max-width:48%;border:1px solid #d1d5db;border-radius:4px;margin:4px}
.imgs{display:flex;flex-wrap:wrap;gap:8px}
</style></head><body>
<h1>Prewarm Benchmark — Document Open Timing</h1>
<div style="color:#666;font-size:13px;margin-bottom:12px">Run @ ${new Date().toISOString()}</div>
<div class="result">${allPassed ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}</div>

<h2>Summary</h2>
<table>
<tr><th>Document</th><th>Type</th><th>Size</th><th>Visit</th><th>Total</th><th>WASM Fetch</th><th>WASM Compile</th><th>LO Init</th><th>Hot Switch</th><th>WASM Cache</th></tr>`;

    for (const r of results) {
        const p = r.phases;
        const cls = r.visit === 'return' && r.tTotal < 30000 ? ' class="fast"' : '';
        const docSize = TEST_DOCS.find(d => d.name === r.doc);
        const size = docSize ? fs.statSync(path.join(__dirname, '..', docSize.src)).size : 0;
        const sizeStr = size > 100000 ? (size/1024).toFixed(0) + 'KB' : (size/1024).toFixed(1) + 'KB';
        html += `<tr${cls}>
            <td>${r.doc}</td><td>${r.type}</td><td>${sizeStr}</td>
            <td>${r.visit}</td><td><b>${(r.tTotal/1000).toFixed(1)}s</b></td>
            <td>${p.wasmFetchMs != null ? p.wasmFetchMs + 'ms' : '—'}</td>
            <td>${p.wasmCompileMs != null ? p.wasmCompileMs + 'ms' : '—'}</td>
            <td>${p.loInitMs != null ? (p.loInitMs/1000).toFixed(1) + 's' : '—'}</td>
            <td>${p.hotSwitchMs != null ? p.hotSwitchMs + 'ms' : '—'}</td>
            <td class="${r.wasmCached ? 'cache' : 'net'}">${r.wasmCached ? 'CACHE' : 'NET'}</td></tr>`;
    }
    html += '</table>';

    // Phase breakdown per doc
    for (const doc of TEST_DOCS) {
        html += `<h2>${doc.name} (${doc.type}, ${doc.complexity})</h2><div class="imgs">`;
        for (const visit of ['first', 'return']) {
            const imgFile = `${doc.name}_${visit}.png`;
            if (fs.existsSync(`${SHOTS}/${imgFile}`)) {
                html += `<img src="../shots-prewarm-benchmark/${imgFile}" title="${visit} visit">`;
            }
        }
        html += '</div>';

        // Timeline details
        for (const visit of ['first', 'return']) {
            const r = results.find(rr => rr.doc === doc.name && rr.visit === visit);
            if (!r) continue;
            html += `<h3>${visit} visit — ${(r.tTotal/1000).toFixed(1)}s total</h3>`;
            if (r.perfEntries.length > 0) {
                html += '<table><tr><th>Asset</th><th>Start</th><th>Duration</th><th>Size</th><th>Source</th></tr>';
                for (const e of r.perfEntries.slice(0, 15)) {
                    const mb = (e.decoded / 1048576).toFixed(1);
                    html += `<tr><td>${e.name}</td><td>${e.start}ms</td><td>${e.duration}ms</td>
                        <td>${mb}MB</td><td class="${e.cached ? 'cache' : 'net'}">${e.cached ? 'CACHE' : 'NET'}</td></tr>`;
                }
                html += '</table>';
            }
        }
    }

    html += '</body></html>';
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, html);
    console.log('\nReport: https://wasm.atgpartners.info/reports/prewarm-benchmark-detail.html');
    console.log(allPassed ? '✓ ALL PASSED' : '✗ SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
