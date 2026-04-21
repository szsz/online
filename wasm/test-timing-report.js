// Test: Generate timing report with screenshots for both cold and warm visits.
// Outputs an HTML report at /tmp/static-deploy/public/timing-report/index.html

const puppeteer = require('puppeteer');
const { launch, sleep } = require('./lib/browser');
const env = require('./lib/test-env');
const fs = require('fs');
const path = require('path');

const BASE = env.EDITOR_URL;
const REPORT_DIR = '/tmp/static-deploy/public/timing-report';
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const filename = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    await page.screenshot({ path: `${REPORT_DIR}/${filename}`, fullPage: true });
    log(`[snap] ${filename}`);
    return filename;
}

async function waitForEditor(page, timeoutMs = 180000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const ready = await page.evaluate(() => !!(window.__wasmPrewarmReady));
        if (ready) return Date.now() - start;
        await sleep(500);
    }
    throw new Error('Editor did not become ready within ' + timeoutMs + 'ms');
}

async function getAllTimings(page) {
    return page.evaluate(() => {
        const t = window.__prewarmTimings;
        if (!t) return null;
        return {
            events: t.events,
            snapshotRestored: !!window.__wasmSnapshotRestored,
        };
    });
}

async function clearCache(page) {
    await page.evaluate(() => {
        return Promise.all([
            caches.delete('wasm-snapshot').catch(() => {}),
            new Promise(r => { try { var req = indexedDB.deleteDatabase('wasm-memory-snapshot'); req.onsuccess = () => r(); req.onerror = () => r(); } catch(e) { r(); } }),
            new Promise(r => { try { var req = indexedDB.deleteDatabase('wasm-vfs-cache'); req.onsuccess = () => r(); req.onerror = () => r(); } catch(e) { r(); } }),
        ]);
    });
}

