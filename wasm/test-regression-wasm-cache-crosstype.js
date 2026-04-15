const __cl = require('./lib/inject-checklist');
// Regression test: cold-reload across document types must NOT re-download
// the WASM payload.
//
// User-visible bug: opening a writer doc, then a calc, then an impress
// triggers a fresh download of online.wasm (~57 MB brotli, ~199 MB raw)
// and soffice.data (~21 MB brotli, ~94 MB raw) for EACH cross-type open
// — even though those files are immutable and were already cached when
// the writer prewarm ran. The viewer's cold reload replaces the iframe
// (necessary because WASM JS docLayer is type-specific and cannot
// hot-switch types), but the iframe replacement should still hit Chrome's
// disk cache for the heavy assets.
//
// What this test asserts: through Chrome DevTools Protocol's
// Network.responseReceived event, the encodedDataLength for online.wasm
// and soffice.data stays at 0 across writer→calc→impress switches —
// meaning Chrome served them from disk without going to the network. A
// non-zero value means the bytes actually came over the wire (regression).
//
// Why Performance API instead of page.on('request') / CDP:
//   - page.on('request') fires for all requests (incl. cache hits) so it
//     can't tell us whether bytes left the server.
//   - Page-level CDP doesn't see iframe traffic — the editor iframe is
//     cross-origin and runs in a separate renderer (OOPIF), so its
//     Network.responseReceived events go to its own CDP target.
//   - performance.getEntriesByType('resource') inside the iframe gives
//     transferSize directly: 0 means cache hit, non-zero means bytes
//     came over the wire (header bytes for 304s; full body for 200s).
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-wasm-cache-crosstype';

const HEAVY_ASSETS = [
    /\/online(\.[a-f0-9]+)?\.wasm(\?|$)/,
    /\/soffice\.data(\?|$)/,
];

