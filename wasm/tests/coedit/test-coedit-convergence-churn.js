const __cl = require('../../lib/inject-checklist');
// Co-editing CONVERGENCE + CHURN harness.
//
// Goal: with multiple browsers co-editing the SAME document, and with
// participants COMING AND GOING (late-join, leave, very-late-join), every
// LIVE browser must converge to the identical document state after each
// edit, and no browser may report a checkpoint mismatch or a WASM abort.
//
// Every edit is driven through REAL visible UI (keyboard/mouse); state is
// read only from the visible status bar (#StateWordCount) — no
// sendUnoCommand / dispatcher / internal-state pokes.
//
// Choreography:
//   A opens (co-edit)         → baseline
//   B joins                   → converge(A,B)
//   A types                   → converge(A,B)
//   B types                   → converge(A,B)
//   C joins LATE              → C must replay to the full state  converge(A,B,C)
//   C types                   → converge(A,B,C)
//   A pastes                  → converge(A,B,C)
//   B LEAVES (context close)  → converge(A,C)
//   A types, C types          → converge(A,C)
//   D joins VERY LATE         → D must replay full accumulated state converge(A,C,D)
//   A Ctrl+S (checkpoint)     → no CHECKPOINT MISMATCH anywhere; still converged
//
// A convergence FAILURE (live browsers show different char counts after
// the settle window) or any abort/mismatch flag is a real co-editing bug.

'use strict';

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { openViaViewer, openSecretInBrowser } = require('../../lib/open-via-viewer');
const { waitInFrame, evalInFrame } = require('../../lib/two-tab');

const VIEWER = env.FILE_STORAGE_URL;
const TIMEOUT = env.scaleTimeout(300000);
const LOAD_TIMEOUT = env.scaleTimeout(120000);
const CONVERGE_TIMEOUT = env.scaleTimeout(45000);
const SHOT_DIR = '/tmp/static-deploy/public/shots-coedit-convergence-churn';
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
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

// ── Participant bookkeeping ─────────────────────────────────────────
// Each participant wraps a page + isolated context + a console error sink.
const ERR_RE = /CHECKPOINT MISMATCH|memory access out of bounds|RuntimeError|unreachable|Aborted\(|table index is out of bounds|__wasm_apply|OOB/i;

function wire(part) {
    part.errors = [];
    part.page.on('console', m => {
        const t = m.text();
        if (ERR_RE.test(t)) part.errors.push(t.slice(0, 200));
    });
    part.page.on('pageerror', e => {
        if (ERR_RE.test(e.message)) part.errors.push('pageerror: ' + e.message.slice(0, 200));
    });
    return part;
}

async function charCount(part) {
    if (!part || part.dead) return -2;
    return evalInFrame(part.page, () => {
        const t = document.querySelector('#StateWordCount')?.textContent || '';
        const m = t.match(/([\d,]+)\s*character/);
        return m ? parseInt(m[1].replace(/,/g, '')) : -1;
    }).catch(() => -1);
}

// Wait until `part`'s own char count is stable (2 equal reads 1s apart)
// and > 0. That value becomes the convergence target.
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

// Poll every live participant until all report `target`, within timeout.
async function convergeTo(parts, target, timeoutMs) {
    const live = parts.filter(p => p && !p.dead);
    const deadline = Date.now() + timeoutMs;
    let counts = {};
    while (Date.now() < deadline) {
        counts = {};
        let all = true;
        for (const p of live) {
            const c = await charCount(p);
            counts[p.id] = c;
            if (c !== target) all = false;
        }
        if (all) return { ok: true, counts };
        await sleep(500);
    }
    return { ok: false, counts };
}

// After an edit made by `editor`, establish the target from the editor's
// own settled count, then require every other live participant to reach it.
async function convergeAfterEdit(editor, allParts, label) {
    const target = await stableCount(editor, CONVERGE_TIMEOUT);
    const live = allParts.filter(p => p && !p.dead);
    const others = live.filter(p => p !== editor);
    const res = await convergeTo(others, target, CONVERGE_TIMEOUT);
    const summary = live.map(p => `${p.id}=${p.__last = (res.counts[p.id] ?? target)}`).join(' ');
    check(`converge after ${label} (target ${target})`,
        target > 0 && res.ok, summary);
    return target;
}

async function typeAtEnd(part, text) {
    await part.page.bringToFront().catch(() => {});
    // place cursor in the body then jump to end (visible-UI only)
    await part.page.mouse.click(640, 400);
    await sleep(400);
    await part.page.keyboard.down('Control');
    await part.page.keyboard.press('End');
    await part.page.keyboard.up('Control');
    await sleep(300);
    await part.page.keyboard.type(text, { delay: 25 });
    await sleep(1500);
}

async function joinParticipant(browser, id, secret) {
    log(`--- ${id} joining (co-edit) ---`);
    const up = await openSecretInBrowser(browser, VIEWER, secret, {
        iframeTimeout: LOAD_TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
        isolatedContext: true, coEditing: true,
    });
    const part = wire({ id, page: up.page, context: up.context, dead: false });
    await waitInFrame(part.page,
        () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''),
        { timeout: LOAD_TIMEOUT });
    await sleep(6000); // settle initial relay handshake
    return part;
}

async function leaveParticipant(part) {
    log(`--- ${part.id} leaving (closing context) ---`);
    part.dead = true;
    try { await part.context.close(); } catch (e) {}
}

