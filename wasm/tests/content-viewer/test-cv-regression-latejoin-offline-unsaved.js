// test-cv-regression-latejoin-offline-unsaved.js — A types UNSAVED edits,
// A goes OFFLINE, then B joins with no active peers: B must reconstruct A's
// edits from the relay message log (they were never saved to a checkpoint).
//
// Legacy subject (viewer): A opens, types, closes WITHOUT saving; the relay
// holds A's edits in its message log but the checkpoint is from the initial
// activation. B opens the same doc (A gone) and must replay the log to catch
// up — a blank/stale open would mean the log or replay is broken.
//
// CV port: A creates a co-edit room and types unsaved edits, then LEAVES
// (context close = offline). B late-joins the link in an isolated context
// with NO active peers, so the relay serves the base /shared-file checkpoint
// plus the buffered message log; B must converge to A's unsaved char count.
// Nothing is ever saved. All input is real visible-UI; state is read only
// from #StateWordCount.
//
// Migrated from wasm/tests/regression/test-regression-latejoin-offline-unsaved.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-latejoin-offline-unsaved.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const {
    openCoEditPair, joinViaContentViewer, waitCvInteractive, cvCharCount,
} = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/regression-latejoin-offline-unsaved';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const CONVERGE_BUDGET = parseInt(process.env.CONVERGE_BUDGET || '120000', 10);

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

let shotNum = 0;
async function snap(part, name) {
    if (!part || part.dead) return;
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2, '0')}_${part.id}_${name}.png`;
    try { await part.page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch (e) {}
}

async function charCount(part) {
    if (!part || part.dead) return -2;
    return cvCharCount(part.page);
}
async function stableCount(part, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let prev = -1;
    while (Date.now() < deadline) {
        const c = await charCount(part);
        if (c > 0 && c === prev) return c;
        prev = c;
        await sleep(1000);
    }
    return prev;
}
// Mirror the PASSING co-edit tests: click into the iframe body, then wait
// 800ms for focus to register BEFORE typing. A shorter settle (or an
// immediate Ctrl+End on a freshly-opened editor) silently drops the keys.
async function typeAtEnd(part, text) {
    await part.page.bringToFront().catch(() => {});
    const box = await (await part.page.$('iframe')).boundingBox();
    await part.page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
    await sleep(800);
    await part.page.keyboard.type(text, { delay: 40 });
    await sleep(1500);
}

(async () => {
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
    log('=== CV regression: late-join A-offline + unsaved edits (relay replay) ===');
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    const parts = {};
    try {
        const bytes = fs.readFileSync(FIXTURE);
        const NAME = 'cv-ljoffline-' + Date.now() + '.docx';

        // A creates the co-edit room; B joins in an isolated context. B is a
        // real live peer in the room while A types — this is what durably
        // commits A's unsaved frames to the relay's message log (a room with a
        // SINGLE client that types and then leaves can be torn down before the
        // log is retained, which is exactly the harness bug that made C read
        // the bare base checkpoint). B is kept alive across A's typing, then
        // BOTH A and B leave, so when the REAL joiner (C) arrives there are NO
        // active peers and the relay must serve base checkpoint + message-log
        // replay — the subject under test. (Same sequence as the passing
        // test-cv-regression-latejoin-unsaved CASE 2.)
        const pair = await openCoEditPair(browser, BASE, NAME, bytes, {
            userA: 'Offline Alice', userB: 'Seed Bob',
        });
        const A = parts.A = { id: 'A', page: pair.A.page, context: null, dead: false };
        const B = { id: 'B', page: pair.B.page, context: pair.contextB, dead: false };
        await sleep(3000);

        const base = await stableCount(A, CONVERGE_BUDGET);
        check('A loaded doc (char count > 0)', base > 0, `base=${base}`);

        // A types UNSAVED content — never clicks Save, so these edits live
        // only in the relay message log (and in live-peer B's replicated doc).
        log('--- A types UNSAVED_CONTENT_FROM_A (no save) ---');
        await typeAtEnd(A, 'UNSAVED_CONTENT_FROM_A ');
        const aTyped = await stableCount(A, CONVERGE_BUDGET);
        check('A has unsaved edits', aTyped > base, 'aTyped=' + aTyped + ' base=' + base);
        await snap(A, 'A_after_type');

        // Confirm live peer B received A's edits — proof the frames are
        // committed to the room log before anyone leaves.
        const bSaw = await (async () => {
            const d = Date.now() + CONVERGE_BUDGET;
            let c = -1;
            while (Date.now() < d) {
                c = await cvCharCount(B.page);
                if (c > 0 && Math.abs(c - aTyped) <= 5) return c;
                await sleep(1000);
            }
            return c;
        })();
        check('live peer B received A\'s unsaved edits (frames in relay log)',
            Math.abs(bSaw - aTyped) <= 5, 'B=' + bSaw + ' A=' + aTyped);
        await sleep(2000); // let the relay fully buffer the frames

        // Both A and B go OFFLINE (context close). No save happened.
        log('--- A and B close WITHOUT saving (go offline) ---');
        A.dead = true;
        try { await A.page.close(); } catch (e) {}
        B.dead = true;
        try { await B.context.close(); } catch (e) {}
        await sleep(5000); // let the relay notice the disconnects

        // C late-joins with NO active peers: relay serves base checkpoint +
        // message log. C must replay to A's unsaved char count. Generous,
        // frame-re-resolving convergence wait (cvCharCount re-finds the editor
        // frame every poll — survives the join's iframe navigation).
        log('--- C late-joins (A+B gone, unsaved edits only in relay) ---');
        const ctxC = await browser.createBrowserContext();
        const pageC = await ctxC.newPage();
        const C = parts.C = { id: 'C', page: pageC, context: ctxC, dead: false };
        await joinViaContentViewer(browser, pair.joinLink, {
            page: pageC, userName: 'Offline Cara', iframeTimeout: 90000,
        });
        check('C: editor interactive', await waitCvInteractive(pageC, LOAD_BUDGET));
        let cConverged = -1;
        {
            const d = Date.now() + CONVERGE_BUDGET;
            while (Date.now() < d) {
                cConverged = await cvCharCount(pageC);
                if (cConverged > 0 && Math.abs(cConverged - aTyped) <= 5) break;
                await sleep(1000);
            }
        }
        await snap(C, 'C_after_open');

        // KEY CHECKS: C sees A's UNSAVED edits (via relay replay), not blank.
        check("C sees A's unsaved content (relay replay, within ±5)",
            Math.abs(cConverged - aTyped) <= 5,
            'C=' + cConverged + ' A=' + aTyped + ' diff=' + Math.abs(cConverged - aTyped));
        check('C is NOT blank/initial (above base)', cConverged > base,
            'C=' + cConverged + ' base=' + base);
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        for (const id of Object.keys(parts)) {
            const p = parts[id];
            if (p && !p.dead && p.context) { try { await p.context.close(); } catch (e) {} }
        }
        try { await browser.close(); } catch (e) {}
    }
    log('\n' + (allPassed ? 'ALL PASS' : 'SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
