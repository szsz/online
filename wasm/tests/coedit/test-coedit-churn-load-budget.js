const __cl = require('../../lib/inject-checklist');
// Co-editing CHURN STORM with a LOAD-TIME BUDGET.
//
// A host stays and drives continuous mixed edits (type / periodic save). Each
// round one or two NEW users join; every join's cold load->ready time is
// measured and asserted under a hard budget (a user that cannot load the doc
// in time is a FAILURE — this catches the "waiting for checkpoint download"
// hang class and any load regression). After every round all LIVE participants
// must converge; users leave across rounds; a final fresh user replays the
// whole storm. No crash / checkpoint mismatch.
//
// NOTE: the hard budget is 60s (catches hangs / true regressions). Cold joins
// currently take ~25-45s (WASM cold-start, no shipped snapshot) so joins above
// SLOW_WARN are logged but not failed yet; tighten toward ~20s once
// ai/tasks/todo/ship-prebuilt-snapshot-fast-first-load.md lands.

'use strict';

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { openViaViewer, openSecretInBrowser } = require('../../lib/open-via-viewer');
const { waitInFrame, evalInFrame } = require('../../lib/two-tab');

const VIEWER = env.FILE_STORAGE_URL;
const LT = env.scaleTimeout(150000);
const JOIN_BUDGET = env.scaleTimeout(60000);   // "cannot load quickly enough" => FAIL
const SLOW_WARN = env.scaleTimeout(30000);
const ROUNDS = 5;
const VP = { width: 1280, height: 900 };
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const ERR = /CHECKPOINT MISMATCH|memory access out of bounds|RuntimeError|unreachable|Aborted\(|OOB/i;

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
const errs = [], joinTimes = [];
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
function wire(p, tag) { p.on('console', m => { if (ERR.test(m.text())) errs.push(tag + ':' + m.text().slice(0, 70)); }); return p; }
async function cc(p) {
    await p.keyboard.press('Escape').catch(() => {}); await sleep(250);
    return evalInFrame(p, () => {
        const t = document.querySelector('#StateWordCount')?.textContent || '';
        if (/^\s*Selected/i.test(t)) return -9;
        const m = t.match(/([\d,]+)\s*characters?\b/);
        return m ? parseInt(m[1].replace(/,/g, '')) : -1;
    }).catch(() => -1);
}
async function stable(p, ms) { const d = Date.now() + ms; let pv = -1; while (Date.now() < d) { const c = await cc(p); if (c > 0 && c === pv) return c; pv = c; await sleep(700); } return pv; }
// Target-FREE convergence: wait until every live client reports the SAME
// positive char count (converged to a common value), whatever that value is.
// Comparing against a pre-snapshotted target is racy under churn — an in-flight
// edit can bump everyone AFTER the snapshot, so all clients agree yet != the
// stale target (false failure). What we actually care about is that they all
// AGREE, which is the real convergence property.
async function convergeAll(parts, ms) {
    const d = Date.now() + ms; let cs = {};
    while (Date.now() < d) {
        cs = {}; const vals = [];
        for (const [id, p] of Object.entries(parts)) { const c = await cc(p); cs[id] = c; vals.push(c); }
        if (vals.length && vals.every(v => v > 0 && v === vals[0])) return { ok: true, cs, val: vals[0] };
        await sleep(600);
    }
    return { ok: false, cs };
}
async function timedJoin(browser, secret, tag) {
    const t = Date.now();
    const up = await openSecretInBrowser(browser, VIEWER, secret, { isolatedContext: true, coEditing: true, viewport: VP, iframeTimeout: LT, gotoTimeout: env.scaleTimeout(60000) });
    wire(up.page, tag);
    let ready = true;
    try { await waitInFrame(up.page, () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''), { timeout: JOIN_BUDGET }); } catch (e) { ready = false; }
    const dt = Date.now() - t; joinTimes.push({ tag, dt, ready });
    check(`${tag} loaded within budget (${(JOIN_BUDGET / 1000) | 0}s)`, ready && dt <= JOIN_BUDGET, `${(dt / 1000).toFixed(1)}s${!ready ? ' NOT-READY' : ''}${dt > SLOW_WARN && ready ? ' SLOW' : ''}`);
    await sleep(3000);
    return up;
}
async function typeEnd(p, txt) { await p.bringToFront().catch(() => {}); await p.mouse.click(500, 360); await sleep(200); await p.keyboard.down('Control'); await p.keyboard.press('End'); await p.keyboard.up('Control'); await sleep(150); await p.keyboard.type(txt, { delay: 35 }); await sleep(800); }
async function save(p) { await p.bringToFront().catch(() => {}); await p.keyboard.down('Control'); await p.keyboard.press('KeyS'); await p.keyboard.up('Control'); await sleep(4000); }

