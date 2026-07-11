// test-cv-coedit-concurrent.js — SIMULTANEOUS co-editing through the
// Tresorit content viewer. The sequential case (one edits, others catch up)
// is easy; the hard case — where relay ordering / conflict-resolution bugs
// live — is two (or three) browsers typing at the SAME time without waiting
// for sync between keystrokes. After the dust settles every live browser
// must show the identical char count (the sum of everyone's input), with no
// checkpoint mismatch / abort.
//
// Rounds (subject-identical to the legacy test):
//   1. A + B type concurrently at the doc end               → converge
//   2. A + B type concurrently again, and C JOINS mid-stream → all converge
//   3. A + C type concurrently while B observes             → converge
//   4. B LEAVES mid-round while A + C type concurrently     → A + C converge
//   5. A clicks the tester Save button (rotates the relay checkpoint)
//      → no CHECKPOINT MISMATCH anywhere, still converged
//
// Visible-UI only (click + keyboard.type). Convergence = equal
// #StateWordCount across all live browsers.
//
// Migrated from wasm/tests/coedit/test-coedit-concurrent.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-coedit-concurrent.js [base-url]

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
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const CONVERGE_BUDGET = parseInt(process.env.CONVERGE_BUDGET || '90000', 10);
const VP = { width: 1920, height: 1080 };

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
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
    return cvCharCount(part.page);
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
    const box = await (await part.page.$('iframe')).boundingBox();
    await part.page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 380));
    await sleep(250);
    await part.page.keyboard.down('Control'); await part.page.keyboard.press('End'); await part.page.keyboard.up('Control');
    await sleep(250);
}

// Type `text` on a part with a per-key delay (returns a promise so several
// can run concurrently via Promise.all).
function typeAsync(part, text, delay) {
    return part.page.keyboard.type(text, { delay: delay || 40 });
}

async function clickSave(page) {
    const h = await page.evaluateHandle(() =>
        [...document.querySelectorAll('button')].find(b => /^save$/i.test((b.textContent || '').trim())));
    const el = h.asElement();
    if (!el) return false;
    await el.click();
    return true;
}

async function joinPart(browser, joinLink, id, userName) {
    log(`--- ${id} joining (co-edit link) ---`);
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await joinViaContentViewer(browser, joinLink, { page, userName, viewport: VP, iframeTimeout: 90000 });
    const part = wire({ id, page, context, dead: false });
    check(`${id}: joined + editor interactive`, await waitCvInteractive(page, LOAD_BUDGET));
    await sleep(6000);
    return part;
}

(async () => {
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
    log('=== CV co-editing CONCURRENT-edit convergence + churn ===');
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    const parts = {};
    let expected = 0;
    try {
        const bytes = fs.readFileSync(FIXTURE);
        const NAME = 'cv-coedit-concurrent-' + Date.now() + '.docx';

        const pair = await openCoEditPair(browser, BASE, NAME, bytes, {
            userA: 'Alice Concurrent', userB: 'Bob Concurrent', viewport: VP,
        });
        const A = parts.A = wire({ id: 'A', page: pair.A.page, context: null, dead: false });
        const B = parts.B = wire({ id: 'B', page: pair.B.page, context: pair.contextB, dead: false });
        await sleep(6000);

        // settle baseline
        let r = await convergeTo([A, B], (expected = await charCount(A)), CONVERGE_BUDGET);
        check('A+B baseline aligned', r.ok && expected > 0, `base=${expected} ${JSON.stringify(r.counts)}`);

        // ── Round 1: A + B type CONCURRENTLY ──
        log('--- Round 1: A + B concurrent typing ---');
        const a1 = 'aAaAaAaAaA', b1 = 'bBbBbBbBbB'; // 10 each
        await cursorToEnd(A); await cursorToEnd(B);
        await Promise.all([typeAsync(A, a1), typeAsync(B, b1)]);
        await sleep(2000);
        expected += a1.length + b1.length;
        r = await convergeTo([A, B], expected, CONVERGE_BUDGET);
        check('Round 1: A+B concurrent edits converge', r.ok, `expect=${expected} ${JSON.stringify(r.counts)}`);

        // ── Round 2: A + B concurrent AND C joins mid-stream ──
        log('--- Round 2: A + B concurrent typing, C joins mid-stream ---');
        const a2 = 'cCcCcCcCcCcCcCcC', b2 = 'dDdDdDdDdDdDdDdD'; // 16 each (longer, so C joins during)
        await cursorToEnd(A); await cursorToEnd(B);
        const typing2 = Promise.all([typeAsync(A, a2, 60), typeAsync(B, b2, 60)]);
        await sleep(500);
        const C = parts.C = await joinPart(browser, pair.joinLink, 'C', 'Cara Concurrent'); // joins WHILE A+B type
        await typing2;
        await sleep(2000);
        expected += a2.length + b2.length;
        r = await convergeTo([A, B, C], expected, CONVERGE_BUDGET);
        check('Round 2: A+B concurrent + C mid-stream join converge', r.ok, `expect=${expected} ${JSON.stringify(r.counts)}`);

        // ── Round 3: A + C type concurrently (three-party doc) ──
        log('--- Round 3: A + C concurrent typing ---');
        const a3 = 'eEeEeEeEeE', c3 = 'fFfFfFfFfF';
        await cursorToEnd(A); await cursorToEnd(C);
        await Promise.all([typeAsync(A, a3), typeAsync(C, c3)]);
        await sleep(2000);
        expected += a3.length + c3.length;
        r = await convergeTo([A, B, C], expected, CONVERGE_BUDGET);
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
        r = await convergeTo([A, C], expected, CONVERGE_BUDGET);
        check('Round 4: A+C converge after B leaves mid-stream', r.ok, `expect=${expected} ${JSON.stringify(r.counts)}`);

        // ── Save + checkpoint gate (tester Save button → checkpoint rotate) ──
        log('--- A saves (tester Save button) ---');
        await A.page.bringToFront().catch(() => {});
        check('A: tester Save button clicked', await clickSave(A.page));
        await sleep(6000);
        r = await convergeTo([A, C], expected, CONVERGE_BUDGET);
        check('post-save still converged', r.ok, `expect=${expected} ${JSON.stringify(r.counts)}`);

        for (const id of Object.keys(parts)) {
            const p = parts[id];
            check(`${id}: no checkpoint-mismatch / abort / OOB`, p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
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
