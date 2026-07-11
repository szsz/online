// test-cv-coedit-churn-load-budget.js — co-editing CHURN STORM with a
// LOAD-TIME BUDGET through the Tresorit content viewer.
//
// A host stays and drives continuous mixed edits (type / periodic tester
// Save). Each round one or two NEW users join; every join's cold load->ready
// time is measured and asserted under a hard budget (a user that cannot load
// the doc in time is a FAILURE — this catches the "waiting for checkpoint
// download" hang class and any load regression). After every round all LIVE
// participants must converge; users leave across rounds; a final fresh user
// replays the whole storm. No crash / checkpoint mismatch.
//
// NOTE: the hard budget is 60s (catches hangs / true regressions). Cold joins
// currently take ~25-45s (WASM cold-start, no shipped snapshot) so joins above
// SLOW_WARN are logged but not failed yet.
//
// Migrated from wasm/tests/coedit/test-coedit-churn-load-budget.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-coedit-churn-load-budget.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const {
    openCoEditPair, joinViaContentViewer, waitCvInteractive, cvEditorFrame,
} = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/coedit-churn-load-budget';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const JOIN_BUDGET = parseInt(process.env.JOIN_BUDGET || '60000', 10);   // "cannot load quickly enough" => FAIL
const SLOW_WARN = parseInt(process.env.SLOW_WARN || '30000', 10);
const CONVERGE_BUDGET = parseInt(process.env.CONVERGE_BUDGET || '120000', 10);
const ROUNDS = 5;
const VP = { width: 1280, height: 900 };
const ERR = /CHECKPOINT MISMATCH|memory access out of bounds|RuntimeError|unreachable|Aborted\(|OOB/i;

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
const errs = [], joinTimes = [];
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
function wire(p, tag) { p.on('console', m => { if (ERR.test(m.text())) errs.push(tag + ':' + m.text().slice(0, 70)); }); return p; }

async function cc(p) {
    await p.keyboard.press('Escape').catch(() => {}); await sleep(250);
    const fr = cvEditorFrame(p);
    if (!fr) return -1;
    return fr.evaluate(() => {
        const t = document.querySelector('#StateWordCount')?.textContent || '';
        if (/^\s*Selected/i.test(t)) return -9;
        const m = t.match(/([\d,]+)\s*characters?\b/);
        return m ? parseInt(m[1].replace(/,/g, '')) : -1;
    }).catch(() => -1);
}
async function stable(p, ms) { const d = Date.now() + ms; let pv = -1; while (Date.now() < d) { const c = await cc(p); if (c > 0 && c === pv) return c; pv = c; await sleep(700); } return pv; }
// Target-FREE convergence: wait until every live client reports the SAME
// positive char count (converged to a common value), whatever that value is.
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
async function clickDoc(p) {
    const el = await p.$('iframe');
    const box = el && await el.boundingBox();
    if (box) await p.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
    await sleep(150);
}
async function timedJoin(browser, joinLink, tag) {
    const t = Date.now();
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await joinViaContentViewer(browser, joinLink, { page, userName: tag, viewport: VP, iframeTimeout: LOAD_BUDGET });
    wire(page, tag);
    const ready = await waitCvInteractive(page, JOIN_BUDGET);
    const dt = Date.now() - t; joinTimes.push({ tag, dt, ready });
    check(`${tag} loaded within budget (${(JOIN_BUDGET / 1000) | 0}s)`, ready && dt <= JOIN_BUDGET, `${(dt / 1000).toFixed(1)}s${!ready ? ' NOT-READY' : ''}${dt > SLOW_WARN && ready ? ' SLOW' : ''}`);
    await sleep(3000);
    return { page, ctx, _dead: false };
}
async function typeEnd(p, txt) { await p.bringToFront().catch(() => {}); await clickDoc(p); await p.keyboard.down('Control'); await p.keyboard.press('End'); await p.keyboard.up('Control'); await sleep(150); await p.keyboard.type(txt, { delay: 35 }); await sleep(800); }
// Tester Save button — rotates the relay checkpoint in the CV co-edit room.
async function save(p) {
    await p.bringToFront().catch(() => {});
    const h = await p.evaluateHandle(() => [...document.querySelectorAll('button')].find(b => /^save$/i.test((b.textContent || '').trim())));
    const el = h.asElement();
    if (el) await el.click();
    await sleep(4000);
}

(async () => {
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
    log('=== CV co-editing CHURN STORM + LOAD BUDGET ===');
    log('viewer: ' + BASE);
    const bytes = fs.readFileSync(FIXTURE);
    const { browser } = await launch({ headless: 'new' });
    const live = {};
    try {
        // Host A opens the room; B is the first co-edit peer (baseline pair).
        const pair = await openCoEditPair(browser, BASE, 'cv-churn-' + Date.now() + '.docx', bytes, {
            userA: 'Alice Churn', userB: 'Bob Churn', viewport: VP, loadBudgetMs: LOAD_BUDGET,
        });
        wire(pair.A.page, 'A'); wire(pair.B.page, 'B');
        const joinLink = pair.joinLink;
        live.A = { page: pair.A.page, ctx: null, _dead: false };
        live.B = { page: pair.B.page, ctx: pair.contextB, _dead: false };
        await sleep(6000);
        check('host A opened', (await cc(pair.A.page)) > 0);
        let seq = 0;
        for (let r = 1; r <= ROUNDS; r++) {
            log(`--- round ${r} ---`);
            await typeEnd(live.A.page, `r${r}A `);
            if (r % 3 === 0) { await save(live.A.page); log('  A saved (checkpoint rotate)'); }
            const joiners = [];
            seq++; joiners.push(timedJoin(browser, joinLink, 'J' + seq));
            if (r % 2 === 0) { seq++; joiners.push(timedJoin(browser, joinLink, 'J' + seq)); }
            const ups = await Promise.all(joiners);
            ups.forEach((u, i) => { live['J' + (seq - ups.length + 1 + i)] = u; });
            for (const u of ups) await typeEnd(u.page, 'x');
            await stable(live.A.page, CONVERGE_BUDGET); // let A settle before checking agreement
            const parts = {}; for (const [id, u] of Object.entries(live)) if (u && !u._dead) parts[id] = u.page;
            const cr = await convergeAll(parts, CONVERGE_BUDGET);
            check(`round ${r}: all ${Object.keys(parts).length} live converge`, cr.ok, `converged@${cr.val || '-'} ${JSON.stringify(cr.cs)}`);
            if (r % 2 === 1) { const vic = Object.keys(live).filter(k => k !== 'A' && !live[k]._dead); if (vic.length) { const v = vic[0]; log(`  ${v} leaves`); if (live[v].ctx) { try { await live[v].ctx.close(); } catch (e) {} } live[v]._dead = true; } }
        }
        seq++; const F = await timedJoin(browser, joinLink, 'F' + seq); live.F = F;
        await stable(live.A.page, CONVERGE_BUDGET);
        const cr = await convergeAll({ A: live.A.page, F: F.page }, CONVERGE_BUDGET);
        check('final fresh joiner replays full storm', cr.ok, `converged@${cr.val || '-'} ${JSON.stringify(cr.cs)}`);
        check('no crash / checkpoint-mismatch across storm', errs.length === 0, errs.slice(0, 3).join(' | '));
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 200));
    } finally {
        for (const k of Object.keys(live)) { const u = live[k]; if (u && !u._dead && u.ctx) { try { await u.ctx.close(); } catch (e) {} } }
        try { await browser.close(); } catch (e) {}
    }
    const slow = joinTimes.filter(j => !j.ready || j.dt > SLOW_WARN);
    log('\n===== SUMMARY =====');
    log('  joins: ' + joinTimes.map(j => `${j.tag}=${(j.dt / 1000).toFixed(0)}s${j.ready ? '' : '!'}`).join(' '));
    if (joinTimes.length) log('  max join: ' + (Math.max(...joinTimes.map(j => j.dt)) / 1000).toFixed(1) + 's  slow(>30s)/failed: ' + slow.length + ' (informational until shipped-snapshot lands)');
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
