const __cl = require('../../lib/inject-checklist');
// Co-editing CONVERGENCE under CONFLICT — adversarial cases most likely to
// break convergence:
//   S1. Two users type at the SAME cursor position (Ctrl+Home) SIMULTANEOUSLY.
//   S2. One user select-all-deletes the whole doc while another types; then a
//       fresh user late-joins the near-empty result.
//   S3. Three users type at once.
// Every live participant (and each late-joiner) must converge to one identical
// #StateWordCount; no checkpoint mismatch / crash. Visible-UI only.

'use strict';

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { openViaViewer, openSecretInBrowser } = require('../../lib/open-via-viewer');
const { waitInFrame, evalInFrame } = require('../../lib/two-tab');

const VIEWER = env.FILE_STORAGE_URL;
const LT = env.scaleTimeout(150000);
const CONVERGE = env.scaleTimeout(120000);
const VP = { width: 1280, height: 900 };
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const ERR = /CHECKPOINT MISMATCH|memory access out of bounds|RuntimeError|unreachable|Aborted\(|OOB/i;

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
const errs = [];
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
function wire(p, tag) { p.on('console', m => { if (ERR.test(m.text())) errs.push(tag + ':' + m.text().slice(0, 80)); }); return p; }

async function cc(p) {
    await p.keyboard.press('Escape').catch(() => {});
    await sleep(300);
    return evalInFrame(p, () => {
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
async function openHost(browser, name) {
    const up = await openViaViewer(browser, VIEWER, name, fs.readFileSync(FIXTURE), { isolatedContext: true, coEditing: true, viewport: VP, iframeTimeout: LT });
    wire(up.page, 'host');
    await waitInFrame(up.page, () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''), { timeout: LT });
    await sleep(6000);
    return up;
}
async function join(browser, secret, tag) {
    const up = await openSecretInBrowser(browser, VIEWER, secret, { isolatedContext: true, coEditing: true, viewport: VP, iframeTimeout: LT, gotoTimeout: env.scaleTimeout(60000) });
    wire(up.page, tag);
    // Wait for the joiner to actually finish its (cold) load before asserting
    // convergence — otherwise a not-yet-ready joiner reads -1 and looks like a
    // spurious divergence (the S2 batch-run flake).
    await waitInFrame(up.page, () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''), { timeout: LT });
    await sleep(4000);
    return up;
}
async function atHome(p, txt) { await p.bringToFront().catch(() => {}); await p.mouse.click(500, 360); await sleep(200); await p.keyboard.down('Control'); await p.keyboard.press('Home'); await p.keyboard.up('Control'); await sleep(200); await p.keyboard.type(txt, { delay: 45 }); }
async function atEnd(p, txt) { await p.bringToFront().catch(() => {}); await p.mouse.click(500, 360); await sleep(200); await p.keyboard.down('Control'); await p.keyboard.press('End'); await p.keyboard.up('Control'); await sleep(200); await p.keyboard.type(txt, { delay: 45 }); }

(async () => {
    log('=== Co-editing CONVERGENCE under CONFLICT ===');
    const { browser } = await launch({ headless: 'new' });
    try {
        // S1: concurrent same-position typing
        { const upA = await openHost(browser, 'cvc1-' + Date.now() + '.docx'); const A = upA.page;
          const upB = await join(browser, upA.b64urlSecret, 'B'); const B = upB.page;
          const base = await stable(A, CONVERGE);
          await Promise.all([atHome(A, 'AAAAAAAA'), atHome(B, 'BBBBBBBB')]); await sleep(3000);
          const r = await convergeAll({ A, B }, CONVERGE);
          check('S1 concurrent same-position edits converge', r.ok, `base=${base} ${JSON.stringify(r.cs)}`);
          const upC = await join(browser, upA.b64urlSecret, 'C'); const C = upC.page;
          const r2 = await convergeAll({ A, C }, CONVERGE);
          check('S1 late-joiner converges', r2.ok, JSON.stringify(r2.cs));
          for (const u of [upA, upB, upC]) { try { await u.context.close(); } catch (e) {} }
        }
        // S2: select-all-delete racing a remote type, then late-join
        { const upA = await openHost(browser, 'cvc2-' + Date.now() + '.docx'); const A = upA.page;
          const upB = await join(browser, upA.b64urlSecret, 'B'); const B = upB.page;
          await atEnd(A, 'seed text here '); await sleep(2500); await stable(A, CONVERGE);
          await A.bringToFront(); await A.mouse.click(500, 360); await sleep(200);
          await A.keyboard.down('Control'); await A.keyboard.press('KeyA'); await A.keyboard.up('Control'); await sleep(300);
          await Promise.all([(async () => { await A.keyboard.press('Delete'); })(), atEnd(B, 'CCCC')]); await sleep(3500);
          const r = await convergeAll({ A, B }, CONVERGE);
          check('S2 select-all-delete vs type converges', r.ok, JSON.stringify(r.cs));
          const upC = await join(browser, upA.b64urlSecret, 'C'); const C = upC.page;
          const r2 = await convergeAll({ A, C }, CONVERGE);
          check('S2 late-joiner converges to near-empty doc', r2.ok, JSON.stringify(r2.cs));
          for (const u of [upA, upB, upC]) { try { await u.context.close(); } catch (e) {} }
        }
        // S3: three-browser simultaneous typing
        { const upA = await openHost(browser, 'cvc3-' + Date.now() + '.docx'); const A = upA.page;
          const upB = await join(browser, upA.b64urlSecret, 'B'); const B = upB.page;
          const upC = await join(browser, upA.b64urlSecret, 'C'); const C = upC.page;
          const base = await stable(A, CONVERGE);
          await Promise.all([atEnd(A, 'aaaa '), atEnd(B, 'bbbb '), atEnd(C, 'cccc ')]); await sleep(4000);
          const r = await convergeAll({ A, B, C }, CONVERGE);
          check('S3 three-browser simultaneous converge', r.ok, `base=${base} ${JSON.stringify(r.cs)}`);
          for (const u of [upA, upB, upC]) { try { await u.context.close(); } catch (e) {} }
        }
        check('no checkpoint-mismatch / abort / OOB across all scenarios', errs.length === 0, errs.slice(0, 3).join(' | '));
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
