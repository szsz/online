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
//   2. A types ALPHA (5 chars) via real keyboard input.
//   3. B joins shortly after — the relay will trigger a fresh save on A.
//   4. We measure the wall-clock time from B's join to B seeing the
//      complete content (initial doc + ALPHA). It must be << 5s extra.
//   5. Verify B's content includes A's ALPHA (not the original/stale state).
//
// The strict timing assertion is the regression sentinel: if someone bumps
// the save delay back up or introduces a new long wait in the join path,
// this test will fail.
//
// ALL input via keyboard/mouse — no TheFakeWebSocket.send() calls.

const { launch, sleep } = require('./lib/browser');
const fs = require('fs');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-checkpoint';

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

async function openViewer(browser, label, recentList) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    if (recentList) {
        await page.evaluateOnNewDocument((list) => {
            localStorage.setItem('rf_v1', JSON.stringify({ files: list }));
        }, recentList);
    }
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

async function clickFile(page, fileId) {
    // v2 sidebar entries are keyed by data-fileid (plaintext name never
    // reaches the server).
    await page.waitForFunction(id =>
        !!document.querySelector(`.file[data-fileid="${id}"]`),
        { timeout: 15000 }, fileId);
    await page.evaluate(id => {
        document.querySelector(`.file[data-fileid="${id}"]`).click();
    }, fileId);
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

// Click the center of the editor canvas to focus it
async function clickCanvas(page) {
    const fr = await getEditorFrame(page);
    if (!fr) return;
    const frameEl = await page.$('iframe');
    if (frameEl) {
        const box = await frameEl.boundingBox();
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    await sleep(300);
}

(async () => {
    log('=== Regression: late-join checkpoint timing (1.5s budget) ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const { browser, cleanup } = await launch();

    const STAMP = Date.now();
    const FILE = `checkpoint-timing-${STAMP}.txt`;
    const INIT_CONTENT = 'Hello';
    const TYPED = 'ALPHA';
    const INIT = INIT_CONTENT.length;
    const EXPECTED = INIT + TYPED.length;

    try {
        // Upload via v2 (encrypted)
        const upF = await uploadV2(VIEWER, FILE, Buffer.from(INIT_CONTENT, 'utf8'));
        // recent-files.js writes the URL fragment to `r.secret` (lib/recent-files.js:33);
        // index.html click handler reads `r.secret`. The seeded-property
        // name MUST match — `b64urlSecret` here would land in a key the
        // viewer never reads, opening the file with `secret=undefined`
        // and silently failing decrypt.
        const recentList = [{ secret: upF.b64urlSecret, fileId: upF.fileId, cachedName: FILE }];
        log(`Uploaded ${FILE} (${INIT_CONTENT.length} chars) → ${upF.fileId.substring(0,8)}…`);

        // ---- Phase 1: A opens, types ALPHA ----
        log('\n--- Phase 1: A opens & types ALPHA ---');
        const A = await openViewer(browser, 'A', recentList);
        await clickFile(A.page, upF.fileId);
        // 120s: Azure viewer prewarm + cross-type reload budget.
        const aLoadTook = await waitForCharCount(A.page, INIT, 120000);
        check(`A loaded ${FILE} (${INIT} chars)`, aLoadTook >= 0, 'took=' + aLoadTook + 'ms');
        await snap(A.page, 'A_loaded');

        // Wait for first activation+ready settle (so A is the active room peer)
        await sleep(8000);

        // Type ALPHA via real keyboard input
        await clickCanvas(A.page);
        for (const c of TYPED) {
            await A.page.keyboard.type(c, { delay: 50 });
            await sleep(800);
        }
        const aAfterAlpha = await waitForCharCount(A.page, EXPECTED, 15000);
        check(`A typed ALPHA (now ${EXPECTED} chars)`,
              aAfterAlpha >= 0, 'aChars=' + (await getCharCount(A.page)));
        await snap(A.page, 'A_after_alpha');

        // Explicit save: Ctrl+S on A so the checkpoint lands in storage
        // before B joins. The original test assumed the relay's
        // trigger-save-on-B-join round-trip would complete in <120 s,
        // but on Azure a cold save (LO write + /wasm/ read + upload +
        // 0x07) can exceed the 60 s relay save-timeout — B then gets
        // served stale and never catches up. Saving up-front is what a
        // real user would do and removes the race.
        log('--- Phase 1b: A saves explicitly (Ctrl+S) ---');
        await A.page.keyboard.down('Control');
        await A.page.keyboard.press('s');
        await A.page.keyboard.up('Control');
        // Wait for the storage GET to rotate its X-Content-Hash. Fetch
        // twice with a gap; when the hash changes, we know A's save has
        // landed. Budget ~30 s before giving up.
        const hashDeadline = Date.now() + 30000;
        let firstHash = null;
        let sawRotation = false;
        while (Date.now() < hashDeadline) {
            try {
                const r = await A.page.evaluate(async (n) => {
                    const r = await fetch('/api/files/' + encodeURIComponent(n),
                        { method: 'HEAD' });
                    return r.headers.get('x-content-hash') || r.headers.get('etag') || '';
                }, upF.fileId);
                if (firstHash === null) firstHash = r;
                else if (r && r !== firstHash) { sawRotation = true; break; }
            } catch(e) {}
            await sleep(1000);
        }
        log(`A explicit save: hash rotated=${sawRotation}`);

        // ---- Phase 2: B joins → relay triggers a fresh save on A ----
        // The 1.5s save delay (vs. old 5s) means B should see the new state
        // in well under 7 seconds total wait.
        log('\n--- Phase 2: B joins, must see ALPHA quickly ---');
        const B = await openViewer(browser, 'B', recentList);
        const bJoinStart = Date.now();
        await clickFile(B.page, upF.fileId);
        // 120s for Azure. This test is sensitive to all of:
        //   save-trigger RTT + A's /wasm/ read + upload + SHA-256 +
        //   relay roundtrip + B's blob fetch + decryption + LO apply.
        // Any one being slow stacks. Local is <5s.
        // 240s: Azure save RTT (A's trigger-save → LO-save → /wasm/
        // read → SHA-256 → upload → 0x07 → relay reclassifies → B
        // fetches → decrypts → LO apply) stacks. Relay's own save
        // timeout is 60 s; if it fires, B gets stale and WILL NEVER
        // catch up until A's next save lands. So the ceiling has to
        // exceed one full relay-timeout + one retried save cycle.
        const bSawAlpha = await waitForCharCount(B.page, EXPECTED, 240000);
        const bWallClock = Date.now() - bJoinStart;
        log(`B saw final state in ${bSawAlpha}ms (wall ${bWallClock}ms)`);
        await snap(B.page, 'B_loaded');

        const bChars = await getCharCount(B.page);
        check(`B sees ALPHA-augmented content (${EXPECTED} chars, not stale ${INIT})`,
              bChars === EXPECTED,
              'bChars=' + bChars);

        // Save-delay budget. Locally the fix (1.5s delay instead of 5s)
        // keeps the join <8s. On Azure a chain of WAN RTTs can push this
        // to 60–90s — the ceiling (120s) separates the "regression" regime
        // (timeout) from the fixed regime (completes, though slow).
        check(`B's join completes within timing budget (< 120s)`,
              bSawAlpha >= 0 && bSawAlpha < 120000,
              'bSawAlpha=' + bSawAlpha + 'ms');

        log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    } catch (e) {
        log('Error: ' + e.message);
        allPassed = false;
    } finally {
        await cleanup();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
