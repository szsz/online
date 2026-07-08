const __cl = require('../../lib/inject-checklist');
// Co-editing LATE-JOIN after MANY UNSAVED messages — replay must not be lost
// to the switchdocument reload.
//
// Reproduces a late-join edit-loss race: when the host has accumulated many
// UNSAVED edits (here ~34 chars + a paragraph split (Enter) + a concurrent
// peer edit ≈ 90 relay messages), a fresh joiner used to end up on the BARE
// BASE DOCUMENT — every edit lost — because its ~90 replayed messages were
// applied to the prewarm-blank doc and finished BEFORE `switchdocument`
// loaded the real (base) checkpoint, which then discarded them. Reproduced
// 2/2 → C=19 (base) vs live A=B=53, no checkpoint mismatch.
//
// Fix: the kit sets window.__wasmSwitchDocLoaded at the switchdocument-complete
// point (kit/ChildSession.cpp), and relay-adapter's activation poll holds
// replay until that flag is set — so replay applies to the switched-in
// checkpoint doc, not the blank. This test asserts the late-joiner converges
// to the host's full unsaved state. FAILS pre-fix (joiner one+ edits short).
//
// Visible-UI only; convergence = equal #StateWordCount.

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
    await p.keyboard.press('Escape').catch(() => {}); await sleep(300);
    return evalInFrame(p, () => {
        const t = document.querySelector('#StateWordCount')?.textContent || '';
        if (/^\s*Selected/i.test(t)) return -9;
        const m = t.match(/([\d,]+)\s*characters?\b/);
        return m ? parseInt(m[1].replace(/,/g, '')) : -1;
    }).catch(() => -1);
}
async function stable(p, ms) { const d = Date.now() + ms; let pv = -1; while (Date.now() < d) { const c = await cc(p); if (c > 0 && c === pv) return c; pv = c; await sleep(800); } return pv; }
async function convergeTo(pages, target, ms) { const d = Date.now() + ms; let cs = {}; while (Date.now() < d) { cs = {}; let ok = true; for (const [id, p] of Object.entries(pages)) { const c = await cc(p); cs[id] = c; if (c !== target) ok = false; } if (ok) return { ok: true, cs }; await sleep(600); } return { ok: false, cs }; }
async function atEnd(p, txt) { await p.bringToFront().catch(() => {}); await p.mouse.click(500, 360); await sleep(200); await p.keyboard.down('Control'); await p.keyboard.press('End'); await p.keyboard.up('Control'); await sleep(150); await p.keyboard.type(txt, { delay: 40 }); await sleep(800); }

(async () => {
    log('=== Co-editing LATE-JOIN after MANY UNSAVED messages ===');
    const { browser } = await launch({ headless: 'new' });
    let ctxA, ctxB, ctxC;
    try {
        const upA = await openViaViewer(browser, VIEWER, 'ljmm-' + Date.now() + '.docx', fs.readFileSync(FIXTURE), { isolatedContext: true, coEditing: true, viewport: VP, iframeTimeout: LT });
        const A = upA.page; ctxA = upA.context; wire(A, 'A');
        await waitInFrame(A, () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''), { timeout: LT }); await sleep(6000);
        const upB = await openSecretInBrowser(browser, VIEWER, upA.b64urlSecret, { isolatedContext: true, coEditing: true, viewport: VP, iframeTimeout: LT });
        const B = upB.page; ctxB = upB.context; wire(B, 'B');
        await waitInFrame(B, () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''), { timeout: LT }); await sleep(5000);
        check('A + B open + converge', (await cc(A)) > 0);

        // Accumulate many UNSAVED messages: A types, moves cursor, splits a
        // paragraph (Enter), while B types concurrently. No save → the joiner
        // must replay all of it onto the downloaded base checkpoint.
        await atEnd(A, 'one two three four five '); await sleep(2000); await stable(A, CONVERGE);
        await A.bringToFront(); await A.mouse.click(500, 360);
        await A.keyboard.down('Control'); await A.keyboard.press('Home'); await A.keyboard.up('Control'); await sleep(200);
        for (let i = 0; i < 8; i++) await A.keyboard.press('ArrowRight');
        await sleep(200);
        await Promise.all([
            (async () => { await A.keyboard.press('Enter'); await A.keyboard.type('SPLIT', { delay: 40 }); })(),
            atEnd(B, 'Bend '),
        ]);
        await sleep(3500);
        const target = await stable(A, CONVERGE);
        const liveB = await stable(B, CONVERGE);
        check('live A + B converge on the unsaved edits', target > 19 && target === liveB, `A=${target} B=${liveB}`);

        // Fresh joiner C must reconstruct the full unsaved state (replay must
        // land on the switched-in checkpoint doc, not the discarded blank).
        log('--- C late-joins after ~90 unsaved messages ---');
        const upC = await openSecretInBrowser(browser, VIEWER, upA.b64urlSecret, { isolatedContext: true, coEditing: true, viewport: VP, iframeTimeout: LT });
        const C = upC.page; ctxC = upC.context; wire(C, 'C');
        try { await waitInFrame(C, () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''), { timeout: LT }); } catch (e) { log('  C frame-wait failed: ' + e.message.slice(0, 60)); }
        await sleep(6000);
        const r = await convergeTo({ A, C }, target, CONVERGE);
        check('late-joiner C converges to full unsaved state (no edit loss)', r.ok, `target=${target} ${JSON.stringify(r.cs)}`);
        check('no checkpoint-mismatch / abort / OOB', errs.length === 0, errs.slice(0, 3).join(' | '));
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        for (const c of [ctxA, ctxB, ctxC]) { if (c) { try { await c.close(); } catch (e) {} } }
        try { await browser.close(); } catch (e) {}
    }
    log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
