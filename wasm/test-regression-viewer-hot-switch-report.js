// E2E viewer hot-switch test that produces a visual report.
// Drives real UI clicks (no JS injection), takes a screenshot at every
// significant moment, records timestamps + per-switch measurements,
// writes /tmp/hot-switch-report/index.html with all artifacts.
const { launch, sleep } = require('./lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');

const VIEWER = env.VIEWER_URL || 'https://viewer.szebeni.hu';
const REPORT_DIR = '/tmp/hot-switch-report';
const SHOTS_DIR = REPORT_DIR + '/shots';

// puppeteer's fileInput.uploadFile(path) presents the file with the
// BASENAME of the source path, so the viewer's display name (cachedName)
// is e.g. "test document.docx". We match clicks by that basename.
// `expect` is the per-fixture status fingerprint that proves THIS file
// is the one rendered (vs the prior doc's status text bleeding through
// during a still-pending switch, which trashed earlier test runs).
//   docx → #StateWordCount  must show 1,652 words
//   xlsx → #StatusDocPos    must show "Sheet 1 of 1"
//   pptx → #SlideStatus     must show "Slide 1 of 4"
const FIXTURES = [
    { label: 'docx', src: '/home/localadmin/online/test/data/test document.docx',
      expect: { field: 'wc', regex: /1[,.]?652\s+words?,\s+9[,.]?159\s+characters?/ } },
    { label: 'xlsx', src: '/home/localadmin/online/test/data/testdoc.xlsx',
      expect: { field: 'sd', regex: /Sheet\s+1\s+of\s+1/ } },
    { label: 'pptx', src: '/home/localadmin/online/test/data/testdoc.pptx',
      expect: { field: 'ss', regex: /Slide\s+1\s+of\s+4/i } },
].map(f => ({ ...f, name: path.basename(f.src) }));

const T0 = Date.now();
function elapsed() { return ((Date.now() - T0) / 1000).toFixed(2) + 's'; }
function ts() { return new Date().toISOString().slice(11, 23); }

const events = [];     // { ts, elapsed, msg, kind }
const shots = [];      // { ts, elapsed, file, label, caption }
const switches = [];   // { from, to, fromName, toName, clickT, shieldUpT, shieldDownT, totalMs, mode, screenshot }

function log(msg, kind = 'info') {
    const e = { ts: ts(), elapsed: elapsed(), msg, kind };
    events.push(e);
    console.log(`[${e.elapsed}] ${msg}`);
}

async function snap(page, label, caption) {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    const fname = `${shots.length.toString().padStart(2, '0')}_${label.replace(/[^a-z0-9-]/gi, '_')}.png`;
    const fpath = path.join(SHOTS_DIR, fname);
    await sleep(200); // let DOM settle
    try { await page.screenshot({ path: fpath, fullPage: false }); } catch(e) {}
    const e = { ts: ts(), elapsed: elapsed(), file: 'shots/' + fname, label, caption };
    shots.push(e);
    log(`📸 ${label}: ${caption}`, 'shot');
    return e;
}

async function listFiles(page) {
    return page.$$eval('#list .file', els => els.map(e => ({
        text: e.textContent.substring(0, 80).trim(),
        fileid: e.dataset.fileid,
    })));
}

async function detectShieldState(page) {
    return page.evaluate(() => {
        const s = document.getElementById('editor-shield');
        if (!s) return { exists: false };
        return {
            exists: true,
            visible: !s.classList.contains('hidden') && getComputedStyle(s).display !== 'none',
            label: document.getElementById('editor-shield-label')?.textContent || '',
        };
    });
}

