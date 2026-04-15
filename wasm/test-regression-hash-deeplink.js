const __cl = require('./lib/inject-checklist');
// Regression test: per-file URL fragment deep links.
//
// Covers three user-visible behaviours:
//   1. Clicking a file updates location.hash to #file=<name> — so the URL
//      is shareable and back/forward navigates between files.
//   2. Loading /#file=<name> on a fresh tab opens that file directly
//      (no prewarm, skips the blank.docx intermediate).
//   3. Changing the hash (e.g. back-button) opens the named file; same
//      hash as current is a no-op (no reentry loop).
//
// Why this regression exists: the viewer originally had no persistent
// state — every tab started on the blank prewarm regardless of what the
// user had been doing. The user asked for per-file URLs so they can
// bookmark / share links to a specific document.
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-hash-deeplink';
const DOC_A = 'hash-deeplink-A.docx';
const DOC_B = 'hash-deeplink-B.docx';
const FIXTURE = path.join(__dirname, '..', 'test', 'data', 'new.docx');

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

async function currentState(page) {
    return page.evaluate(() => ({
        hash: location.hash,
        currentFile: window.__viewerState ? window.__viewerState.currentFile : null,
        openMode:    window.__viewerState ? window.__viewerState.lastOpenMode : null,
    }));
}

(async () => {
    log('=== Regression: per-file URL fragment deep links ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(FIXTURE)) { log('ERROR: fixture missing: ' + FIXTURE); process.exit(1); }

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-features=SharedArrayBuffer'],
    });

    try {
        // Upload two fixtures so we can exercise file-to-file navigation.
        const up = await browser.newPage();
        await up.goto(VIEWER + '/');
        const bytes = fs.readFileSync(FIXTURE);
        for (const name of [DOC_A, DOC_B]) {
            await up.evaluate(async (n, a) => {
                await fetch('/api/files/' + encodeURIComponent(n), {
                    method: 'POST', body: new Blob([new Uint8Array(a)]),
                });
            }, name, Array.from(bytes));
        }
        await up.close();
        log(`Uploaded ${DOC_A} and ${DOC_B}`);

        // ── Case 1: click updates hash ──────────────────────────────
        log('\n--- Case 1: click updates location.hash ---');
        const p1 = await browser.newPage();
        await p1.setCacheEnabled(false);
        await p1.setViewport({ width: 1280, height: 900 });
        await p1.goto(VIEWER + '/', { waitUntil: 'domcontentloaded' });
        await p1.waitForFunction(n => !!document.querySelector(`.file[data-name="${n}"]`),
            { timeout: 15000 }, DOC_A);
        const before = await currentState(p1);
        log(`Before click: hash="${before.hash}", currentFile=${before.currentFile}`);
        check('Hash empty before any click', before.hash === '' || before.hash === '#');

        await p1.evaluate(n => document.querySelector(`.file[data-name="${n}"]`).click(), DOC_A);
        // Wait for openFile's first synchronous action (location.hash set).
        await p1.waitForFunction(() => location.hash.startsWith('#file='),
            { timeout: 5000 });
        const afterClick = await currentState(p1);
        log(`After click:  hash="${afterClick.hash}", currentFile=${afterClick.currentFile}`);
        await snap(p1, 'after_click');
        check('Hash matches #file=<clicked file>', afterClick.hash === '#file=' + encodeURIComponent(DOC_A),
              'got ' + afterClick.hash);
        check('currentFile tracks the opened file', afterClick.currentFile === DOC_A);

        // ── Case 2: load /#file=X opens X directly (skips prewarm) ──
        log('\n--- Case 2: fresh load at /#file=B opens B directly ---');
        const p2 = await browser.newPage();
        await p2.setCacheEnabled(false);
        await p2.setViewport({ width: 1280, height: 900 });
        await p2.goto(VIEWER + '/#file=' + encodeURIComponent(DOC_B),
            { waitUntil: 'domcontentloaded' });
        // The init() coroutine awaits refresh() then calls openFile.
        // openFile sets currentFile synchronously, so a brief wait is enough.
        await p2.waitForFunction(n => window.__viewerState && window.__viewerState.currentFile === n,
            { timeout: 15000 }, DOC_B);
        const s2 = await currentState(p2);
        log(`Deep-link load: hash="${s2.hash}", currentFile=${s2.currentFile}, openMode=${s2.openMode}`);
        await snap(p2, 'deeplink_load');
        check('Deep link opens the named file', s2.currentFile === DOC_B);
        check('Hash preserved on deep-link load', s2.hash === '#file=' + encodeURIComponent(DOC_B));
        // The prewarm should NOT have fired for a deep-link load — we skipped
        // it to avoid loading the blank doc only to throw it away.
        const prewarmed = await p2.evaluate(() => !!window.__viewerState?.prewarmReady);
        check('Prewarm skipped when deep-linking (prewarmReady false)', prewarmed === false,
              'prewarmReady=' + prewarmed);

        // ── Case 3: hashchange to different file re-opens ───────────
        log('\n--- Case 3: changing hash to a different file re-opens ---');
        const beforeNav = await currentState(p2);
        await p2.evaluate(n => { location.hash = '#file=' + encodeURIComponent(n); }, DOC_A);
        await p2.waitForFunction(n => window.__viewerState.currentFile === n,
            { timeout: 15000 }, DOC_A);
        const afterNav = await currentState(p2);
        log(`After hash nav: currentFile=${afterNav.currentFile}, hash="${afterNav.hash}"`);
        await snap(p2, 'hash_navigation');
        check('Changing hash reopens to the new file', afterNav.currentFile === DOC_A);

        // ── Case 4: same hash is a no-op (no reentry loop) ──────────
        log('\n--- Case 4: setting hash to current file is a no-op ---');
        const preOpenCount = await p2.evaluate(() => {
            // Install a counter on openFile so we can detect a second call.
            if (!window.__openFileCount) {
                window.__openFileCount = 0;
                const orig = window.openFile;
                window.openFile = function(n) { window.__openFileCount++; return orig(n); };
            }
            return window.__openFileCount;
        });
        await p2.evaluate(n => { location.hash = '#file=' + encodeURIComponent(n); }, DOC_A);
        await sleep(500);   // give hashchange time to fire if it were going to
        const postOpenCount = await p2.evaluate(() => window.__openFileCount);
        log(`openFile calls before=${preOpenCount}, after=${postOpenCount}`);
        check('Setting hash to current file does not re-open',
              postOpenCount === preOpenCount,
              'before=' + preOpenCount + ' after=' + postOpenCount);

        log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    } catch(e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        await browser.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
