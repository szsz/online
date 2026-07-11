// test-cv-coedit-convergence-conflict.js — co-editing CONVERGENCE under
// CONFLICT through the Tresorit content viewer. Adversarial cases most likely
// to break convergence:
//   S1. Two users type at the SAME cursor position (Ctrl+Home) SIMULTANEOUSLY;
//       a late-joiner then converges.
//   S2. One user select-all-deletes the whole doc while another types; then a
//       fresh user late-joins the near-empty result.
//   S3. Three users type at once.
// Every live participant (and each late-joiner) must converge to one identical
// #StateWordCount; no checkpoint mismatch / crash. Visible-UI only.
//
// Migrated from wasm/tests/coedit/test-coedit-convergence-conflict.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-coedit-convergence-conflict.js [base-url]

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
const SHOT_DIR = '/tmp/content-viewer-report/coedit-convergence-conflict';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const CONVERGE_BUDGET = parseInt(process.env.CONVERGE_BUDGET || '120000', 10);
const VP = { width: 1280, height: 900 };
const ERR = /CHECKPOINT MISMATCH|memory access out of bounds|RuntimeError|unreachable|Aborted\(|OOB/i;

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
const errs = [];
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
function wire(p, tag) { p.on('console', m => { if (ERR.test(m.text())) errs.push(tag + ':' + m.text().slice(0, 80)); }); return p; }

// Whole-doc char count from the live editor frame; -9 while a selection is
// active (caller escapes first).
async function cc(p) {
    await p.keyboard.press('Escape').catch(() => {});
    await sleep(300);
    const fr = cvEditorFrame(p);
    if (!fr) return -1;
    return fr.evaluate(() => {
        const t = document.querySelector('#StateWordCount')?.textContent || '';
        if (/^\s*Selected/i.test(t)) return -9;
        const m = t.match(/([\d,]+)\s*characters?\b/);
        return m ? parseInt(m[1].replace(/,/g, '')) : -1;
    }).catch(() => -1);
}
async function stable(p, ms) { const d = Date.now() + ms; let pv = -1; while (Date.now() < d) { const c = await cc(p); if (c > 0 && c === pv) return c; pv = c; await sleep(800); } return pv; }
async function convergeAll(parts, ms) {
    const d = Date.now() + ms; let cs = {};
    while (Date.now() < d) {
        cs = {}; const vals = [];
        for (const [id, p] of Object.entries(parts)) { const c = await cc(p); cs[id] = c; vals.push(c); }
        if (vals.every(v => v > 0 && v === vals[0])) return { ok: true, cs, val: vals[0] };
        await sleep(700);
    }
    return { ok: false, cs };
}

// Click into the doc canvas (the iframe is inset within the tester page).
async function clickDoc(p) {
    const el = await p.$('iframe');
    const box = el && await el.boundingBox();
    if (box) await p.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
    await sleep(200);
}
async function atHome(p, txt) { await p.bringToFront().catch(() => {}); await clickDoc(p); await p.keyboard.down('Control'); await p.keyboard.press('Home'); await p.keyboard.up('Control'); await sleep(200); await p.keyboard.type(txt, { delay: 45 }); }
async function atEnd(p, txt) { await p.bringToFront().catch(() => {}); await clickDoc(p); await p.keyboard.down('Control'); await p.keyboard.press('End'); await p.keyboard.up('Control'); await sleep(200); await p.keyboard.type(txt, { delay: 45 }); }

// A joins the given room in a fresh isolated context, waits interactive.
async function join(browser, joinLink, tag) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await joinViaContentViewer(browser, joinLink, { page, userName: tag, viewport: VP, iframeTimeout: 90000 });
    wire(page, tag);
    // Wait for the joiner to actually finish its (cold) load before asserting
    // convergence — otherwise a not-yet-ready joiner reads -1 and looks like a
    // spurious divergence (the S2 batch-run flake).
    await waitCvInteractive(page, LOAD_BUDGET);
    await sleep(4000);
    return { page, ctx };
}

