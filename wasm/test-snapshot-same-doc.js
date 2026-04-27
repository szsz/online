// test-snapshot-same-doc.js — open the SAME document from a fresh
// browser, then from a second browser that has already cached +
// snapshotted the WASM runtime. Extract per-phase timings for both
// opens so we can see where the warm-visit cost actually goes.
//
// This is focused on answering: "the second browser is still slow —
// why, and is the memory snapshot even working?"
//
// Cold visit: fresh userDataDir → nothing cached, no snapshot → expect
//   a full FULL_INIT run: WASM fetch + compile + Desktop::Main + doc load.
// Warm visit: same userDataDir → HTTP cache has online.wasm/soffice.data,
//   Cache Storage has the HEAPU8 snapshot → expect SECOND_INIT path:
//   HEAPU8 restore → skip Desktop::Main → doc load only.
//
// We measure:
//   - wall clock from page navigation to viewer's "Document ready"
//   - every mark() event recorded by wasm-loader's instrumentation
//   - wall/transfer bytes for online.wasm + soffice.data
//   - whether window.__wasmSnapshotRestored was set on visit 2
//   - whether __prewarmTimings contains snapshot save/restore events

'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-snapshot-same-doc';
const DOC_PATH = path.join(__dirname, '..', 'test', 'data', 'new.docx');
const T0 = Date.now();

function log(m) {
    console.log('[' + ((Date.now() - T0) / 1000).toFixed(1) + 's] ' + m);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The editor iframe is cross-origin (wasm.atgpartners.info) so we
// can't poke contentWindow directly. Instead we subscribe to the
// iframe's postMessage stream via a tiny listener installed on the
// parent page. The iframe already posts WasmDocReady with the real
// doc's filename once the canvas has settled.
async function installDocReadyHook(page) {
    await page.evaluate(() => {
        window.__testDocReady = { at: null, filename: null };
        window.addEventListener('message', function(e) {
            try {
                const m = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
                if (m && m.MessageId === 'WasmDocReady' && m.Values && m.Values.filename
                    && !m.Values.timeout && !window.__testDocReady.at) {
                    window.__testDocReady.at = performance.now();
                    window.__testDocReady.filename = m.Values.filename;
                }
            } catch(e) {}
        });
    });
}

async function waitForDocReady(page, targetFileId, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const res = await page.evaluate((want) => {
            const s = window.__testDocReady || {};
            return { at: s.at, filename: s.filename, match: s.filename === want };
        }, targetFileId);
        if (res.match) return Date.now() - start;
        await sleep(250);
    }
    return -1;
}

// __prewarmTimings lives inside the editor iframe and is cross-
// origin-blocked. We exfiltrate it via postMessage: the iframe
// already forwards its mark() events through window.__prewarmTimings
// but not out. Use a CDP-level approach — evaluate inside the iframe
// target directly via the browser's target list.
async function extractTimings(browser, page) {
    // Find the editor iframe target via CDP.
    try {
        const targets = await browser.targets();
        for (const t of targets) {
            if (t.type() === 'page' || t.type() === 'iframe') {
                const url = t.url();
                if (url.includes('cool.html')) {
                    const fr = await t.page().catch(() => null) ||
                               await t.asPage().catch(() => null);
                    if (fr) {
                        try {
                            return await fr.evaluate(() => {
                                const t = window.__prewarmTimings;
                                if (!t) return null;
                                return {
                                    events: t.events.slice(),
                                    snapshotRestored: !!window.__wasmSnapshotRestored,
                                    jsReady: !!window.__wasmJsReady,
                                    loadedName: window.__wasmLoadedDocName || null,
                                    wasmDocType: window.__wasmDocType || null,
                                };
                            });
                        } catch(e) {}
                    }
                }
            }
        }
    } catch(e) {}
    // Fall back to iterating puppeteer's frames on the page.
    try {
        for (const f of page.frames()) {
            if (f.url().includes('cool.html')) {
                return await f.evaluate(() => {
                    const t = window.__prewarmTimings;
                    if (!t) return null;
                    return {
                        events: t.events.slice(),
                        snapshotRestored: !!window.__wasmSnapshotRestored,
                        jsReady: !!window.__wasmJsReady,
                        loadedName: window.__wasmLoadedDocName || null,
                        wasmDocType: window.__wasmDocType || null,
                    };
                }).catch(() => null);
            }
        }
    } catch(e) {}
    return null;
}

