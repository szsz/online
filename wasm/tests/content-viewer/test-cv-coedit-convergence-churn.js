// test-cv-coedit-convergence-churn.js — multi-browser co-edit convergence
// + churn through the Tresorit content viewer: A/B/C/D join, type, paste,
// leave, late-join; every LIVE browser converges on the identical char
// count after each step; no checkpoint mismatch / WASM abort anywhere.
//
// Choreography (subject-identical to the legacy test):
//   A creates a co-edit room, B joins  → baseline converges
//   A types                            → converge(A,B)
//   B types                            → converge(A,B)
//   C joins LATE                       → C replays to full state, converge(A,B,C)
//   C types                            → converge(A,B,C)
//   A pastes                           → converge(A,B,C)
//   B LEAVES (context close)           → converge(A,C) across further edits
//   D joins VERY LATE                  → D replays full accumulated state
//   D types                            → converge(A,C,D)
//   A clicks the tester Save button (rotates the relay checkpoint via
//   /shared-file)                      → no CHECKPOINT MISMATCH; still converged
//
// Every edit is real visible-UI input (keyboard/mouse); state is read only
// from the visible status bar (#StateWordCount).
//
// Migrated from wasm/tests/coedit/test-coedit-convergence-churn.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-coedit-convergence-churn.js [base-url]

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
const SHOT_DIR = '/tmp/content-viewer-report/coedit-convergence-churn';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const CONVERGE_BUDGET = parseInt(process.env.CONVERGE_BUDGET || '90000', 10);

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

// ── Participant bookkeeping ─────────────────────────────────────────
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
    return cvCharCount(part.page);
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
    const target = await stableCount(editor, CONVERGE_BUDGET);
    const live = allParts.filter(p => p && !p.dead);
    const others = live.filter(p => p !== editor);
    const res = await convergeTo(others, target, CONVERGE_BUDGET);
    const summary = live.map(p => `${p.id}=${res.counts[p.id] ?? target}`).join(' ');
    check(`converge after ${label} (target ${target})`, target > 0 && res.ok, summary);
    return target;
}

async function typeAtEnd(part, text) {
    await part.page.bringToFront().catch(() => {});
    // place cursor in the doc body then jump to end (visible-UI only)
    const box = await (await part.page.$('iframe')).boundingBox();
    await part.page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
    await sleep(400);
    await part.page.keyboard.down('Control');
    await part.page.keyboard.press('End');
    await part.page.keyboard.up('Control');
    await sleep(300);
    await part.page.keyboard.type(text, { delay: 25 });
    await sleep(1500);
}

// Tester Save button — in a CV co-edit room this rotates the relay
// checkpoint (server-side /shared-file gets the saved bytes).
async function clickSave(page) {
    const h = await page.evaluateHandle(() =>
        [...document.querySelectorAll('button')].find(b => /^save$/i.test((b.textContent || '').trim())));
    const el = h.asElement();
    if (!el) return false;
    await el.click();
    return true;
}

async function joinParticipant(browser, joinLink, id, userName) {
    log(`--- ${id} joining (co-edit link) ---`);
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await joinViaContentViewer(browser, joinLink, { page, userName, iframeTimeout: 90000 });
    const part = wire({ id, page, context, dead: false });
    check(`${id}: joined + editor interactive`, await waitCvInteractive(page, LOAD_BUDGET));
    await sleep(6000); // settle initial relay handshake
    return part;
}

async function leaveParticipant(part) {
    log(`--- ${part.id} leaving (closing context) ---`);
    part.dead = true;
    try { await part.context.close(); } catch (e) {}
}

(async () => {
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
    log('=== CV co-editing convergence + churn harness ===');
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    const parts = {};
    try {
        const bytes = fs.readFileSync(FIXTURE);
        const NAME = 'cv-coedit-converge-' + Date.now() + '.docx';

        // A creates the co-edit room; B joins the link in an isolated context
        log('--- A opening (co-edit) + B joining ---');
        const pair = await openCoEditPair(browser, BASE, NAME, bytes, {
            userA: 'Alice Churn', userB: 'Bob Churn',
        });
        const A = parts.A = wire({ id: 'A', page: pair.A.page, context: null, dead: false });
        const B = parts.B = wire({ id: 'B', page: pair.B.page, context: pair.contextB, dead: false });
        await sleep(6000);
        const base = await stableCount(A, CONVERGE_BUDGET);
        check('A loaded doc (char count > 0)', base > 0, `base=${base}`);
        {
            const r = await convergeTo([A, B], base, CONVERGE_BUDGET);
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
        const C = parts.C = await joinParticipant(browser, pair.joinLink, 'C', 'Cara Churn');
        {
            const target = await stableCount(A, CONVERGE_BUDGET);
            const r = await convergeTo([A, B, C], target, CONVERGE_BUDGET);
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
                permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
            });
        } catch (e) {}
        {
            const box = await (await A.page.$('iframe')).boundingBox();
            await A.page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
        }
        await sleep(300);
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
        const D = parts.D = await joinParticipant(browser, pair.joinLink, 'D', 'Dora Churn');
        {
            const target = await stableCount(A, CONVERGE_BUDGET);
            const r = await convergeTo([A, C, D], target, CONVERGE_BUDGET);
            check('D very-late-joins and replays full accumulated state', r.ok,
                `target=${target} ${JSON.stringify(r.counts)}`);
        }
        await snap(D, 'D_joined');

        // D types — everyone still converges
        log('--- D types ---');
        await typeAtEnd(D, 'EtaSix_');
        await convergeAfterEdit(D, [A, C, D], 'D typing');

        // Save (tester Save button → checkpoint rotate); no mismatch anywhere
        log('--- A saves (tester Save button → checkpoint rotate) ---');
        check('A: tester Save button clicked', await clickSave(A.page));
        await sleep(6000);
        const finalTarget = await stableCount(A, CONVERGE_BUDGET);
        const finalRes = await convergeTo([A, C, D], finalTarget, CONVERGE_BUDGET);
        check('all live browsers converged after save', finalRes.ok,
            `target=${finalTarget} ${JSON.stringify(finalRes.counts)}`);

        // Error-flag gate across every participant that ever existed
        for (const id of Object.keys(parts)) {
            const p = parts[id];
            check(`${id}: no checkpoint-mismatch / abort / OOB`, p.errors.length === 0,
                p.errors.slice(0, 3).join(' | '));
        }
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
