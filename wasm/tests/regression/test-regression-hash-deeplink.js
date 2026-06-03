const __cl = require('../../lib/inject-checklist');
// Regression test: per-file URL fragment deep links (v2 encryption).
//
// In the v2 model, the hash carries a 22-char base64url secret — the
// only way to open an encrypted file. Covers three behaviours:
//   1. Clicking a sidebar entry updates location.hash to #file=<secret>.
//      (The sidebar is populated from localStorage RecentFiles — for this
//      test we seed it on page-load.)
//   2. Loading /#file=<secret> on a fresh tab opens that file directly.
//   3. Changing the hash (e.g. back-button) opens the file for the new
//      secret; setting the hash to the current value is a no-op (the
//      hashchange event doesn't fire when the hash is unchanged).
//
// In v2, currentFile is the 64-hex fileId derived from the URL secret,
// not the plaintext filename (which the server never sees).
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-hash-deeplink';
const DOC_A = 'hash-deeplink-A.docx';
const DOC_B = 'hash-deeplink-B.docx';
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');

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

// Seed localStorage rf_v1 so refresh() renders these files in the sidebar
// before the user interacts with the page. RecentFiles.list() expects
// { files: [...] } shape.
async function seedRecentFiles(page, entries) {
    await page.evaluateOnNewDocument((list) => {
        localStorage.setItem('rf_v1', JSON.stringify({ files: list }));
    }, entries);
}

(async () => {
    log('=== Regression: per-file URL fragment deep links (v2) ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(FIXTURE)) { log('ERROR: fixture missing: ' + FIXTURE); process.exit(1); }

    // Upload both fixtures via v2 — returns secrets + fileIds. The
    // plaintext names never reach the server.
    const bytes = fs.readFileSync(FIXTURE);
    const a = await uploadV2(VIEWER, DOC_A, bytes);
    const b = await uploadV2(VIEWER, DOC_B, bytes);
    log(`Uploaded ${DOC_A} → ${a.fileId.substring(0,8)}… and ${DOC_B} → ${b.fileId.substring(0,8)}…`);

    const recentList = [
        { secret: a.b64urlSecret, fileId: a.fileId, cachedName: DOC_A, lastVisited: Date.now() },
        { secret: b.b64urlSecret, fileId: b.fileId, cachedName: DOC_B, lastVisited: Date.now() - 1 },
    ];

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-features=SharedArrayBuffer'],
    });

    try {
        // ── Case 1: click updates hash ──────────────────────────────
        log('\n--- Case 1: click updates location.hash ---');
        const p1 = await browser.newPage();
        await p1.setCacheEnabled(false);
        await p1.setViewport({ width: 1280, height: 900 });
        await seedRecentFiles(p1, recentList);
        await p1.goto(VIEWER + '/', { waitUntil: 'domcontentloaded' });
        await p1.waitForFunction(id => !!document.querySelector(`.file[data-fileid="${id}"]`),
            { timeout: 15000 }, a.fileId);
        const before = await currentState(p1);
        log(`Before click: hash="${before.hash}", currentFile=${before.currentFile}`);
        check('Hash empty before any click', before.hash === '' || before.hash === '#');

        await p1.evaluate(id => document.querySelector(`.file[data-fileid="${id}"]`).click(), a.fileId);
        // The click sets location.hash synchronously; wait for the hashchange
        // listener + openFileBySecret to update currentFile.
        await p1.waitForFunction(() => location.hash.startsWith('#file='),
            { timeout: 5000 });
        await p1.waitForFunction(id => window.__viewerState && window.__viewerState.currentFile === id,
            { timeout: 30000 }, a.fileId);
        const afterClick = await currentState(p1);
        log(`After click:  hash="${afterClick.hash}", currentFile=${afterClick.currentFile}`);
        await snap(p1, 'after_click');
        check('Hash matches #file=<secretA>',
              afterClick.hash === '#file=' + a.b64urlSecret,
              'got ' + afterClick.hash);
        check('currentFile tracks the opened fileId',
              afterClick.currentFile === a.fileId,
              'got ' + afterClick.currentFile);

        // ── Case 2: load /#file=<secretB> opens B directly ──────────
        log('\n--- Case 2: fresh load at /#file=<secretB> opens B directly ---');
        const p2 = await browser.newPage();
        await p2.setCacheEnabled(false);
        await p2.setViewport({ width: 1280, height: 900 });
        await p2.goto(VIEWER + '/#file=' + b.b64urlSecret,
            { waitUntil: 'domcontentloaded' });
        await p2.waitForFunction(id => window.__viewerState && window.__viewerState.currentFile === id,
            { timeout: 30000 }, b.fileId);
        const s2 = await currentState(p2);
        log(`Deep-link load: hash="${s2.hash}", currentFile=${s2.currentFile}, openMode=${s2.openMode}`);
        await snap(p2, 'deeplink_load');
        check('Deep link opens the encrypted file', s2.currentFile === b.fileId);
        check('Hash preserved on deep-link load',
              s2.hash === '#file=' + b.b64urlSecret);

        // ── Case 3: hashchange to different file re-opens ───────────
        log('\n--- Case 3: changing hash to a different secret re-opens ---');
        await p2.evaluate(s => { location.hash = '#file=' + s; }, a.b64urlSecret);
        await p2.waitForFunction(id => window.__viewerState.currentFile === id,
            { timeout: 30000 }, a.fileId);
        const afterNav = await currentState(p2);
        log(`After hash nav: currentFile=${afterNav.currentFile}, hash="${afterNav.hash}"`);
        await snap(p2, 'hash_navigation');
        check('Changing hash reopens to the new file',
              afterNav.currentFile === a.fileId);

        // ── Case 4: same hash does not re-fire hashchange ───────────
        // Setting location.hash to the current value is a no-op in the
        // browser — hashchange does not fire, so openFileBySecret is not
        // re-entered.
        log('\n--- Case 4: setting hash to current file is a no-op ---');
        const preOpenCount = await p2.evaluate(() => {
            if (!window.__openFileCount) {
                window.__openFileCount = 0;
                const orig = window.openFileBySecret;
                window.openFileBySecret = function(s) { window.__openFileCount++; return orig(s); };
            }
            return window.__openFileCount;
        });
        await p2.evaluate(s => { location.hash = '#file=' + s; }, a.b64urlSecret);
        await sleep(500);   // give hashchange time to fire if it were going to
        const postOpenCount = await p2.evaluate(() => window.__openFileCount);
        log(`openFileBySecret calls before=${preOpenCount}, after=${postOpenCount}`);
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