const FORMATS = [
    { name: 'cache-test.docx', src: 'new.docx',     kind: 'writer'  },
    { name: 'cache-test.xlsx', src: 'testdoc.xlsx', kind: 'calc'    },
    { name: 'cache-test.pptx', src: 'testdoc.pptx', kind: 'impress' },
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

// Read perf entries from every frame on the page. Pass `filter=isHeavy`
// to get only WASM/soffice.data; pass null for all entries.
// transferSize is 0 for cache hits, on-the-wire bytes otherwise.
async function readTransfers(page, filter) {
    const out = [];
    for (const fr of page.frames()) {
        try {
            const entries = await fr.evaluate(() =>
                performance.getEntriesByType('resource').map(e => ({
                    url: e.name,
                    transferSize: e.transferSize,
                    encodedBodySize: e.encodedBodySize,
                    decodedBodySize: e.decodedBodySize,
                    startTime: e.startTime,
                })));
            for (const e of entries) if (!filter || filter(e.url)) out.push(e);
        } catch(err) {}
    }
    out.sort((a, b) => a.startTime - b.startTime);
    return out;
}
const readHeavyTransfers = (page) => readTransfers(page, isHeavy);

// Filter helper: a transfer that's not the document file itself
// (cache-test.docx etc.) and not trivially small.
function isInterestingNonDoc(url) {
    if (/\/api\/files\//.test(url)) return false;       // doc storage
    if (/\/wasm\/cache-test\./.test(url)) return false; // doc upload
    return true;
}

async function clickFile(page, name) {
    await page.waitForFunction(n =>
        !!document.querySelector(`.file[data-name="${n}"]`),
        { timeout: 15000 }, name);
    await page.evaluate(n => document.querySelector(`.file[data-name="${n}"]`).click(), name);
}

async function waitForDocLoaded(page, kind, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const fr = page.frames().find(f => f.url().includes('cool.html'));
        if (fr) {
            try {
                const sig = await fr.evaluate((k) => {
                    const wc = document.querySelector('#StateWordCount')?.textContent || '';
                    const dp = document.querySelector('#StatusDocPos')?.textContent || '';
                    const nav = document.querySelector('nav.main-nav')?.textContent || '';
                    if (k === 'writer'  && /\d+ words?/.test(wc))   return true;
                    if (k === 'calc'    && /Sheet\s*\d+/i.test(dp)) return true;
                    if (k === 'impress' && /Slide Show/.test(nav))  return true;
                    return false;
                }, kind);
                if (sig) return true;
            } catch(e) {}
        }
        await sleep(500);
    }
    return false;
}

(async () => {
    log('=== Regression: cross-type WASM cache (no re-download) ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    // Verify fixtures
    for (const f of FORMATS) {
        const src = path.join(__dirname, '..', 'test', 'data', f.src);
        if (!fs.existsSync(src)) { log('ERROR: fixture missing: ' + src); process.exit(1); }
    }

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-features=SharedArrayBuffer'],
    });

    try {
        // Upload fixtures via viewer
        const up = await browser.newPage();
        await up.goto(VIEWER + '/');
        for (const f of FORMATS) {
            const src = path.join(__dirname, '..', 'test', 'data', f.src);
            const bytes = fs.readFileSync(src);
            await up.evaluate(async (n, a) => {
                await fetch('/api/files/' + encodeURIComponent(n), {
                    method: 'POST', body: new Blob([new Uint8Array(a)]),
                });
            }, f.name, Array.from(bytes));
            log(`Uploaded ${f.name} (${(bytes.length/1024).toFixed(0)}KB)`);
        }
        await up.close();

        const page = await browser.newPage();
        await page.setCacheEnabled(true);
        await page.setViewport({ width: 1280, height: 900 });

        // Clear browser cache so the prewarm counts as the FIRST fetch.
        const cdp = await page.target().createCDPSession();
        await cdp.send('Network.clearBrowserCache');

        log('\n--- Phase 1: prewarm (cold cache, full download expected) ---');
        await page.goto(VIEWER + '/', { waitUntil: 'domcontentloaded' });
        for (let i = 0; i < 240; i++) {
            await sleep(500);
            const fr = page.frames().find(f => f.url().includes('cool.html'));
            if (fr && await fr.evaluate(() => !!window.__wasmPrewarmReady).catch(() => false)) {
                log(`Prewarm ready (~${i*0.5}s)`);
                break;
            }
            if (i === 239) log('Prewarm TIMEOUT');
        }
        const prewarmTransfers = await readHeavyTransfers(page);
        const prewarmTotal = prewarmTransfers.reduce((s, t) => s + t.transferSize, 0);
        log(`Prewarm: ${prewarmTransfers.length} heavy entries, ` +
            `${(prewarmTotal/1048576).toFixed(1)}MB on the wire`);
        for (const t of prewarmTransfers) {
            log(`  ${t.url.split('/').pop()}: ` +
                `transfer=${(t.transferSize/1048576).toFixed(2)}MB ` +
                `decoded=${(t.decodedBodySize/1048576).toFixed(2)}MB`);
        }
        check('Prewarm fetches heavy assets at least once',
              prewarmTransfers.length >= 1);
        check('Prewarm: first WASM fetch IS over the wire (cold cache)',
              prewarmTransfers.some(t => t.transferSize > 1024),
              'sum=' + (prewarmTotal/1048576).toFixed(1) + 'MB');

        await snap(page, 'after_prewarm');

        // ── Cross-type opens ──
        // To attribute transfers to a single phase we capture the URL set
        // BEFORE clicking and then look at entries that didn't exist
        // before. Each cross-type open replaces the iframe, so the new
        // iframe's perf timeline starts fresh — the new entries are the
        // ones from this phase.
        let snapshotEntries = prewarmTransfers.length;
        let snapshotKeys = new Set(prewarmTransfers.map(t => t.url + '@' + t.startTime));
        // Snapshot of ALL non-doc transfers seen so far (used for the
        // wider re-download check below).
        const initialAll = await readTransfers(page, isInterestingNonDoc);
        const snapshotKeysAll = new Set(initialAll.map(t => t.url + '@' + t.startTime));
        for (const f of FORMATS) {
            log(`\n--- Phase 2.${f.kind}: cold-reload to ${f.name} ---`);
            await clickFile(page, f.name);
            const ok = await waitForDocLoaded(page, f.kind, 120000);
            check(`${f.kind}: document loaded`, ok);
            await snap(page, f.kind + '_loaded');

            // Wait for the iframe to settle so all post-load fetches are
            // recorded.
            await sleep(2000);

            const allTransfers = await readHeavyTransfers(page);
            const newOnes = allTransfers.filter(t =>
                !snapshotKeys.has(t.url + '@' + t.startTime));
            const wireBytes = newOnes.reduce((s, t) => s + t.transferSize, 0);
            log(`  ${f.kind}: ${newOnes.length} new heavy entries, ` +
                `${(wireBytes/1048576).toFixed(2)}MB on the wire`);
            for (const t of newOnes) {
                const isCache = t.transferSize === 0 && t.decodedBodySize > 0;
                log(`    ${t.url.split('/').pop()}: ` +
                    `transfer=${(t.transferSize/1024).toFixed(1)}KB, ` +
                    `decoded=${(t.decodedBodySize/1048576).toFixed(2)}MB, ` +
                    `${isCache ? 'CACHE HIT' : 'WIRE'}`);
            }
            // Track the new entries so the next phase only sees its own.
            for (const t of newOnes) snapshotKeys.add(t.url + '@' + t.startTime);

            const PER_ASSET_CEIL = 50 * 1024;
            const heavyDownloads = newOnes.filter(t => t.transferSize > PER_ASSET_CEIL);
            check(`${f.kind}: heavy assets NOT re-downloaded (each < 50KB on the wire)`,
                  heavyDownloads.length === 0,
                  heavyDownloads.length
                      ? heavyDownloads.map(t => `${t.url.split('/').pop()}=${(t.transferSize/1048576).toFixed(2)}MB`).join(', ')
                      : 'ok');

            // ── Wider net: ALSO check no other static asset (CSS, JS, font,
            // image) is re-downloaded. Anything > 50 KB transferred on a
            // cross-type cold-reload (other than the document itself, which
            // is intrinsically new bytes) is a regression in the cache
            // headers for THAT file.
            const allNew = (await readTransfers(page, isInterestingNonDoc))
                .filter(t => !snapshotKeysAll.has(t.url + '@' + t.startTime));
            const bigNonDoc = allNew.filter(t => t.transferSize > PER_ASSET_CEIL);
            if (bigNonDoc.length) {
                log(`  ${f.kind}: other large transfers seen during cold-reload:`);
                for (const t of bigNonDoc) {
                    log(`    ${t.url.split('/').pop()}: ${(t.transferSize/1024).toFixed(0)}KB ` +
                        `(decoded ${(t.decodedBodySize/1024).toFixed(0)}KB)`);
                }
            }
            for (const t of allNew) snapshotKeysAll.add(t.url + '@' + t.startTime);
            check(`${f.kind}: no other static assets re-downloaded (>50KB)`,
                  bigNonDoc.length === 0,
                  bigNonDoc.length
                      ? bigNonDoc.map(t => `${t.url.split('/').pop()}=${(t.transferSize/1024).toFixed(0)}KB`).join(', ')
                      : 'ok');
        }

        // ── Phase 3: full page reload — the cache must persist across
        // top-level navigations too. This is the user-visible scenario
        // where someone closes the tab, comes back, and opens a doc.
        log('\n--- Phase 3: full page reload, then open a doc ---');
        await page.reload({ waitUntil: 'domcontentloaded' });
        // Wait for prewarm (or the next click) to settle.
        for (let i = 0; i < 240; i++) {
            await sleep(500);
            const fr = page.frames().find(f => f.url().includes('cool.html'));
            if (fr && await fr.evaluate(() => !!window.__wasmPrewarmReady).catch(() => false)) {
                log(`Reload prewarm ready (~${i*0.5}s)`);
                break;
            }
        }
        const reloadTransfers = await readHeavyTransfers(page);
        const reloadBytes = reloadTransfers.reduce((s, t) => s + t.transferSize, 0);
        log(`After reload: ${reloadTransfers.length} heavy entries, ` +
            `${(reloadBytes/1048576).toFixed(2)}MB on the wire`);
        for (const t of reloadTransfers) {
            const isCache = t.transferSize === 0 && t.decodedBodySize > 0;
            log(`  ${t.url.split('/').pop()}: ` +
                `transfer=${(t.transferSize/1024).toFixed(1)}KB, ` +
                `${isCache ? 'CACHE HIT' : 'WIRE'}`);
        }
        const PER_ASSET_CEIL_RELOAD = 50 * 1024;
        const reloadHeavyDl = reloadTransfers.filter(t => t.transferSize > PER_ASSET_CEIL_RELOAD);
        check('Page reload: heavy assets NOT re-downloaded (cache survives navigation)',
              reloadHeavyDl.length === 0,
              reloadHeavyDl.length
                  ? reloadHeavyDl.map(t => `${t.url.split('/').pop()}=${(t.transferSize/1048576).toFixed(2)}MB`).join(', ')
                  : 'ok');

        log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    } catch (e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        await browser.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