async function extractHeavyTransfers(page) {
    return page.evaluate(() => {
        return performance.getEntriesByType('resource')
            .filter(r => /online\.wasm|soffice\.data|online\.js/.test(r.name))
            .map(r => ({
                url: r.name,
                transferSize: r.transferSize,
                decodedBodySize: r.decodedBodySize,
                duration: r.duration,
            }));
    });
}

function printPhases(events, label) {
    log('  [' + label + '] timeline:');
    const interesting = [
        'loader:start', 'snapshot:probe_start', 'snapshot:found', 'snapshot:not_found',
        'snapshot:restore_start', 'snapshot:restore_done',
        'wasm:compile_start', 'wasm:compile_done',
        'Module.calledRun', '__loInitDone',
        'lok_preinit_2:start', 'lok_preinit_2:done',
        'lok_init_2:start', 'lok_init_2:done',
        'SECOND_INIT:start', 'SECOND_INIT:done',
        'desktop:main_start', 'desktop:main_done',
        'snapshot:save_start', 'snapshot:save_done',
        'prewarm:ready',
        'bridge:switchdoc_seen', 'bridge:switchdoc_sent',
        'bridge:canvas_visible', 'bridge:doc_ready',
    ];
    const seen = new Set();
    for (const ev of events) {
        if (interesting.some(p => ev.name === p || ev.name.startsWith(p + ':'))) {
            if (seen.has(ev.name)) continue;
            seen.add(ev.name);
            log('    ' + (ev.tNav / 1000).toFixed(2).padStart(6) +
                's  ' + ev.name + (ev.detail ? '  ' + String(ev.detail).substring(0, 80) : ''));
        }
    }
}