// Detect actual doc-content readiness in the cool.html iframe.
// The iframe is cross-origin (viewer.szebeni.hu vs wasm.atgpartners.info),
// so parent can't reach contentDocument — use page.frames() to get the
// CDPFrame directly and evaluate inside it.
async function probeIframeContent(page) {
    const frame = page.frames().find(f => f.url().includes('cool.html'));
    if (!frame) return { err: 'no cool iframe' };
    try {
        return await frame.evaluate(() => ({
            wc: document.querySelector('#StateWordCount')?.textContent.trim() || '',
            sd: document.querySelector('#StatusDocPos')?.textContent.trim() || '',
            ss: document.querySelector('#SlideStatus')?.textContent.trim() || '',
            canvasCount: document.querySelectorAll('canvas').length,
            canvasPx: (() => {
                const cv = document.querySelector('canvas');
                if (!cv) return '';
                try {
                    const px = cv.getContext('2d').getImageData(
                        cv.width/2, cv.height/2, 4, 4).data;
                    return Array.from(px).slice(0, 8).join(',');
                } catch(e) { return 'err:' + e.message; }
            })(),
            url: location.href.slice(-100),
        }));
    } catch(e) { return { err: 'frame eval: ' + e.message }; }
}

async function clickFileAndMeasure(page, label, fileMatch, expect) {
    log(`---- click ${label}: ${fileMatch} ----`, 'click');
    const beforeProbe = await probeIframeContent(page);
    log(`pre-click iframe state: ${JSON.stringify(beforeProbe)}`);
    await snap(page, `before-click-${label}`, `Before clicking ${fileMatch}`);

    const clickT = Date.now();
    const ok = await page.evaluate((m) => {
        for (const el of document.querySelectorAll('#list .file')) {
            if ((el.textContent || '').includes(m)) { el.click(); return true; }
        }
        return false;
    }, fileMatch);
    if (!ok) throw new Error('No file matched: ' + fileMatch);

    // Three independent signals must all be true before declaring
    // contentReady:
    //   1. Shield went UP and then came BACK DOWN. Viewer's
    //      tryDropShield only drops on docReady && relayActivated.
    //      Earlier test ignored shield-down and passed instantly on
    //      any non-empty status field — but the prior doc's status
    //      text persists in the iframe DOM during a stuck switch, so
    //      the test reported success while screenshots showed the
    //      shield with "Loading document…" still up.
    //   2. The fixture-specific `expect.field` matches `expect.regex`.
    //      The regex is unique to THIS file (e.g. "1,652 words…" for
    //      test document.docx, "Sheet 1 of 1" for testdoc.xlsx,
    //      "Slide 1 of 4" for testdoc.pptx). Generic "Sheet N of N"
    //      from the prior xlsx will not match an expected pptx test.
    //   3. The iframe's canvas has non-transparent pixels at center —
    //      proves the doc actually painted (not a transparent canvas
    //      with the loading shield showing through).
    let shieldUpT = null, contentReadyT = null, sawUp = false, sawDown = false;
    let lastFailReason = '';
    const deadline = clickT + 90000;
    let lastProbe = null;
    while (Date.now() < deadline) {
        const s = await detectShieldState(page);
        if (s.visible && !sawUp) { shieldUpT = Date.now(); sawUp = true; }
        if (sawUp && !s.visible) { sawDown = true; }
        const probe = await probeIframeContent(page);
        lastProbe = probe;
        const fieldText = expect ? (probe[expect.field] || '') : '';
        const expectedStatusOk = expect ? expect.regex.test(fieldText) : false;
        const pxBytes = (probe.canvasPx || '').split(',').map(Number);
        // 2 pixels x RGBA = 8 bytes; alpha is byte 3 and byte 7
        const canvasPainted = pxBytes.length >= 8 && (pxBytes[3] > 0 || pxBytes[7] > 0);
        if (sawDown && expectedStatusOk && canvasPainted) {
            contentReadyT = Date.now();
            break;
        }
        if (!sawDown) lastFailReason = 'shield-still-up';
        else if (!expectedStatusOk) lastFailReason = `status-mismatch (want ${expect.field}~${expect.regex} got ${JSON.stringify(fieldText)})`;
        else if (!canvasPainted) lastFailReason = `canvas-not-painted px=${probe.canvasPx}`;
        await sleep(250);
    }

    // Take the screenshot only AFTER content is ready (or we time out)
    await snap(page, `after-click-${label}`, `After ${fileMatch} ${contentReadyT ? 'loaded with content' : 'TIMED OUT (no content render detected)'}`);

    const mode = await page.evaluate(() => window.__viewerState?.lastOpenMode);
    const totalMs = Date.now() - clickT;
    const result = {
        label,
        fileMatch,
        clickT,
        shieldUpMs: sawUp ? shieldUpT - clickT : null,
        contentReadyMs: contentReadyT ? contentReadyT - clickT : null,
        totalMs,
        mode,
        ok: !!contentReadyT,
        finalProbe: lastProbe,
        failReason: contentReadyT ? null : lastFailReason,
    };
    switches.push(result);
    log(`${label}: ${totalMs}ms total (mode=${mode}, shield-up=${result.shieldUpMs}ms, content-ready=${result.contentReadyMs || 'TIMEOUT'}ms${result.failReason ? ', fail=' + result.failReason : ''}, final=${JSON.stringify(lastProbe)})`, 'measure');
    return result;
}

