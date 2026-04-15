const __cl = require('./lib/inject-checklist');
// Regression test: late-join checkpoint timing.
//
// The bug: the save-and-upload-checkpoint delay in relay-adapter.js used to
// be 5 seconds. When a late joiner connected, the relay would trigger a
// fresh save on the active client and wait for the upload before serving
// the checkpoint. With a 5s delay every late-join took 5+ seconds longer,
// and during that window joiners would visibly stall, hit timeouts, or
// receive stale state. The fix shortened the delay to 1.5s.
//
// This test:
//   1. A opens a doc through the viewer.
//   2. A types ALPHA (5 chars).
//   3. B joins shortly after — the relay will trigger a fresh save on A.
//   4. We measure the wall-clock time from B's join to B seeing the
//      complete content (initial doc + ALPHA). It must be << 5s extra.
//   5. Verify B's content includes A's ALPHA (not the original/stale state).
//
// The strict timing assertion is the regression sentinel: if someone bumps
// the save delay back up or introduces a new long wait in the join path,
// this test will fail.

const puppeteer = require('puppeteer');
const fs = require('fs');
const env = require('./lib/test-env');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-checkpoint';

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

async function getEditorFrame(page) {
    return page.frames().find(f => f.url().includes('cool.html'));
}

async function getCharCount(page) {
    const fr = await getEditorFrame(page);
    if (!fr) return -1;
    try {
        const s = await fr.evaluate(() =>
            document.querySelector('#StateWordCount')?.textContent || '');
        const m = s.match(/(\d+) characters/);
        return m ? parseInt(m[1]) : -1;
    } catch(e) { return -1; }
}

async function openViewer(browser, label) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(VIEWER + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    for (let i = 0; i < 240; i++) {
        await sleep(500);
        try {
            const fr = await getEditorFrame(page);
            if (fr && await fr.evaluate(() => !!window.__wasmPrewarmReady)) {
                log(`[${label}] Prewarm ready (~${i*0.5}s)`);
                return { ctx, page };
            }
        } catch(e) {}
    }
    throw new Error(`[${label}] Prewarm did not complete`);
}

async function clickFile(page, name) {
    await page.waitForFunction(n =>
        !!document.querySelector(`.file[data-name="${n}"]`),
        { timeout: 15000 }, name);
    await page.evaluate(n => {
        document.querySelector(`.file[data-name="${n}"]`).click();
    }, name);
}

async function waitForCharCount(page, expected, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const c = await getCharCount(page);
        if (c === expected) return Date.now() - t0;
        await sleep(250);
    }
    return -1;
}

(async () => {
    log('=== Regression: late-join checkpoint timing (1.5s budget) ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    const STAMP = Date.now();
    const FILE = `checkpoint-timing-${STAMP}.txt`;
    const INIT_CONTENT = 'Hello';
    const TYPED = 'ALPHA';
    const INIT = INIT_CONTENT.length;
    const EXPECTED = INIT + TYPED.length;

    try {
        const up = await browser.newPage();
        await up.goto(VIEWER + '/');
        await up.evaluate(async (n, c) => {
            await fetch('/api/files/' + encodeURIComponent(n), {
                method: 'POST', body: new Blob([c], { type: 'application/octet-stream' }),
            });
        }, FILE, INIT_CONTENT);
        await up.close();
        log(`Uploaded ${FILE} (${INIT_CONTENT.length} chars)`);

        // ---- Phase 1: A opens, types ALPHA ----
        log('\n--- Phase 1: A opens & types ALPHA ---');
        const A = await openViewer(browser, 'A');
        await clickFile(A.page, FILE);
        const aLoadTook = await waitForCharCount(A.page, INIT, 60000);
        check(`A loaded ${FILE} (${INIT} chars)`, aLoadTook >= 0, 'took=' + aLoadTook + 'ms');
        await snap(A.page, 'A_loaded');

        // Wait for first activation+ready settle (so A is the active room peer)
        await sleep(8000);

        // Type ALPHA
        const frA = await getEditorFrame(A.page);
        for (const c of TYPED) {
            await frA.evaluate(ch => globalThis.TheFakeWebSocket.send('textinput id=0 text=' + ch), c);
            await sleep(800);
        }
        const aAfterAlpha = await waitForCharCount(A.page, EXPECTED, 15000);
        check(`A typed ALPHA (now ${EXPECTED} chars)`,
              aAfterAlpha >= 0, 'aChars=' + (await getCharCount(A.page)));
        await snap(A.page, 'A_after_alpha');

        // ---- Phase 2: B joins → relay triggers a fresh save on A ----
        // The 1.5s save delay (vs. old 5s) means B should see the new state
        // in well under 7 seconds total wait.
        log('\n--- Phase 2: B joins, must see ALPHA quickly ---');
        const B = await openViewer(browser, 'B');
        const bJoinStart = Date.now();
        await clickFile(B.page, FILE);
        const bSawAlpha = await waitForCharCount(B.page, EXPECTED, 30000);
        const bWallClock = Date.now() - bJoinStart;
        log(`B saw final state in ${bSawAlpha}ms (wall ${bWallClock}ms)`);
        await snap(B.page, 'B_loaded');

        const bChars = await getCharCount(B.page);
        check(`B sees ALPHA-augmented content (${EXPECTED} chars, not stale ${INIT})`,
              bChars === EXPECTED,
              'bChars=' + bChars);

        // The save delay budget. With the bug (5s delay) the join would take
        // 11-13 seconds (extra 3.5s of waiting). With the fix (1.5s) it
        // typically completes in 6-8s. A 10s ceiling cleanly separates the
        // two regimes while absorbing normal network jitter.
        check(`B's join completes within timing budget (< 10s)`,
              bSawAlpha >= 0 && bSawAlpha < 10000,
              'bSawAlpha=' + bSawAlpha + 'ms');

        log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    } catch (e) {
        log('Error: ' + e.message);
        allPassed = false;
    } finally {
        await browser.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