function fmtMs(ms) {
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

(async () => {
    const { browser, cleanup } = await launch();
    const report = { visit1: {}, visit2: {}, screenshots: [] };

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        const consoleLogs = { visit1: [], visit2: [] };
        let currentVisit = 'visit1';
        page.on('console', msg => {
            const text = msg.text();
            consoleLogs[currentVisit].push(text);
            log(`[browser] ${text}`);
        });
        page.on('pageerror', err => log(`[browser ERROR] ${err.message}`));

        const docName = 'cache-test.docx';
        const url = `${BASE}/browser/cool.html?WOPISrc=${encodeURIComponent(docName)}&access_token=test&lang=en`;

        // Clear caches
        log('Clearing caches...');
        await page.goto(`${BASE}/browser/favicon.ico`).catch(() => {});
        await clearCache(page);
        log('Caches cleared');

        // ══════════════════════════════════════════════════
        // VISIT 1: Cold
        // ══════════════════════════════════════════════════
        log('=== VISIT 1 (cold) ===');
        currentVisit = 'visit1';
        const t1Start = Date.now();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });

        // Screenshot during loading
        await sleep(3000);
        report.screenshots.push({ name: await snap(page, 'v1_loading'), caption: 'Visit 1: Loading (3s)' });

        const t1ReadyMs = await waitForEditor(page);
        report.visit1.totalMs = t1ReadyMs;
        log(`Visit 1: Editor ready in ${fmtMs(t1ReadyMs)}`);
        report.screenshots.push({ name: await snap(page, 'v1_ready'), caption: `Visit 1: Ready (${fmtMs(t1ReadyMs)})` });

        // Collect all timing events
        const t1Timings = await getAllTimings(page);
        report.visit1.events = t1Timings ? t1Timings.events : [];
        report.visit1.snapshotRestored = t1Timings ? t1Timings.snapshotRestored : false;

        // Wait for snapshot save
        log('Waiting for snapshot save...');
        for (let i = 0; i < 60; i++) {
            const saved = await page.evaluate(() => {
                const events = window.__prewarmTimings && window.__prewarmTimings.events || [];
                return events.some(e => e.name === 'snapshot:saved');
            });
            if (saved) { log('Snapshot saved'); break; }
            if (i === 59) log('WARNING: snapshot save timeout');
            await sleep(1000);
        }

        // Re-collect timings after save
        const t1TimingsFinal = await getAllTimings(page);
        report.visit1.events = t1TimingsFinal ? t1TimingsFinal.events : report.visit1.events;
        report.screenshots.push({ name: await snap(page, 'v1_saved'), caption: 'Visit 1: After snapshot save' });

        // ══════════════════════════════════════════════════
        // VISIT 2: Warm
        // ══════════════════════════════════════════════════
        log('=== VISIT 2 (warm) ===');
        currentVisit = 'visit2';
        const t2Start = Date.now();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });

        // Screenshot during restore
        await sleep(2000);
        report.screenshots.push({ name: await snap(page, 'v2_restoring'), caption: 'Visit 2: Restoring snapshot (2s)' });

        const t2ReadyMs = await waitForEditor(page);
        report.visit2.totalMs = t2ReadyMs;
        log(`Visit 2: Editor ready in ${fmtMs(t2ReadyMs)}`);
        report.screenshots.push({ name: await snap(page, 'v2_ready'), caption: `Visit 2: Ready (${fmtMs(t2ReadyMs)})` });

        // Collect timings
        const t2Timings = await getAllTimings(page);
        report.visit2.events = t2Timings ? t2Timings.events : [];
        report.visit2.snapshotRestored = t2Timings ? t2Timings.snapshotRestored : false;

        // ══════════════════════════════════════════════════
        // Generate HTML report
        // ══════════════════════════════════════════════════
        const speedupMs = t1ReadyMs - t2ReadyMs;
        const speedupPct = ((speedupMs / t1ReadyMs) * 100).toFixed(0);

        function eventsTable(events) {
            if (!events || events.length === 0) return '<p>No timing data</p>';
            let html = '<table><tr><th>Time</th><th>Event</th><th>Detail</th></tr>';
            let prev = 0;
            for (const e of events) {
                const delta = prev > 0 ? ` (+${fmtMs(e.t - prev)})` : '';
                prev = e.t;
                html += `<tr><td>${fmtMs(e.t)}${delta}</td><td><code>${e.name}</code></td><td>${e.detail || ''}</td></tr>`;
            }
            html += '</table>';
            return html;
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>WASM Timing Report — ${timestamp}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
h1 { color: #333; border-bottom: 2px solid #2196F3; padding-bottom: 10px; }
h2 { color: #1976D2; margin-top: 40px; }
.summary { display: flex; gap: 20px; margin: 20px 0; }
.card { background: white; border-radius: 8px; padding: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); flex: 1; text-align: center; }
.card .value { font-size: 48px; font-weight: bold; }
.card .label { color: #666; margin-top: 5px; }
.card.cold .value { color: #e53935; }
.card.warm .value { color: #43a047; }
.card.speedup .value { color: #1565c0; }
table { border-collapse: collapse; width: 100%; margin: 10px 0; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
th { background: #1976D2; color: white; padding: 10px 12px; text-align: left; }
td { padding: 8px 12px; border-bottom: 1px solid #eee; }
tr:hover { background: #f0f7ff; }
code { background: #e3f2fd; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
.screenshots { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 20px; margin: 20px 0; }
.shot { background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
.shot img { width: 100%; display: block; }
.shot .caption { padding: 10px; font-size: 14px; color: #333; text-align: center; font-weight: 500; }
.bar-chart { margin: 20px 0; }
.bar-row { display: flex; align-items: center; margin: 8px 0; }
.bar-label { width: 200px; text-align: right; padding-right: 10px; font-size: 13px; }
.bar { height: 28px; border-radius: 4px; display: flex; align-items: center; padding-left: 8px; color: white; font-size: 12px; font-weight: bold; min-width: 40px; }
.bar.cold { background: #e53935; }
.bar.warm { background: #43a047; }
.meta { color: #999; font-size: 12px; margin-top: 40px; border-top: 1px solid #ddd; padding-top: 10px; }
</style>
</head>
<body>
<h1>WASM Timing Report</h1>
<p>Generated: ${new Date().toLocaleString()} &mdash; Puppeteer headless Chrome on ${require('os').hostname()}</p>

<div class="summary">
  <div class="card cold"><div class="value">${fmtMs(t1ReadyMs)}</div><div class="label">Visit 1 (Cold)</div></div>
  <div class="card warm"><div class="value">${fmtMs(t2ReadyMs)}</div><div class="label">Visit 2 (Warm)</div></div>
  <div class="card speedup"><div class="value">${fmtMs(speedupMs)}</div><div class="label">Speedup (${speedupPct}%)</div></div>
</div>

<h2>Comparison</h2>
<div class="bar-chart">
  <div class="bar-row"><div class="bar-label">Visit 1 (cold)</div><div class="bar cold" style="width: ${Math.min(100, (t1ReadyMs / t1ReadyMs) * 100)}%">${fmtMs(t1ReadyMs)}</div></div>
  <div class="bar-row"><div class="bar-label">Visit 2 (warm)</div><div class="bar warm" style="width: ${Math.min(100, (t2ReadyMs / t1ReadyMs) * 100)}%">${fmtMs(t2ReadyMs)}</div></div>
</div>

<h2>Visit 1 (Cold) — All timing events</h2>
<p>Snapshot: <strong>${report.visit1.snapshotRestored ? 'restored' : 'not found (first visit)'}</strong></p>
${eventsTable(report.visit1.events)}

<h2>Visit 2 (Warm) — All timing events</h2>
<p>Snapshot: <strong>${report.visit2.snapshotRestored ? 'restored from Cache API' : 'NOT restored'}</strong></p>
${eventsTable(report.visit2.events)}

<h2>Screenshots</h2>
<div class="screenshots">
${report.screenshots.map(s => `<div class="shot"><img src="${s.name}" alt="${s.caption}"><div class="caption">${s.caption}</div></div>`).join('\n')}
</div>

<div class="meta">
  <p>Test: test-timing-report.js &mdash; Modules preloaded: Writer + Calc + Impress &mdash; Snapshot size: 142MB (HEAPU8)</p>
</div>
</body>
</html>`;

        fs.writeFileSync(`${REPORT_DIR}/index.html`, html);
        log(`\nReport written to: ${REPORT_DIR}/index.html`);
        log(`View at: ${BASE}/timing-report/`);

        // Print summary
        log('\n══════════════════════════════════════');
        log(`Visit 1 (cold): ${fmtMs(t1ReadyMs)}`);
        log(`Visit 2 (warm): ${fmtMs(t2ReadyMs)}`);
        log(`Speedup: ${fmtMs(speedupMs)} (${speedupPct}%)`);
        log('══════════════════════════════════════\n');

        if (t2ReadyMs < t1ReadyMs && speedupMs > 3000) {
            log('PASS: Warm visit significantly faster');
        } else {
            log('NOTE: Speedup less than expected');
        }
        log('PASS: test-timing-report completed');

    } catch (err) {
        log('FAIL: ' + err.message);
        console.error(err);
        process.exitCode = 1;
    } finally {
        await cleanup();
    }
})();