function fmt(ms) { return ms == null ? 'n/a' : (ms < 10000 ? ms + 'ms' : (ms/1000).toFixed(1) + 's'); }

function generateReport() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    let html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Hot-switch test report</title>';
    html += '<style>';
    html += 'body{font-family:system-ui,sans-serif;max-width:1400px;margin:20px auto;padding:0 20px;color:#222}';
    html += 'h1{margin:0 0 6px}h2{margin-top:32px;border-bottom:1px solid #ccc;padding-bottom:4px}';
    html += '.meta{color:#666;font-size:13px;margin-bottom:24px}';
    html += 'table{border-collapse:collapse;width:100%;margin:8px 0}';
    html += 'th,td{padding:6px 12px;border-bottom:1px solid #eee;text-align:left;font-size:13px;vertical-align:top}';
    html += 'th{background:#f5f5f5;font-weight:600}';
    html += '.ok{color:#0a0}.fail{color:#c00;font-weight:bold}';
    html += '.shot{margin:12px 0;padding:8px;border:1px solid #ddd;border-radius:4px}';
    html += '.shot img{max-width:600px;border:1px solid #999}';
    html += '.shot .caption{font-size:13px;color:#444;margin:4px 0}';
    html += '.shot .ts{font-family:monospace;color:#888;font-size:11px}';
    html += '.event{padding:2px 0;font-family:monospace;font-size:12px;color:#444}';
    html += '.event.click{color:#06b;font-weight:bold}';
    html += '.event.measure{color:#070}';
    html += '.event.shot{color:#a40}';
    html += '.viewer{font-style:italic;color:#888}';
    html += 'pre{background:#f8f8f8;padding:8px;border-radius:4px;overflow:auto}';
    html += '</style></head><body>';
    html += '<h1>Hot-switch test report</h1>';
    html += `<div class="meta">Run @ ${new Date().toISOString()} · viewer: ${VIEWER}</div>`;

    // Summary table
    html += '<h2>Summary</h2><table>';
    html += '<tr><th>#</th><th>File</th><th>Mode</th><th>Shield up</th><th>Content render</th><th>Total</th><th>Final state (in iframe)</th><th>Result</th></tr>';
    for (let i = 0; i < switches.length; i++) {
        const s = switches[i];
        const cls = s.ok ? 'ok' : 'fail';
        const fp = s.finalProbe || {};
        const final = `wc:"${fp.wc||''}" sd:"${fp.sd||''}" ss:"${fp.ss||''}"`;
        html += `<tr><td>${i+1}</td><td>${s.fileMatch}</td><td>${s.mode || '-'}</td>`;
        html += `<td>${fmt(s.shieldUpMs)}</td><td>${fmt(s.contentReadyMs)}</td><td>${fmt(s.totalMs)}</td>`;
        html += `<td><code style="font-size:11px">${final.replace(/[<>]/g, c => ({'<':'&lt;','>':'&gt;'}[c]))}</code></td>`;
        html += `<td class="${cls}">${s.ok ? '✓' : 'TIMEOUT'}</td></tr>`;
    }
    html += '</table>';

    // Screenshots
    html += '<h2>Screenshots (in chronological order)</h2>';
    for (const s of shots) {
        html += `<div class="shot"><div class="ts">[${s.elapsed}] ${s.ts}</div>`;
        html += `<div class="caption">${s.label}: ${s.caption}</div>`;
        html += `<img src="${s.file}" alt="${s.caption}"></div>`;
    }

    // Event log
    html += '<h2>Event log (raw)</h2>';
    for (const e of events) {
        html += `<div class="event ${e.kind}">[${e.elapsed}] ${e.ts} — ${e.msg.replace(/[<>]/g, c => ({'<':'&lt;','>':'&gt;'}[c]))}</div>`;
    }
    html += '</body></html>';
    fs.writeFileSync(REPORT_DIR + '/index.html', html);
    log(`📄 Report written to ${REPORT_DIR}/index.html`);
}

