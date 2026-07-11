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
async function typeAtEnd(part, text) {
    await part.page.bringToFront().catch(() => {});
    const box = await (await part.page.$('iframe')).boundingBox();
    await part.page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
    await sleep(400);
    await part.page.keyboard.down('Control');
    await part.page.keyboard.press('End');
    await part.page.keyboard.up('Control');
    await sleep(300);
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

        // A creates the co-edit room; B joins in an isolated context so we
        // have a live join link. We then close B immediately — we want the
        // late-join replay path with NO active peers when the REAL joiner
        // (C) arrives. (openCoEditPair returns after both are interactive;
        // we reuse only its join link.)
        const pair = await openCoEditPair(browser, BASE, NAME, bytes, {
            userA: 'Offline Alice', userB: 'Seed Bob',
        });
        const A = parts.A = { id: 'A', page: pair.A.page, context: null, dead: false };
        // Drop the seed B — it only existed to prove the room came up.
        try { await pair.contextB.close(); } catch (e) {}
        await sleep(3000);

        const base = await stableCount(A, CONVERGE_BUDGET);
        check('A loaded doc (char count > 0)', base > 0, `base=${base}`);

        // A types UNSAVED content — never clicks Save, so these edits live
        // only in the relay message log.
        log('--- A types UNSAVED_CONTENT_FROM_A (no save) ---');
        await typeAtEnd(A, 'UNSAVED_CONTENT_FROM_A ');
        const aTyped = await stableCount(A, CONVERGE_BUDGET);
        check('A has unsaved edits', aTyped > base, 'aTyped=' + aTyped + ' base=' + base);
        await snap(A, 'A_after_type');
        await sleep(2000); // let the relay buffer the frames

        // A goes OFFLINE (context close). No save happened.
        log('--- A closes WITHOUT saving (goes offline) ---');
        A.dead = true;
        try { await A.page.close(); } catch (e) {}
        await sleep(5000); // let the relay notice the disconnect

        // C late-joins with NO active peers: relay serves base checkpoint +
        // message log. C must replay to A's unsaved char count.
        log('--- C late-joins (A gone, unsaved edits only in relay) ---');
        const ctxC = await browser.createBrowserContext();
        const pageC = await ctxC.newPage();
        const C = parts.C = { id: 'C', page: pageC, context: ctxC, dead: false };
        await joinViaContentViewer(browser, pair.joinLink, {
            page: pageC, userName: 'Offline Cara', iframeTimeout: 90000,
        });
        check('C: editor interactive', await waitCvInteractive(pageC, LOAD_BUDGET));
        const cConverged = await stableCount(C, CONVERGE_BUDGET);
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