(async () => {
    log('=== Co-editing CHURN STORM + LOAD BUDGET ===');
    const { browser } = await launch({ headless: 'new' }); const live = {};
    try {
        const upA = await openViaViewer(browser, VIEWER, 'churn-' + Date.now() + '.docx', fs.readFileSync(FIXTURE), { isolatedContext: true, coEditing: true, viewport: VP, iframeTimeout: LT });
        wire(upA.page, 'A');
        await waitInFrame(upA.page, () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''), { timeout: LT }); await sleep(6000);
        const secret = upA.b64urlSecret; live.A = upA;
        check('host A opened', (await cc(upA.page)) > 0);
        let seq = 0;
        for (let r = 1; r <= ROUNDS; r++) {
            log(`--- round ${r} ---`);
            await typeEnd(upA.page, `r${r}A `);
            if (r % 3 === 0) { await save(upA.page); log('  A saved (checkpoint rotate)'); }
            const joiners = [];
            seq++; joiners.push(timedJoin(browser, secret, 'J' + seq));
            if (r % 2 === 0) { seq++; joiners.push(timedJoin(browser, secret, 'J' + seq)); }
            const ups = await Promise.all(joiners);
            ups.forEach((u, i) => { live['J' + (seq - ups.length + 1 + i)] = u; });
            for (const u of ups) await typeEnd(u.page, 'x');
            await stable(upA.page, CONVERGE_MS()); // let A settle before checking agreement
            const parts = {}; for (const [id, u] of Object.entries(live)) if (u && !u._dead) parts[id] = u.page;
            const cr = await convergeAll(parts, CONVERGE_MS());
            check(`round ${r}: all ${Object.keys(parts).length} live converge`, cr.ok, `converged@${cr.val || '-'} ${JSON.stringify(cr.cs)}`);
            if (r % 2 === 1) { const vic = Object.keys(live).filter(k => k !== 'A' && !live[k]._dead); if (vic.length) { const v = vic[0]; log(`  ${v} leaves`); try { await live[v].context.close(); } catch (e) {} live[v]._dead = true; } }
        }
        seq++; const F = await timedJoin(browser, secret, 'F' + seq); live.F = F;
        await stable(upA.page, CONVERGE_MS());
        const cr = await convergeAll({ A: upA.page, F: F.page }, CONVERGE_MS());
        check('final fresh joiner replays full storm', cr.ok, `converged@${cr.val || '-'} ${JSON.stringify(cr.cs)}`);
        check('no crash / checkpoint-mismatch across storm', errs.length === 0, errs.slice(0, 3).join(' | '));
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 200));
    } finally {
        for (const k of Object.keys(live)) { const u = live[k]; if (u && !u._dead) { try { await u.context.close(); } catch (e) {} } }
        try { await browser.close(); } catch (e) {}
    }
    const slow = joinTimes.filter(j => !j.ready || j.dt > SLOW_WARN);
    log('\n===== SUMMARY =====');
    log('  joins: ' + joinTimes.map(j => `${j.tag}=${(j.dt / 1000).toFixed(0)}s${j.ready ? '' : '!'}`).join(' '));
    if (joinTimes.length) log('  max join: ' + (Math.max(...joinTimes.map(j => j.dt)) / 1000).toFixed(1) + 's  slow(>30s)/failed: ' + slow.length + ' (informational until shipped-snapshot lands)');
    log(allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED');
    process.exit(allPassed ? 0 : 1);
})();

function CONVERGE_MS() { return env.scaleTimeout(120000); }
