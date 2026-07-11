// test-cv-coedit-latejoin-checkpoint-retry.js — a second user late-joins a
// room whose host has made a few small UNSAVED edits; the joiner must
// activate promptly (no runaway checkpoint-download wait), converge to the
// host's unsaved state, and edit back so the session is live both ways.
//
// Legacy subject (viewer): guarded the fetchCheckpointWithRetry() fix — the
// 0x05 join-response handler used to hang forever ("waiting for checkpoint
// download (60s/65s/…)") when the checkpoint fetch stalled with no timeout
// and no retry. The fix bounds the fetch (AbortController, 30s) and retries
// the source list with backoff.
//
// N/A IN CV (documented): the storage-timeout / retry machinery cannot be
// exercised through the content viewer — a CV co-edit joiner pulls the
// checkpoint from the SAME-ORIGIN /shared-file store with no interceptable
// stalling network round-trip (the stall is only reproducible on Azure
// cold-load legacy-viewer fetches). So the legacy asserts on the
// "waiting for checkpoint download" counter, RelayLateJoinFailed, and the
// verified-download console signal are NOT ported. What survives is the
// behavioural guard the fix protected: join-during-active-unsaved-edits
// activates without a runaway wait, converges, and stays live both ways.
//
// Migrated from wasm/tests/coedit/test-coedit-latejoin-checkpoint-retry.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-coedit-latejoin-checkpoint-retry.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const {
    openBytesViaContentViewer, joinViaContentViewer, waitCvInteractive, cvCharCount,
} = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/coedit-latejoin-checkpoint-retry';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const CONVERGE_BUDGET = parseInt(process.env.CONVERGE_BUDGET || '120000', 10);
// Bound on how long B may take to become interactive after joining — a
// runaway "waiting for checkpoint download" hang would blow past this.
const ACTIVATE_BUDGET = parseInt(process.env.ACTIVATE_BUDGET || '120000', 10);

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

async function charCount(page) { return cvCharCount(page); }
async function stableCount(page, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let prev = -1;
    while (Date.now() < deadline) {
        const c = await charCount(page);
        if (c > 0 && c === prev) return c;
        prev = c;
        await sleep(1000);
    }
    return prev;
}
async function convergeTo(pages, target, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let counts = {};
    while (Date.now() < deadline) {
        counts = {};
        let all = true;
        for (const [id, p] of Object.entries(pages)) {
            const c = await charCount(p);
            counts[id] = c;
            if (c !== target) all = false;
        }
        if (all) return { ok: true, counts };
        await sleep(500);
    }
    return { ok: false, counts };
}
async function clickDoc(page) {
    const box = await (await page.$('iframe')).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
    await sleep(400);
}

(async () => {
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
    log('=== CV co-editing LATE-JOIN with UNSAVED EDITS ===');
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    let ctxB = null;
    try {
        const bytes = fs.readFileSync(FIXTURE);
        const NAME = 'cv-ljretry-' + Date.now() + '.docx';

        // A creates the co-edit room.
        const openA = await openBytesViaContentViewer(browser, BASE, NAME, bytes, {
            userName: 'Retry Alice', coEdit: true, iframeTimeout: 60000,
        });
        const A = openA.page;
        check('A: editor iframe + join link', !!openA.editorFrame && !!openA.joinLink);
        check('A: editor interactive', await waitCvInteractive(A, LOAD_BUDGET));
        await sleep(6000);
        check('A opened', (await charCount(A)) > 0);

        // A few small edits, deliberately NOT saved — so the joiner must pull
        // the base checkpoint AND replay these live messages.
        await clickDoc(A);
        await A.keyboard.down('Control'); await A.keyboard.press('End'); await A.keyboard.up('Control');
        await sleep(300);
        for (const s of ['Hello ', 'world ', 'draft ']) { await A.keyboard.type(s, { delay: 40 }); await sleep(1200); }
        const target = await stableCount(A, CONVERGE_BUDGET);
        check('A has unsaved edits', target > 0, 'chars=' + target);

        // B late-joins. Assert it activates within a BOUNDED time (a runaway
        // checkpoint-download hang would exceed ACTIVATE_BUDGET).
        log('--- B late-joins ---');
        const joinStart = Date.now();
        ctxB = await browser.createBrowserContext();
        const pageB = await ctxB.newPage();
        await joinViaContentViewer(browser, openA.joinLink, {
            page: pageB, userName: 'Retry Bob', iframeTimeout: 90000,
        });
        const bReady = await waitCvInteractive(pageB, ACTIVATE_BUDGET);
        const joinSec = ((Date.now() - joinStart) / 1000).toFixed(0);
        check('B reached ready (no checkpoint-download hang)', bReady, 'join took ' + joinSec + 's');

        const r = await convergeTo({ A, B: pageB }, target, CONVERGE_BUDGET);
        check("B converges to A's unsaved state", r.ok, `target=${target} ${JSON.stringify(r.counts)}`);

        // B edits too — verify the session is live both ways after the join.
        await clickDoc(pageB);
        await pageB.keyboard.down('Control'); await pageB.keyboard.press('End'); await pageB.keyboard.up('Control');
        await sleep(300);
        await pageB.keyboard.type('bEdit ', { delay: 40 });
        await sleep(1500);
        const t2 = await stableCount(pageB, CONVERGE_BUDGET);
        const r2 = await convergeTo({ A, B: pageB }, t2, CONVERGE_BUDGET);
        check("B's post-join edit converges back to A", r2.ok, `target=${t2} ${JSON.stringify(r2.counts)}`);

        try {
            fs.mkdirSync(SHOT_DIR, { recursive: true });
            await A.screenshot({ path: SHOT_DIR + '/a-final.png' });
            await pageB.screenshot({ path: SHOT_DIR + '/b-final.png' });
        } catch (e) {}
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        if (ctxB) { try { await ctxB.close(); } catch (e) {} }
        try { await browser.close(); } catch (e) {}
    }
    log('\n' + (allPassed ? 'ALL PASS' : 'SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