(async () => {
    log('=== Viewer hot-switch report ===');
    fs.rmSync(REPORT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOTS_DIR, { recursive: true });

    const { browser, cleanup } = await launch();
    let allPassed = true;

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 900 });

        page.on('console', msg => {
            const t = msg.text();
            if (t.includes('PostMessage ignored')) return;
            if (/^\s*$/.test(t)) return;
            if (t.includes('Hot') || t.includes('cold') || t.includes('switch') ||
                t.includes('SWITCHDOC') ||
                t.includes('Editor iframe') || t.includes('Document ready') ||
                t.includes('jserror') || t.includes('Error') ||
                t.includes('lastOpenMode') || t.includes('Cross-type')) {
                log('viewer: ' + t.substring(0, 200), 'viewer');
            }
        });
        page.on('pageerror', e => log('PAGE ERROR: ' + e.message.substring(0, 200), 'viewer'));

        log(`Navigating to ${VIEWER}`);
        await page.goto(VIEWER, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('#upload', { timeout: 30000 });
        await snap(page, 'initial', 'Viewer landed (prewarm running in iframe)');

        // Upload 3 files via the actual <input type="file">
        log('Uploading 3 fixtures via #upload input (real UI element)');
        const fileInput = await page.$('#upload');
        const filePaths = FIXTURES.map(f => f.src);
        await fileInput.uploadFile.apply(fileInput, filePaths);
        await page.waitForFunction(
            count => document.querySelectorAll('#list .file').length >= count,
            { timeout: 60000 }, FIXTURES.length
        );
        const fileList = await listFiles(page);
        log('File list (' + fileList.length + ' entries): ' + JSON.stringify(fileList));
        await snap(page, 'uploaded', '3 files uploaded — file list populated');

        // Wait for prewarm to complete (WasmPrewarmReady fires when the
        // iframe's blank.docx is fully painted and __wasmInitialDocLoaded
        // is true). Without this, the first click runs while the iframe
        // is still booting and we can't measure a true hot-switch.
        log('Waiting for prewarm to complete (window.__viewerState.prewarmReady)…');
        const prewarmT0 = Date.now();
        try {
            await page.waitForFunction(
                () => !!(window.__viewerState && window.__viewerState.prewarmReady),
                { timeout: 90000, polling: 500 }
            );
            log(`Prewarm ready after ${((Date.now() - prewarmT0) / 1000).toFixed(1)}s`);
        } catch (e) {
            log(`Prewarm wait TIMED OUT after ${((Date.now() - prewarmT0) / 1000).toFixed(1)}s — first click will be cold`, 'viewer');
        }
        await snap(page, 'prewarm-ready', 'Prewarm complete — ready to click files');

        // Walk through 3 clicks (one per format), then back to first
        const sequence = [
            FIXTURES[0],
            FIXTURES[1],
            FIXTURES[2],
            FIXTURES[0], // return to first
        ];
        for (let i = 0; i < sequence.length; i++) {
            const fix = sequence[i];
            const r = await clickFileAndMeasure(page, `step${i + 1}-${fix.label}`, fix.name, fix.expect);
            if (!r.ok) allPassed = false;
            await sleep(2500);
        }

        await snap(page, 'final', 'After all 4 clicks');
    } catch (e) {
        log('FATAL: ' + (e.stack || e.message), 'viewer');
        allPassed = false;
    } finally {
        await cleanup();
    }

    generateReport();
    log(allPassed ? '✓ ALL CLICKS LOADED' : '✗ SOME CLICKS FAILED');
    log(`Open file://${REPORT_DIR}/index.html in a browser to review.`);
    process.exit(allPassed ? 0 : 1);
})();