(async () => {
    log('=== Co-editing convergence + churn harness ===');
    const { browser } = await launch({ headless: 'new' });
    const parts = {};
    try {
        const bytes = fs.readFileSync(FIXTURE);
        const NAME = 'coedit-converge-' + Date.now() + '.docx';

        // A — first participant (uploads + opens)
        log('--- A opening (co-edit) ---');
        const upA = await openViaViewer(browser, VIEWER, NAME, bytes, {
            iframeTimeout: LOAD_TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
            isolatedContext: true, coEditing: true,
        });
        const A = parts.A = wire({ id: 'A', page: upA.page, context: upA.context, dead: false });
        const secret = upA.b64urlSecret;
        await waitInFrame(A.page,
            () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''),
            { timeout: LOAD_TIMEOUT });
        await sleep(6000);
        const base = await stableCount(A, CONVERGE_TIMEOUT);
        check('A loaded doc (char count > 0)', base > 0, `base=${base}`);

        // B joins
        const B = parts.B = await joinParticipant(browser, 'B', secret);
        {
            const r = await convergeTo([A, B], base, CONVERGE_TIMEOUT);
            check('B joins and matches A baseline', r.ok, JSON.stringify(r.counts));
        }

        // A types
        log('--- A types ---');
        await typeAtEnd(A, 'AlphaOne_');
        await convergeAfterEdit(A, [A, B], 'A typing');
        await snap(A, 'A_typed'); await snap(B, 'A_typed');

        // B types
        log('--- B types ---');
        await typeAtEnd(B, 'BetaTwo_');
        await convergeAfterEdit(B, [A, B], 'B typing');

        // C joins LATE — must replay to full accumulated state
        const C = parts.C = await joinParticipant(browser, 'C', secret);
        {
            const target = await stableCount(A, CONVERGE_TIMEOUT);
            const r = await convergeTo([A, B, C], target, CONVERGE_TIMEOUT);
            check('C late-joins and replays to full state', r.ok,
                `target=${target} ${JSON.stringify(r.counts)}`);
        }
        await snap(C, 'C_joined');

        // C types
        log('--- C types ---');
        await typeAtEnd(C, 'GammaThree_');
        await convergeAfterEdit(C, [A, B, C], 'C typing');

        // A pastes external text
        log('--- A pastes external text ---');
        try {
            const cdp = await A.page.createCDPSession();
            await cdp.send('Browser.grantPermissions', {
                origin: new URL(VIEWER).origin,
                permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
            });
        } catch (e) {}
        await A.page.mouse.click(640, 400); await sleep(300);
        await A.page.evaluate(async () => {
            await navigator.clipboard.write([new ClipboardItem({
                'text/plain': new Blob(['PastedDelta_'], { type: 'text/plain' }),
            })]);
        }).catch(() => {});
        await sleep(400);
        await A.page.keyboard.down('Control'); await A.page.keyboard.press('End'); await A.page.keyboard.up('Control');
        await sleep(300);
        await A.page.keyboard.down('Control'); await A.page.keyboard.press('KeyV'); await A.page.keyboard.up('Control');
        await sleep(2000);
        await convergeAfterEdit(A, [A, B, C], 'A paste');

        // B LEAVES
        await leaveParticipant(B);
        await sleep(3000);

        // A and C keep editing while B is gone
        log('--- A types (B gone) ---');
        await typeAtEnd(A, 'EpsilonFour_');
        await convergeAfterEdit(A, [A, C], 'A typing after B left');
        log('--- C types (B gone) ---');
        await typeAtEnd(C, 'ZetaFive_');
        await convergeAfterEdit(C, [A, C], 'C typing after B left');

        // D joins VERY LATE — must replay everything incl. edits after B left
        const D = parts.D = await joinParticipant(browser, 'D', secret);
        {
            const target = await stableCount(A, CONVERGE_TIMEOUT);
            const r = await convergeTo([A, C, D], target, CONVERGE_TIMEOUT);
            check('D very-late-joins and replays full accumulated state', r.ok,
                `target=${target} ${JSON.stringify(r.counts)}`);
        }
        await snap(D, 'D_joined');

        // D types — everyone still converges
        log('--- D types ---');
        await typeAtEnd(D, 'EtaSix_');
        await convergeAfterEdit(D, [A, C, D], 'D typing');

        // Save (Ctrl+S) → rotates checkpoint; assert no mismatch anywhere
        log('--- A saves (Ctrl+S checkpoint) ---');
        await A.page.keyboard.down('Control'); await A.page.keyboard.press('KeyS'); await A.page.keyboard.up('Control');
        await sleep(6000);
        const finalTarget = await stableCount(A, CONVERGE_TIMEOUT);
        const finalRes = await convergeTo([A, C, D], finalTarget, CONVERGE_TIMEOUT);
        check('all live browsers converged after save', finalRes.ok,
            `target=${finalTarget} ${JSON.stringify(finalRes.counts)}`);

        // Error-flag gate across every participant that ever existed
        for (const id of Object.keys(parts)) {
            const p = parts[id];
            check(`${id}: no checkpoint-mismatch / abort / OOB`, p.errors.length === 0,
                p.errors.slice(0, 3).join(' | '));
        }

    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || e && e.message || String(e)).slice(0, 300));
    } finally {
        for (const id of Object.keys(parts)) {
            const p = parts[id];
            if (p && !p.dead) { try { await p.context.close(); } catch (e) {} }
        }
        try { await browser.close(); } catch (e) {}
    }

    log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
