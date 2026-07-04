const __cl = require('../../lib/inject-checklist');
// Co-editing LATE-JOIN with UNSAVED EDITS — must not hang; must converge.
//
// Reproduces the user-reported scenario: a second user joins a file that
// the first user has made "a few small edits" to (and NOT saved). The
// symptom was the joiner getting stuck forever on
//   "[relay] Activation pending: waiting for checkpoint download (60s/65s/…)"
//
// Root cause (relay-adapter.js, 0x05 join-response handler): the joiner
// must download the room checkpoint before it can activate. That download
// had (a) NO timeout on the direct-fetch path — a stalled request never
// resolved OR rejected, hanging the chain forever; and (b) NO retry — the
// terminal .catch only logged, so a single transient checkpoint-download
// failure left lateJoinFileReady=false forever and the activation poll
// printed "waiting for checkpoint download" without bound.
//
// The fix bounds the fetch (AbortController, 30s) and retries the whole
// source list with exponential backoff before giving up, only then
// surfacing a terminal RelayLateJoinFailed to the parent.
//
// This test drives the exact scenario through the visible UI and asserts
// the joiner activates within a bounded time (no runaway "waiting for
// checkpoint download"), never surfaces a terminal failure, and converges
// to the host's unsaved state — exercising the refactored
// fetchCheckpointWithRetry() path on every run.
//
// NOTE on fault injection: the network stall that ORIGINALLY triggered the
// hang cannot be injected on the local stack — the SW-bridge serves the
// checkpoint to the joiner from the parent viewer's memory with no
// interceptable network round-trip (verified: a co-edit joiner makes a
// single /api/v2/file GET for viewer staging and pulls the checkpoint via
// postMessage). The stall is real on Azure cold-loads, where the checkpoint
// locator is a live fetch. This test is the regression guard for the
// scenario + the refactor; the timeout/retry logic itself is the fix.

'use strict';

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { openViaViewer, openSecretInBrowser } = require('../../lib/open-via-viewer');
const { waitInFrame, evalInFrame } = require('../../lib/two-tab');

const VIEWER = env.FILE_STORAGE_URL;
const LOAD_TIMEOUT = env.scaleTimeout(120000);
const CONVERGE_TIMEOUT = env.scaleTimeout(120000);
const VP = { width: 1280, height: 900 };
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

async function charCount(page) {
    return evalInFrame(page, () => {
        const t = document.querySelector('#StateWordCount')?.textContent || '';
        const m = t.match(/([\d,]+)\s*character/);
        return m ? parseInt(m[1].replace(/,/g, '')) : -1;
    }).catch(() => -1);
}
async function stableCount(page, timeoutMs) {
    const deadline = Date.now() + timeoutMs; let prev = -1;
    while (Date.now() < deadline) { const c = await charCount(page); if (c > 0 && c === prev) return c; prev = c; await sleep(1000); }
    return prev;
}
async function convergeTo(pages, target, timeoutMs) {
    const deadline = Date.now() + timeoutMs; let counts = {};
    while (Date.now() < deadline) {
        counts = {}; let all = true;
        for (const [id, p] of Object.entries(pages)) { const c = await charCount(p); counts[id] = c; if (c !== target) all = false; }
        if (all) return { ok: true, counts };
        await sleep(500);
    }
    return { ok: false, counts };
}

(async () => {
    log('=== Co-editing LATE-JOIN with UNSAVED EDITS ===');
    const { browser } = await launch({ headless: 'new' });
    let ctxA = null, ctxB = null;
    try {
        const bytes = fs.readFileSync(FIXTURE);
        const upA = await openViaViewer(browser, VIEWER, 'ljretry-' + Date.now() + '.docx', bytes, {
            iframeTimeout: LOAD_TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
            isolatedContext: true, coEditing: true, viewport: VP,
        });
        const A = upA.page; ctxA = upA.context;
        await waitInFrame(A, () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''), { timeout: LOAD_TIMEOUT });
        await sleep(6000);
        check('A opened', (await charCount(A)) > 0);

        // A few small edits, deliberately NOT saved — so the joiner must
        // download the initial checkpoint AND replay these live messages.
        await A.mouse.click(400, 300); await sleep(500);
        for (const s of ['Hello ', 'world ', 'draft ']) { await A.keyboard.type(s, { delay: 40 }); await sleep(1200); }
        const target = await stableCount(A, CONVERGE_TIMEOUT);
        check('A has unsaved edits', target > 0, 'chars=' + target);

        // B late-joins. Watch its activation/checkpoint console signals.
        log('--- B late-joins ---');
        let lateJoinFailedSurfaced = false;
        let maxWaitSec = 0;
        let checkpointDownloaded = false;
        const onPage = (page) => {
            page.on('console', m => {
                const t = m.text();
                const wm = t.match(/waiting for checkpoint download \((\d+)s\)/i);
                if (wm) maxWaitSec = Math.max(maxWaitSec, parseInt(wm[1], 10));
                if (/RelayLateJoinFailed|Late-join file sync FAILED/i.test(t)) lateJoinFailedSurfaced = true;
                if (/Downloaded \d+B; hash=.*matches relay/i.test(t)) checkpointDownloaded = true;
            });
        };

        const joinStart = Date.now();
        const upB = await openSecretInBrowser(browser, VIEWER, upA.b64urlSecret, {
            iframeTimeout: LOAD_TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
            isolatedContext: true, coEditing: true, viewport: VP, onPage,
        });
        const B = upB.page; ctxB = upB.context;

        let bReady = false;
        try {
            await waitInFrame(B, () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''), { timeout: LOAD_TIMEOUT });
            bReady = true;
        } catch (e) { log('  B frame-wait failed: ' + e.message.slice(0, 80)); }
        const joinSec = ((Date.now() - joinStart) / 1000).toFixed(0);

        check('B reached ready (no checkpoint-download hang)', bReady, 'join took ' + joinSec + 's');
        check('B downloaded + verified the checkpoint', checkpointDownloaded);
        check('B never surfaced a terminal RelayLateJoinFailed', !lateJoinFailedSurfaced);
        // The activation-pending "waiting for checkpoint download" counter must
        // not run away. Locally it usually never even logs once; allow slack
        // for CI contention but assert it stayed well under the old-hang range.
        check('activation did NOT run away (waiting counter bounded)', maxWaitSec < 45, 'maxWaitSec=' + maxWaitSec);

        const r = await convergeTo({ A, B }, target, CONVERGE_TIMEOUT);
        check('B converges to A\'s unsaved state', r.ok, `target=${target} ${JSON.stringify(r.counts)}`);

        // B edits too — verify the session is live both ways after the join.
        await B.mouse.click(400, 300); await sleep(400);
        await B.keyboard.down('Control'); await B.keyboard.press('End'); await B.keyboard.up('Control'); await sleep(300);
        await B.keyboard.type('bEdit ', { delay: 40 }); await sleep(1500);
        const t2 = await stableCount(B, CONVERGE_TIMEOUT);
        const r2 = await convergeTo({ A, B }, t2, CONVERGE_TIMEOUT);
        check('B\'s post-join edit converges back to A', r2.ok, `target=${t2} ${JSON.stringify(r2.counts)}`);
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        for (const c of [ctxA, ctxB]) { if (c) { try { await c.close(); } catch (e) {} } }
        try { await browser.close(); } catch (e) {}
    }
    log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
