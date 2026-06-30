// Test: WASM memory snapshot save/restore
// Visit 1 (cold): No snapshot in Cache API → full init (FULL_INIT ~17s)
//                  After doc loads, saves HEAPU8 snapshot to Cache API.
// Visit 2 (warm): Snapshot found → HEAPU8 restored before callMain →
//                  LO Core sees bInitialized=true → SECOND_INIT (~2s).
//
// We measure the time from navigation to editor ready for both visits.

const puppeteer = require('puppeteer');
const { launch, sleep } = require('../../lib/browser');
const env = require('../../lib/test-env');

const BASE = env.EDITOR_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-snapshot';
const fs = require('fs');

const T0 = Date.now();
function log(m) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const filename = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    await page.screenshot({ path: `${SHOT_DIR}/${filename}`, fullPage: true });
    log(`[snap] ${filename}`);
}

async function waitForEditor(page, timeoutMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const ready = await page.evaluate(() => {
            return !!(window.__wasmPrewarmReady);
        });
        if (ready) return Date.now() - start;
        await sleep(500);
    }
    throw new Error('Editor did not become ready within ' + timeoutMs + 'ms');
}

async function getTimings(page) {
    return page.evaluate(() => {
        const t = window.__prewarmTimings;
        if (!t) return null;
        return {
            events: t.events,
            jsReady: !!window.__wasmJsReady,
            snapshotRestored: !!window.__wasmSnapshotRestored,
        };
    });
}

async function clearCache(page) {
    // Clear Cache API snapshot + IndexedDB caches so we start fresh
    await page.evaluate(() => {
        return Promise.all([
            caches.delete('wasm-snapshot').catch(() => {}),
            new Promise(r => { try { var req = indexedDB.deleteDatabase('wasm-memory-snapshot'); req.onsuccess = () => r(); req.onerror = () => r(); } catch(e) { r(); } }),
            new Promise(r => { try { var req = indexedDB.deleteDatabase('wasm-vfs-cache'); req.onsuccess = () => r(); req.onerror = () => r(); } catch(e) { r(); } }),
        ]);
    });
}