(async () => {
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
    log('=== CV co-editing CONVERGENCE under CONFLICT ===');
    log('viewer: ' + BASE);
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    const bytes = fs.readFileSync(FIXTURE);
    const { browser } = await launch({ headless: 'new' });
    try {
        // S1: concurrent same-position typing
        { const pair = await openCoEditPair(browser, BASE, 'cv-cvc1-' + Date.now() + '.docx', bytes, { userA: 'A1', userB: 'B1', viewport: VP, loadBudgetMs: LOAD_BUDGET });
          const A = wire(pair.A.page, 'A'); const B = wire(pair.B.page, 'B'); const ctxB = pair.contextB;
          await sleep(6000);
          const base = await stable(A, CONVERGE_BUDGET);
          await Promise.all([atHome(A, 'AAAAAAAA'), atHome(B, 'BBBBBBBB')]); await sleep(3000);
          const r = await convergeAll({ A, B }, CONVERGE_BUDGET);
          check('S1 concurrent same-position edits converge', r.ok, `base=${base} ${JSON.stringify(r.cs)}`);
          const jC = await join(browser, pair.joinLink, 'C'); const C = jC.page;
          const r2 = await convergeAll({ A, C }, CONVERGE_BUDGET);
          check('S1 late-joiner converges', r2.ok, JSON.stringify(r2.cs));
          for (const c of [ctxB, jC.ctx]) { try { await c.close(); } catch (e) {} }
        }
        // S2: select-all-delete racing a remote type, then late-join
        { const pair = await openCoEditPair(browser, BASE, 'cv-cvc2-' + Date.now() + '.docx', bytes, { userA: 'A2', userB: 'B2', viewport: VP, loadBudgetMs: LOAD_BUDGET });
          const A = wire(pair.A.page, 'A'); const B = wire(pair.B.page, 'B'); const ctxB = pair.contextB;
          await sleep(6000);
          await atEnd(A, 'seed text here '); await sleep(2500); await stable(A, CONVERGE_BUDGET);
          await A.bringToFront(); await clickDoc(A);
          await A.keyboard.down('Control'); await A.keyboard.press('KeyA'); await A.keyboard.up('Control'); await sleep(300);
          await Promise.all([(async () => { await A.keyboard.press('Delete'); })(), atEnd(B, 'CCCC')]); await sleep(3500);
          const r = await convergeAll({ A, B }, CONVERGE_BUDGET);
          check('S2 select-all-delete vs type converges', r.ok, JSON.stringify(r.cs));
          const jC = await join(browser, pair.joinLink, 'C'); const C = jC.page;
          const r2 = await convergeAll({ A, C }, CONVERGE_BUDGET);
          check('S2 late-joiner converges to near-empty doc', r2.ok, JSON.stringify(r2.cs));
          for (const c of [ctxB, jC.ctx]) { try { await c.close(); } catch (e) {} }
        }
        // S3: three-browser simultaneous typing
        { const pair = await openCoEditPair(browser, BASE, 'cv-cvc3-' + Date.now() + '.docx', bytes, { userA: 'A3', userB: 'B3', viewport: VP, loadBudgetMs: LOAD_BUDGET });
          const A = wire(pair.A.page, 'A'); const B = wire(pair.B.page, 'B'); const ctxB = pair.contextB;
          await sleep(6000);
          const jC = await join(browser, pair.joinLink, 'C'); const C = jC.page;
          const base = await stable(A, CONVERGE_BUDGET);
          await Promise.all([atEnd(A, 'aaaa '), atEnd(B, 'bbbb '), atEnd(C, 'cccc ')]); await sleep(4000);
          const r = await convergeAll({ A, B, C }, CONVERGE_BUDGET);
          check('S3 three-browser simultaneous converge', r.ok, `base=${base} ${JSON.stringify(r.cs)}`);
          for (const c of [ctxB, jC.ctx]) { try { await c.close(); } catch (e) {} }
        }
        check('no checkpoint-mismatch / abort / OOB across all scenarios', errs.length === 0, errs.slice(0, 3).join(' | '));
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log('\n' + (allPassed ? 'ALL PASS' : 'SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
