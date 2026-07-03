const __cl = require('../../lib/inject-checklist');
// Co-editing CONCURRENT-edit convergence + mid-stream churn.
//
// The sequential harness (one browser edits, others catch up) is the easy
// case. The hard case — where relay ordering / conflict resolution bugs
// live — is SIMULTANEOUS editing: two (or three) browsers typing at the
// same time without waiting for sync between keystrokes. After the dust
// settles every live browser must show the identical char count (the sum
// of everyone's input), with no checkpoint mismatch / abort.
//
// Rounds:
//   1. A + B type concurrently at the doc end          → converge
//   2. A + B type concurrently again, and C JOINS mid-stream → all converge
//   3. A + C type concurrently while B is still there  → converge
//   4. B LEAVES mid-round while A + C type concurrently → A + C converge
//   5. save (Ctrl+S) → no CHECKPOINT MISMATCH anywhere
//
// Visible-UI only (click + keyboard.type). Convergence = equal
// #StateWordCount across all live browsers.

'use strict';

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { openViaViewer, openSecretInBrowser } = require('../../lib/open-via-viewer');
const { waitInFrame, evalInFrame } = require('../../lib/two-tab');

const VIEWER = env.FILE_STORAGE_URL;
const LOAD_TIMEOUT = env.scaleTimeout(120000);
const CONVERGE_TIMEOUT = env.scaleTimeout(60000);
const VP = { width: 1400, height: 900 };
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