(async () => {
    const { browser, cleanup } = await launch();
    try {
        const page = await browser.newPage();
        page.on('console', msg => log(`[browser] ${msg.text()}`));
        page.on('pageerror', err => log(`[browser ERROR] ${err.message}`));

        // Use an existing doc in the WASM docs directory
        const docName = 'cache-test.docx';
        const url = `${BASE}/browser/cool.html?WOPISrc=${encodeURIComponent(docName)}&access_token=test&lang=en`;

        // ── Clear any existing snapshot ──
        log('Clearing any existing snapshot...');
        await page.goto(`${BASE}/browser/favicon.ico`).catch(() => {});
        await clearCache(page);
        log('Snapshot cleared');

        // ══════════════════════════════════════
        // VISIT 1: Cold — no snapshot
        // ══════════════════════════════════════
        log('=== VISIT 1 (cold) ===');
        const t1Start = Date.now();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
        log('Page navigated');

        const t1Ready = await waitForEditor(page);
        log(`Visit 1: Editor ready in ${(t1Ready / 1000).toFixed(1)}s`);
        await snap(page, 'visit1_ready');

        // Check timings
        const t1 = await getTimings(page);
        log('Visit 1 timings:');
        if (t1 && t1.events) {
            for (const e of t1.events) {
                if (e.name.includes('snapshot') || e.name.includes('COOLWSD') ||
                    e.name.includes('calledRun') || e.name.includes('prewarm')) {
                    log(`  +${e.t}ms ${e.name} ${e.detail || ''}`);
                }
            }
        }
        log(`  snapshotRestored: ${t1 && t1.snapshotRestored}`);

        // Read the C++ timing log from Emscripten VFS
        const timingLog = await page.evaluate(() => {
            try {
                if (window.__wasmFS) {
                    return window.__wasmFS.readFile('/timing.log', { encoding: 'utf8' });
                }
            } catch(e) {}
            return null;
        });
        if (timingLog) {
            log('C++ globalPreinit timings:');
            for (const line of timingLog.split('\n')) {
                if (line.trim()) log('  ' + line.trim());
            }
        } else {
            log('No timing log found in /timing.log');
        }

        // Scan Emscripten VFS for fontconfig cache files
        const vfsScan = await page.evaluate(() => {
            const FS = window.__wasmFS;
            if (!FS) return { error: 'no FS' };
            const results = [];
            function scan(dir, depth) {
                if (depth > 5) return;
                try {
                    const entries = FS.readdir(dir);
                    for (const e of entries) {
                        if (e === '.' || e === '..') continue;
                        const full = dir + '/' + e;
                        try {
                            const stat = FS.stat(full);
                            if (FS.isDir(stat.mode)) {
                                // Only descend into directories that might have config/cache
                                if (e === 'fontconfig' || e === '.config' || e === 'cache' ||
                                    e === 'home' || e === 'tmp' || e === 'user' ||
                                    e === '.fontconfig' || dir === '/tmp' || dir === '/tmp/home') {
                                    scan(full, depth + 1);
                                }
                                results.push({ path: full, type: 'dir' });
                            } else if (e.includes('fontconfig') || e.includes('fc-') ||
                                       e.endsWith('.cache') || e.endsWith('.cache-8') ||
                                       dir.includes('fontconfig')) {
                                results.push({ path: full, type: 'file', size: stat.size });
                            }
                        } catch(e2) {}
                    }
                } catch(e) {}
            }
            scan('/tmp', 0);
            scan('/home', 0);
            // Also check XDG paths
            try {
                const entries = FS.readdir('/tmp');
                for (const e of entries) {
                    if (e.startsWith('.') && e !== '.' && e !== '..') {
                        results.push({ path: '/tmp/' + e, type: 'dir_listing' });
                    }
                }
            } catch(e) {}
            return results;
        });
        log('VFS scan for fontconfig:');
        if (vfsScan.error) {
            log('  ERROR: ' + vfsScan.error);
        } else {
            for (const r of vfsScan) {
                log(`  ${r.type}: ${r.path}${r.size ? ' (' + r.size + ' bytes)' : ''}`);
            }
            if (vfsScan.length === 0) log('  (no fontconfig files found)');
        }

        // Wait for snapshot to be saved to Cache API
        log('Waiting for snapshot save...');
        for (let i = 0; i < 30; i++) {
            const saved = await page.evaluate(() => {
                const events = window.__prewarmTimings && window.__prewarmTimings.events || [];
                return events.some(e => e.name === 'snapshot:saved');
            });
            if (saved) {
                log('Snapshot saved to Cache API');
                break;
            }
            if (i === 29) log('WARNING: Snapshot save timeout');
            await sleep(1000);
        }
        await snap(page, 'visit1_after_save');

        // ══════════════════════════════════════
        // VISIT 2: Warm — with snapshot
        // ══════════════════════════════════════
        log('=== VISIT 2 (warm, with snapshot) ===');
        const t2Start = Date.now();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
        log('Page navigated');

        const t2Ready = await waitForEditor(page);
        log(`Visit 2: Editor ready in ${(t2Ready / 1000).toFixed(1)}s`);
        await snap(page, 'visit2_ready');

        // Check timings
        const t2 = await getTimings(page);
        log('Visit 2 timings:');
        if (t2 && t2.events) {
            for (const e of t2.events) {
                if (e.name.includes('snapshot') || e.name.includes('COOLWSD') ||
                    e.name.includes('calledRun') || e.name.includes('prewarm')) {
                    log(`  +${e.t}ms ${e.name} ${e.detail || ''}`);
                }
            }
        }
        log(`  snapshotRestored: ${t2 && t2.snapshotRestored}`);

        // ── Results ──
        const speedup = t1Ready - t2Ready;
        log('\n══════════════════════════════════════');
        log(`Visit 1 (cold): ${(t1Ready / 1000).toFixed(1)}s`);
        log(`Visit 2 (warm): ${(t2Ready / 1000).toFixed(1)}s`);
        log(`Speedup: ${(speedup / 1000).toFixed(1)}s`);
        log('══════════════════════════════════════\n');

        if (t2 && t2.snapshotRestored) {
            log('PASS: Snapshot was restored on visit 2');
        } else {
            log('FAIL: Snapshot was NOT restored on visit 2');
        }

        if (speedup > 3000) {
            log('PASS: Visit 2 was >3s faster than visit 1');
        } else {
            log('NOTE: Visit 2 speedup was only ' + (speedup/1000).toFixed(1) + 's');
        }

        log('PASS: test-snapshot completed');
    } catch (err) {
        log('FAIL: ' + err.message);
        console.error(err);
        process.exitCode = 1;
    } finally {
        await cleanup();
    }
})();
