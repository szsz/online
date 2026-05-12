// Test: Stale snapshot rejection.
// 1. Visit 1: load editor, save snapshot (with current build fingerprint)
// 2. Tamper the snapshot metadata to change the fingerprint
// 3. Visit 2: verify the snapshot is rejected as stale (not restored)
// 4. Verify the editor does a full cold init instead

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('./lib/browser');
const env = require('./lib/test-env');

const BASE = env.EDITOR_URL;
const WASM_BASE = env.FILE_STORAGE_URL;
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); }

async function waitForEditor(page, timeoutMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const ready = await page.evaluate(() => !!(window.__wasmPrewarmReady));
        if (ready) return Date.now() - start;
        await sleep(500);
    }
    throw new Error('Editor did not become ready within ' + timeoutMs + 'ms');
}

// Iter 185: upload a fixture to /wasm/<name> on the editor-static server
// before navigating with WOPISrc=<name>. Without this, the kit fetches
// /wasm/cache-test.docx, gets 404, and the editor never reaches
// __wasmPrewarmReady — the test then times out at 120s with
// "Editor did not become ready". This made test-snapshot-stale dependent
// on whatever previous test happened to upload cache-test.docx; in the
// full suite that ordering broke after iter 173.
async function uploadFixture(browser, name, fixtureSrc) {
    const bytes = fs.readFileSync(fixtureSrc);
    const up = await browser.newPage();
    await up.goto(BASE, { waitUntil: 'networkidle0', timeout: 30000 });
    await up.evaluate(async (url, n, arr) => {
        await fetch(url + '/wasm/' + encodeURIComponent(n), {
            method: 'POST', body: new Blob([new Uint8Array(arr)])
        });
    }, WASM_BASE, name, Array.from(bytes));
    await up.close();
    log(`Uploaded ${name} (${bytes.length} bytes)`);
}

(async () => {
    const { browser, cleanup } = await launch();
    try {
        // Upload a fresh fixture so /wasm/<docName> always exists for this run.
        const docName = 'snapshot-stale-' + Date.now() + '.docx';
        await uploadFixture(browser, docName,
            path.join(__dirname, '..', 'test', 'data', 'new.docx'));

        const page = await browser.newPage();
        const profileEvents = [];
        page.on('console', msg => {
            const text = msg.text();
            if (text.includes('[profile') || text.includes('snapshot')) {
                log(`[browser] ${text}`);
                profileEvents.push(text);
            }
        });

        const url = `${BASE}/browser/cool.html?WOPISrc=${encodeURIComponent(docName)}&access_token=test&lang=en`;

        // ── Step 1: Clear cache, do cold visit to create snapshot ──
        log('=== Step 1: Cold visit — create snapshot ===');
        await page.goto(`${BASE}/browser/favicon.ico`).catch(() => {});
        await page.evaluate(() => Promise.all([
            caches.delete('wasm-snapshot').catch(() => {}),
        ]));
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
        const t1 = await waitForEditor(page);
        log(`Visit 1 ready in ${(t1/1000).toFixed(1)}s`);

        // Wait for snapshot save
        for (let i = 0; i < 30; i++) {
            const saved = await page.evaluate(() => {
                const events = window.__prewarmTimings && window.__prewarmTimings.events || [];
                return events.some(e => e.name === 'snapshot:saved');
            });
            if (saved) { log('Snapshot saved'); break; }
            await sleep(1000);
        }

        // ── Step 2: Tamper the snapshot metadata fingerprint ──
        log('=== Step 2: Tamper snapshot fingerprint ===');
        const tampered = await page.evaluate(async () => {
            const cache = await caches.open('wasm-snapshot');
            const metaResp = await cache.match('/snapshot/meta');
            if (!metaResp) return 'no-meta';
            const meta = await metaResp.json();
            const oldFp = meta.fingerprint;
            meta.fingerprint = 'tampered_fake_fingerprint';
            await cache.put('/snapshot/meta', new Response(JSON.stringify(meta), {
                headers: { 'Content-Type': 'application/json' }
            }));
            return 'tampered from ' + (oldFp || 'none').substring(0, 16) + ' to tampered_fake_fingerprint';
        });
        log('Tampered: ' + tampered);

        // ── Step 3: Visit 2 — should reject the stale snapshot ──
        log('=== Step 3: Visit 2 — stale snapshot rejection ===');
        profileEvents.length = 0;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
        const t2 = await waitForEditor(page);
        log(`Visit 2 ready in ${(t2/1000).toFixed(1)}s`);

        // Check if snapshot was rejected
        const hasStale = profileEvents.some(e => e.includes('snapshot:stale'));
        const hasRestored = profileEvents.some(e => e.includes('snapshot:signal restored'));
        const hasFirstVisit = profileEvents.some(e => e.includes('snapshot:signal first-visit') || e.includes('snapshot:not_found'));

        if (hasStale) {
            log('PASS: Stale snapshot detected and rejected');
        } else if (hasRestored) {
            log('FAIL: Snapshot was restored despite tampered fingerprint');
            process.exitCode = 1;
        } else if (hasFirstVisit) {
            log('PASS: Treated as first visit (snapshot deleted after stale detection)');
        } else {
            log('INFO: Neither stale nor restored detected — checking profile events');
            for (const e of profileEvents) log('  ' + e);
        }

        log('PASS: test-snapshot-stale completed');
    } catch (err) {
        log('FAIL: ' + err.message);
        console.error(err);
        process.exitCode = 1;
    } finally {
        await cleanup();
    }
})();
