const __cl = require('../../lib/inject-checklist');
// Regression test: iframe pool for cross-type (Bug iter 12).
//
// The viewer parks the previous-doctype iframe alive on cross-type
// instead of destroying it, then revives it on the next switch back
// to the same doctype. Reuse path is essentially same-type hot-switch
// (~200 ms-1 s) instead of cold-reload (~11 s).
//
// Asserts:
//   1. First cross-type (writer→calc) — cold path, ~10 s.
//   2. Cross-type back (calc→writer) — REVIVE path, must be < 3 s.
//   3. Cross-type back to calc — REVIVE again, must be < 3 s.
//
// The 3 s ceiling protects us against:
//   - Pool eviction (currently no cap — if added, must keep at least 3
//     entries since we exercise writer/calc; pool that drops the
//     parked writer fails check 2).
//   - Old code path: replaceChild instead of appendChild + parking
//     (would cost ~10 s on every cross-type, easy regression).
//   - JS race that loses the parked iframe's relay state and forces
//     re-handshake.

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`); }

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' ['+ev+']' : ''}`); allPassed = false; }
}

const FIXTURES = [
    { name: 'pool-writer.docx', src: 'new.docx',     type: 'writer' },
    { name: 'pool-calc.xlsx',   src: 'testdoc.xlsx', type: 'calc'   },
];

async function getStatusOk(page, type) {
    const handle = await page.$('iframe#editor-frame');
    if (!handle) return false;
    const fr = await handle.contentFrame();
    if (!fr) return false;
    return fr.evaluate((t) => {
        const wc = (document.querySelector('#StateWordCount')?.textContent || '');
        const dp = (document.querySelector('#StatusDocPos')?.textContent || '');
        if (t === 'writer') return /character/.test(wc);
        if (t === 'calc')   return /Sheet \d+ of/i.test(dp);
        return false;
    }, type).catch(() => false);
}

async function waitForType(page, type, deadlineMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < deadlineMs) {
        await sleep(200);
        if (await getStatusOk(page, type)) return Date.now() - t0;
    }
    return -1;
}

(async () => {
    const DATA_DIR = path.join(__dirname, '..', 'test', 'data');
    const fileIds = {};
    for (const f of FIXTURES) {
        const bytes = fs.readFileSync(path.join(DATA_DIR, f.src));
        const up = await uploadV2(VIEWER, f.name, bytes);
        fileIds[f.name] = { fileId: up.fileId, secret: up.b64urlSecret, type: f.type };
        log(`Uploaded ${f.name} → ${up.fileId.substring(0,8)}…`);
    }

    const { browser, cleanup } = await launch();
    try {
        const ctx = await browser.createBrowserContext();
        const page = await ctx.newPage();
        await page.setViewport({ width: 1280, height: 900 });

        // Seed sidebar with both fixtures.
        const rf = Object.entries(fileIds).map(([n, v]) => ({
            fileId: v.fileId, cachedName: n, secret: v.secret,
            lastVisited: new Date().toISOString(),
        }));
        await page.evaluateOnNewDocument(list => {
            localStorage.setItem('rf_v1', JSON.stringify({ files: list }));
        }, rf);

        // Cold open writer.
        await page.goto(VIEWER + '/#file=' + fileIds['pool-writer.docx'].secret,
            { waitUntil: 'domcontentloaded', timeout: env.scaleTimeout(60000) });
        const coldT = await waitForType(page, 'writer', env.scaleTimeout(90000));
        check('Cold writer-1 verified', coldT >= 0, 'took=' + coldT + 'ms');

        // Phase 1: cross-type writer → calc (FIRST cross-type, no parked
        // calc iframe yet). Should be ~10s — the cold path.
        const t1 = Date.now();
        await page.evaluate(s => { location.hash = '#file=' + s; },
            fileIds['pool-calc.xlsx'].secret);
        const w2c = await waitForType(page, 'calc', env.scaleTimeout(30000));
        const elapsed1 = Date.now() - t1;
        log(`writer→calc cross-type: ${w2c}ms`);
        check('writer→calc cold cross-type completes',
              w2c >= 0, 'took=' + w2c + 'ms');
        // Soft sanity: cold cross-type should be in the ballpark of
        // 5-15s on this rig. > 25s suggests something deeper broke.
        check('writer→calc within reasonable cold budget (< 25s)',
              w2c >= 0 && w2c < 25000, 'took=' + w2c + 'ms');
        await sleep(2000);

        // Phase 2: cross-type calc → writer (REVIVE the parked writer
        // iframe). Must be FAST — the iframe pool's reason for
        // existing.
        const t2 = Date.now();
        await page.evaluate(s => { location.hash = '#file=' + s; },
            fileIds['pool-writer.docx'].secret);
        const c2w = await waitForType(page, 'writer', 10000);
        log(`calc→writer revive: ${c2w}ms`);
        check('calc→writer revive completes',
              c2w >= 0, 'took=' + c2w + 'ms');
        check('calc→writer revive < 3s (iframe pool reuse)',
              c2w >= 0 && c2w < 3000, 'took=' + c2w + 'ms');
        await sleep(2000);

        // Phase 3: cross-type writer → calc again (REVIVE the parked
        // calc iframe). Same fast assertion.
        const t3 = Date.now();
        await page.evaluate(s => { location.hash = '#file=' + s; },
            fileIds['pool-calc.xlsx'].secret);
        const w2c2 = await waitForType(page, 'calc', 10000);
        log(`writer→calc revive: ${w2c2}ms`);
        check('writer→calc 2nd revive completes',
              w2c2 >= 0, 'took=' + w2c2 + 'ms');
        check('writer→calc 2nd revive < 3s (iframe pool reuse)',
              w2c2 >= 0 && w2c2 < 3000, 'took=' + w2c2 + 'ms');

        log(allPassed ? '\n✓ ALL TESTS PASSED' : '\n✗ SOME TESTS FAILED');
    } catch (e) {
        log('Error: ' + e.stack);
        allPassed = false;
    } finally {
        await cleanup();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