const ERR_RE = /CHECKPOINT MISMATCH|memory access out of bounds|RuntimeError|unreachable|Aborted\(|table index is out of bounds|OOB/i;
function wire(part) {
    part.errors = [];
    part.page.on('console', m => { const t = m.text(); if (ERR_RE.test(t)) part.errors.push(t.slice(0, 200)); });
    part.page.on('pageerror', e => { if (ERR_RE.test(e.message)) part.errors.push('pageerror: ' + e.message.slice(0, 200)); });
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

async function convergeTo(parts, target, timeoutMs) {
    const live = parts.filter(p => p && !p.dead);
    const deadline = Date.now() + timeoutMs;
    let counts = {};
    while (Date.now() < deadline) {
        counts = {}; let all = true;
        for (const p of live) { const c = await charCount(p); counts[p.id] = c; if (c !== target) all = false; }
        if (all) return { ok: true, counts };
        await sleep(500);
    }
    return { ok: false, counts };
}

// Place cursor at doc end (visible-UI) without typing.
async function cursorToEnd(part) {
    await part.page.mouse.click(640, 380); await sleep(250);
    await part.page.keyboard.down('Control'); await part.page.keyboard.press('End'); await part.page.keyboard.up('Control');
    await sleep(250);
}

// Type `text` on a part with a per-key delay (returns a promise so several
// can run concurrently via Promise.all).
function typeAsync(part, text, delay) {
    return part.page.keyboard.type(text, { delay: delay || 40 });
}

async function joinPart(browser, id, secret) {
    log(`--- ${id} joining (co-edit) ---`);
    const up = await openSecretInBrowser(browser, VIEWER, secret, {
        iframeTimeout: LOAD_TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
        isolatedContext: true, coEditing: true, viewport: VP,
    });
    const part = wire({ id, page: up.page, context: up.context, dead: false });
    await waitInFrame(part.page,
        () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''),
        { timeout: LOAD_TIMEOUT });
    await sleep(6000);
    return part;
}

(async () => {
    log('=== Co-editing CONCURRENT-edit convergence + churn ===');
    const { browser } = await launch({ headless: 'new' });
    const parts = {};
    let expected = 0;
    try {
        const bytes = fs.readFileSync(FIXTURE);
        const NAME = 'coedit-concurrent-' + Date.now() + '.docx';

        const upA = await openViaViewer(browser, VIEWER, NAME, bytes, {
            iframeTimeout: LOAD_TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
            isolatedContext: true, coEditing: true, viewport: VP,
        });
        const A = parts.A = wire({ id: 'A', page: upA.page, context: upA.context, dead: false });
        const secret = upA.b64urlSecret;
        await waitInFrame(A.page, () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''), { timeout: LOAD_TIMEOUT });
        await sleep(6000);
        const B = parts.B = await joinPart(browser, 'B', secret);

        // settle baseline
        let r = await convergeTo([A, B], (expected = await charCount(A)), CONVERGE_TIMEOUT);
        check('A+B baseline aligned', r.ok && expected > 0, `base=${expected} ${JSON.stringify(r.counts)}`);

        // ── Round 1: A + B type CONCURRENTLY ──
        log('--- Round 1: A + B concurrent typing ---');
        const a1 = 'aAaAaAaAaA', b1 = 'bBbBbBbBbB'; // 10 each
        await cursorToEnd(A); await cursorToEnd(B);
        await Promise.all([typeAsync(A, a1), typeAsync(B, b1)]);
        await sleep(2000);
        expected += a1.length + b1.length;
        r = await convergeTo([A, B], expected, CONVERGE_TIMEOUT);
        check('Round 1: A+B concurrent edits converge', r.ok, `expect=${expected} ${JSON.stringify(r.counts)}`);

        // ── Round 2: A + B concurrent AND C joins mid-stream ──
        log('--- Round 2: A + B concurrent typing, C joins mid-stream ---');
        const a2 = 'cCcCcCcCcCcCcCcC', b2 = 'dDdDdDdDdDdDdDdD'; // 16 each (longer, so C joins during)
        await cursorToEnd(A); await cursorToEnd(B);
        const typing2 = Promise.all([typeAsync(A, a2, 60), typeAsync(B, b2, 60)]);
        await sleep(500);
        const C = parts.C = await joinPart(browser, 'C', secret); // joins WHILE A+B type
        await typing2;
        await sleep(2000);
        expected += a2.length + b2.length;
        r = await convergeTo([A, B, C], expected, CONVERGE_TIMEOUT);
        check('Round 2: A+B concurrent + C mid-stream join converge', r.ok, `expect=${expected} ${JSON.stringify(r.counts)}`);

        // ── Round 3: A + C type concurrently (three-party doc) ──
        log('--- Round 3: A + C concurrent typing ---');
        const a3 = 'eEeEeEeEeE', c3 = 'fFfFfFfFfF';
        await cursorToEnd(A); await cursorToEnd(C);
        await Promise.all([typeAsync(A, a3), typeAsync(C, c3)]);
        await sleep(2000);
        expected += a3.length + c3.length;
        r = await convergeTo([A, B, C], expected, CONVERGE_TIMEOUT);
        check('Round 3: A+C concurrent edits converge (B idle observer)', r.ok, `expect=${expected} ${JSON.stringify(r.counts)}`);

        // ── Round 4: B LEAVES while A + C type concurrently ──
        log('--- Round 4: A + C concurrent typing while B leaves mid-stream ---');
        const a4 = 'gGgGgGgGgGgGgGgG', c4 = 'hHhHhHhHhHhHhHhH';
        await cursorToEnd(A); await cursorToEnd(C);
        const typing4 = Promise.all([typeAsync(A, a4, 60), typeAsync(C, c4, 60)]);
        await sleep(500);
        log('--- B leaving mid-stream ---'); B.dead = true; try { await B.context.close(); } catch (e) {}
        await typing4;
        await sleep(2000);
        expected += a4.length + c4.length;
        r = await convergeTo([A, C], expected, CONVERGE_TIMEOUT);
        check('Round 4: A+C converge after B leaves mid-stream', r.ok, `expect=${expected} ${JSON.stringify(r.counts)}`);

        // ── Save + checkpoint gate ──
        log('--- A saves (Ctrl+S) ---');
        await A.page.bringToFront().catch(() => {});
        await A.page.keyboard.down('Control'); await A.page.keyboard.press('KeyS'); await A.page.keyboard.up('Control');
        await sleep(6000);
        r = await convergeTo([A, C], expected, CONVERGE_TIMEOUT);
        check('post-save still converged', r.ok, `expect=${expected} ${JSON.stringify(r.counts)}`);

        for (const id of Object.keys(parts)) {
            const p = parts[id];
            check(`${id}: no checkpoint-mismatch / abort / OOB`, p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
        }

    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        for (const id of Object.keys(parts)) { const p = parts[id]; if (p && !p.dead) { try { await p.context.close(); } catch (e) {} } }
        try { await browser.close(); } catch (e) {}
    }

    log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
