// Quick diagnostic: scan Emscripten VFS for fontconfig, config, cache, and timing files
const puppeteer = require('puppeteer');
const { launch, sleep } = require('./lib/browser');
const env = require('./lib/test-env');

const BASE = env.EDITOR_URL;
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); }

(async () => {
    const { browser, cleanup } = await launch();
    try {
        // Use incognito context to avoid stale V8 code cache
        const context = await browser.createBrowserContext();
        const page = await context.newPage();
        // Capture ALL console output (including workers)
        page.on('console', msg => log(`[console] ${msg.text()}`));

        // Also listen for worker targets to capture their console output
        browser.on('targetcreated', async (target) => {
            if (target.type() === 'service_worker' || target.type() === 'other') {
                try {
                    const worker = await target.worker();
                    if (worker) {
                        worker.on('console', msg => log(`[worker] ${msg.text()}`));
                    }
                } catch(e) {}
            }
        });
        page.on('pageerror', err => log(`[browser ERROR] ${err.message}`));

        // Clear all caches to ensure fresh binary
        const client = await page.target().createCDPSession();
        await client.send('Network.clearBrowserCache');
        await page.evaluate(async () => {
            if ('caches' in self) {
                const keys = await caches.keys();
                for (const k of keys) await caches.delete(k);
            }
        }).catch(() => {});
        log('Browser + Cache Storage cleared');

        // Unregister any existing SW to prevent stale cached binaries
        await page.goto(BASE + '/browser/cool.html', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        await page.evaluate(async () => {
            const regs = await navigator.serviceWorker.getRegistrations();
            for (const r of regs) await r.unregister();
            if ('caches' in self) {
                const keys = await caches.keys();
                for (const k of keys) await caches.delete(k);
            }
        }).catch(() => {});
        log('SW unregistered, caches cleared');

        const url = `${BASE}/browser/cool.html?WOPISrc=${encodeURIComponent('cache-test.docx')}&access_token=test&lang=en&_cb=${Date.now()}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
        log('Page navigated, waiting for doc to load...');

        // Wait for prewarm:ready
        for (let i = 0; i < 120; i++) {
            const ready = await page.evaluate(() => !!window.__wasmPrewarmReady);
            if (ready) break;
            await sleep(1000);
        }
        log('Doc loaded');
        await sleep(2000); // Let VFS settle

        // Full recursive VFS scan
        const scan = await page.evaluate(() => {
            const FS = window.__wasmFS;
            if (!FS) return { error: 'no FS' };
            const results = [];
            let fileCount = 0;
            function scan(dir, depth) {
                if (depth > 8) return;
                try {
                    const entries = FS.readdir(dir);
                    for (const e of entries) {
                        if (e === '.' || e === '..') continue;
                        const full = dir + '/' + e;
                        try {
                            const stat = FS.stat(full);
                            if (FS.isDir(stat.mode)) {
                                scan(full, depth + 1);
                            } else {
                                fileCount++;
                                // Log fontconfig, cache, timing, or config files
                                if (e.includes('fontconfig') || e.includes('fc-') ||
                                    e.includes('.cache') || e.includes('timing') ||
                                    dir.includes('fontconfig') || dir.includes('.config') ||
                                    dir.includes('cache') || e === 'fonts.conf') {
                                    results.push({ path: full, size: stat.size });
                                }
                            }
                        } catch(e2) {}
                    }
                } catch(e) {}
            }
            // Scan ALL directories from root
            scan('/', 0);

            // Also list top-level /tmp contents
            const tmpEntries = [];
            try {
                for (const e of FS.readdir('/tmp')) {
                    if (e !== '.' && e !== '..') {
                        try {
                            const s = FS.stat('/tmp/' + e);
                            tmpEntries.push({ name: e, isDir: FS.isDir(s.mode) });
                        } catch(ex) {}
                    }
                }
            } catch(e) {}

            return { results, fileCount, tmpEntries };
        });

        log(`\n=== VFS Scan Results ===`);
        log(`Total files scanned under /tmp and /home: ${scan.fileCount}`);
        log(`\n/tmp entries:`);
        for (const e of (scan.tmpEntries || [])) {
            log(`  ${e.isDir ? 'DIR ' : 'FILE'} /tmp/${e.name}`);
        }
        log(`\nFontconfig/cache/timing files:`);
        for (const r of (scan.results || [])) {
            log(`  ${r.path} (${r.size} bytes)`);
        }
        if ((scan.results || []).length === 0) {
            log('  (none found)');
        }

        // Also try reading /timing.log directly
        const timingLog = await page.evaluate(() => {
            try { return window.__wasmFS.readFile('/timing.log', { encoding: 'utf8' }); } catch(e) { return null; }
        });
        log(`\n/timing.log: ${timingLog ? timingLog : '(not found)'}`);

        // Check what FONTCONFIG_FILE env var is set to
        log('\nDone.');
    } catch (err) {
        log('ERROR: ' + err.message);
        process.exitCode = 1;
    } finally {
        await cleanup();
    }
})();