(async () => {
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    log('=== Snapshot same-doc test ===');

    // Upload the test doc once.
    const bytes = fs.readFileSync(DOC_PATH);
    const up = await uploadV2(VIEWER, 'snapshot-same-doc.docx', bytes);
    log('Uploaded: ' + up.fileId.substring(0, 8) + '…');
    // Opt-in to Plan C warm-restore via URL query (deployed default keeps
    // SNAPSHOT_DISABLED=true; the wasm-loader picks ?planc=1 up at runtime
    // and flips it false for this tab only).
    const fileUrl = VIEWER + '/?planc=1#file=' + up.b64urlSecret;

    // Persistent profile shared across both sessions so Cache Storage
    // + Disk Cache + IndexedDB survive browser close.
    const USER_DATA_DIR = path.join(os.tmpdir(),
        'snapshot-same-doc-' + Date.now() + '-' + process.pid);
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    log('Persistent userDataDir: ' + USER_DATA_DIR);

    const launchOpts = {
        headless: 'new', protocolTimeout: 600000,
        userDataDir: USER_DATA_DIR,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    };

    const results = [];

    for (const run of ['cold', 'warm']) {
        log('');
        log('=== Session: ' + run + ' ===');
        const browser = await puppeteer.launch(launchOpts);
        const page = await browser.newPage();
        page.on('dialog', d => d.accept().catch(() => {}));
        // Forward interesting iframe console lines so we can see them in-line.
        page.on('console', m => {
            const t = m.text();
            if (/\[TIMING\]|\[profile\b|snapshot:|SECOND_INIT|prewarm:ready|calledRun|PLAN_C|abort|unreachable|RuntimeError|TypeError|Pthread .* sent an error|WASM_ABORT|jserror/.test(t)) {
                log('  [console/' + run + '] ' + t.substring(0, 360));
            }
        });
        page.on('pageerror', e => log('  [pageerror/' + run + '] ' + (e.message || '').substring(0, 360) + '\n' + (e.stack || '').substring(0, 800)));
        await page.setCacheEnabled(true);
        await page.setViewport({ width: 1280, height: 900 });

        await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await installDocReadyHook(page);
        const navStart = Date.now();
        const ready = await waitForDocReady(page, up.fileId, 300000);
        const wall = Date.now() - navStart;
        log('[' + run + '] wall = ' + (wall / 1000).toFixed(1) + 's  (doc-ready detected at +' +
            (ready < 0 ? 'TIMEOUT' : (ready / 1000).toFixed(1) + 's') + ')');

        await page.screenshot({ path: SHOT_DIR + '/' + run + '.png' }).catch(() => {});

        const timings = await extractTimings(browser, page);
        const xfers = await extractHeavyTransfers(page);
        if (!timings) {
            log('  [' + run + '] no __prewarmTimings available — editor iframe may not have booted');
        } else {
            log('  [' + run + '] snapshotRestored=' + timings.snapshotRestored +
                '  jsReady=' + timings.jsReady +
                '  loadedName=' + (timings.loadedName || '').substring(0, 20));
            printPhases(timings.events, run);
        }
        log('  [' + run + '] heavy asset transfers:');
        for (const t of xfers) {
            const fromCache = t.transferSize === 0 && t.decodedBodySize > 0;
            log('    ' + t.url.split('/').pop() + ': ' +
                'transfer=' + (t.transferSize / 1048576).toFixed(2) + 'MB ' +
                'decoded=' + (t.decodedBodySize / 1048576).toFixed(2) + 'MB ' +
                (fromCache ? '← CACHE' : '← WIRE'));
        }

        results.push({ run, wall, ready, timings, xfers });

        // Wait up to 30 s for the snapshot to actually persist to Cache
        // Storage before tearing down the browser. Without this the
        // cold session can close the browser while the 162 MB Cache.put
        // is still in flight, and the warm session sees an empty cache.
        if (run === 'cold') {
            // __prewarmTimings is in the editor iframe, not the viewer page.
            // Wait by polling the iframe through page.frames().
            const got = await new Promise(async resolve => {
                const t0 = Date.now();
                const tick = async () => {
                    if (Date.now() - t0 > 60000) return resolve(false);
                    for (const f of page.frames()) {
                        try {
                            const ok = await f.evaluate(() => {
                                var t = window.__prewarmTimings || [];
                                for (var i = 0; i < t.length; i++) {
                                    if (t[i].name === 'snapshot:saved' ||
                                        t[i].name === 'snapshot:cache_put_failed') return true;
                                }
                                return false;
                            }).catch(() => false);
                            if (ok) return resolve(true);
                        } catch (e) { /* iframe gone */ }
                    }
                    setTimeout(tick, 250);
                };
                tick();
            });
            log('  [' + run + '] snapshot persisted=' + got + ', closing browser');
            // Extra grace period so IndexedDB Cache.put fully flushes to disk
            // before Chrome tears down the persistent profile dir. Without
            // this we'd see snapshot:saved fire but the on-disk Cache entry
            // would be incomplete and the warm visit reads back not-found.
            await sleep(3000);
        }
        await browser.close();
        // Brief gap so Chrome fully releases the profile dir locks.
        await sleep(1500);
    }

    // Analysis
    log('');
    log('=== Analysis ===');
    const cold = results[0], warm = results[1];
    log('Cold wall: ' + (cold.wall / 1000).toFixed(1) + 's');
    log('Warm wall: ' + (warm.wall / 1000).toFixed(1) + 's  (delta: ' +
        ((cold.wall - warm.wall) / 1000).toFixed(1) + 's = ' +
        (((cold.wall - warm.wall) / cold.wall) * 100).toFixed(0) + '% faster)');

    if (warm.timings) {
        log('Warm snapshotRestored: ' + warm.timings.snapshotRestored);
        if (!warm.timings.snapshotRestored) {
            log('  ⚠ Snapshot was NOT restored on the warm visit — either the save path on');
            log('    visit 1 is broken, or the probe/load path on visit 2 can\'t find it.');
        }
    }

    try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }); } catch(e) {}
    log('Done.');
    process.exit(0);
})();
