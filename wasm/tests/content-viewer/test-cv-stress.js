// test-cv-stress.js — resilience under join / leave / reconnect churn through
// the content viewer. Participants come and go while the room accumulates
// edits and rotates checkpoints; every live browser converges after each
// step and every (re)joiner gets the accumulated state (never blank/stale).
//
// Legacy subject (viewer, raw cool.html?relay= flow):
//   1. A opens, types ALPHA
//   2. B late-joins, types BETA
//   3. A disconnects (connection loss)
//   4. C late-joins, types GAMMA
//   5. B disconnects
//   6. D late-joins, types DELTA
//   7. A reconnects (fresh page, same room), types EPSILON
//   8. verify the surviving browsers converge
// with auto-save/checkpoint rotations between phases.
//
// CV port: A creates a co-edit room (openBytesViaContentViewer coEdit:true);
// participants join the co-edit LINK (the CV equivalent of the raw relay URL —
// there is no raw cool.html?relay= entry point in the content viewer). Each
// join is an isolated browser context; a disconnect closes the context; a
// reconnect re-navigates the same join link in a fresh context. Saves use the
// tester Save button (rotates /shared-file). After each edit the live set must
// converge; every (re)joiner must land on the accumulated state and log no
// checkpoint mismatch / abort / OOB. Visible-UI only; convergence = equal
// #StateWordCount.
//
// Migrated from wasm/tests/misc/test-stress.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-stress.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const {
    openBytesViaContentViewer, joinViaContentViewer, waitCvInteractive, cvCharCount,
} = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/stress';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const CONVERGE_BUDGET = parseInt(process.env.CONVERGE_BUDGET || '120000', 10);

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
async function typeAtEnd(part, text) {
    await part.page.bringToFront().catch(() => {});
    const box = await (await part.page.$('iframe')).boundingBox();
    await part.page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
    await sleep(400);
    await part.page.keyboard.down('Control');
    await part.page.keyboard.press('End');
    await part.page.keyboard.up('Control');
    await sleep(300);
    await part.page.keyboard.type(text, { delay: 40 });
    await sleep(1500);
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
    log(`--- ${id} joining ---`);
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await joinViaContentViewer(browser, joinLink, { page, userName, iframeTimeout: 90000 });
    const part = wire({ id, page, context, dead: false });
    check(`${id}: joined + editor interactive`, await waitCvInteractive(page, LOAD_BUDGET));
    await sleep(6000);
    return part;
}
async function leavePart(part) {
    log(`--- ${part.id} disconnects ---`);
    part.dead = true;
    try { await part.context.close(); } catch (e) {}
}

(async () => {
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
    log('=== CV stress test: join, leave, reconnect ===');
    log('viewer: ' + BASE);
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    const { browser } = await launch({ headless: 'new' });
    const seen = {};
    try {
        const bytes = fs.readFileSync(FIXTURE);
        const NAME = 'cv-stress-' + Date.now() + '.docx';

        // A creates the room. (A's page lives on the shared default context.)
        const openA = await openBytesViaContentViewer(browser, BASE, NAME, bytes, {
            userName: 'Stress Alice', coEdit: true, iframeTimeout: 60000,
        });
        let A = seen.A = wire({ id: 'A', page: openA.page, context: null, dead: false });
        check('A: editor iframe + join link', !!openA.editorFrame && !!openA.joinLink);
        const joinLink = openA.joinLink;
        check('A: editor interactive', await waitCvInteractive(A.page, LOAD_BUDGET));
        await sleep(6000);
        const initChars = await stableCount(A, CONVERGE_BUDGET);
        check('A opened (char count > 0)', initChars > 0, `init=${initChars}`);

        // Phase 1: A types ALPHA, saves.
        log('=== Phase 1: A types ALPHA ===');
        await typeAtEnd(A, 'ALPHA');
        const afterAlpha = await stableCount(A, CONVERGE_BUDGET);
        check('ALPHA inserted', afterAlpha === initChars + 5, `after=${afterAlpha}`);
        await clickSave(A.page);
        await sleep(6000);
        await snap(A, 'A_after_ALPHA');

        // Phase 2: B late-joins, converges to saved state, types BETA.
        log('=== Phase 2: B late-joins, types BETA ===');
        const B = seen.B = await joinPart(browser, joinLink, 'B', 'Stress Bob');
        {
            const r = await convergeTo([A, B], afterAlpha, CONVERGE_BUDGET);
            check('B got the accumulated (saved) state', r.ok, JSON.stringify(r.counts));
        }
        await typeAtEnd(B, 'BETA');
        {
            const t = await stableCount(B, CONVERGE_BUDGET);
            const r = await convergeTo([A, B], t, CONVERGE_BUDGET);
            check('after BETA A + B converge', r.ok, `target=${t} ${JSON.stringify(r.counts)}`);
        }
        await snap(B, 'B_after_BETA');

        // Phase 3: A disconnects.
        log('=== Phase 3: A disconnects ===');
        await A.page.close().catch(() => {});
        A.dead = true;
        await sleep(5000);
        check('B still running after A disconnect', (await charCount(B)) > 0);

        // Phase 4: C late-joins (no A), converges, types GAMMA.
        log('=== Phase 4: C late-joins, types GAMMA ===');
        const C = seen.C = await joinPart(browser, joinLink, 'C', 'Stress Cara');
        {
            const t = await stableCount(B, CONVERGE_BUDGET);
            const r = await convergeTo([B, C], t, CONVERGE_BUDGET);
            check('C got the accumulated state', r.ok, `target=${t} ${JSON.stringify(r.counts)}`);
        }
        await typeAtEnd(C, 'GAMMA');
        {
            const t = await stableCount(C, CONVERGE_BUDGET);
            const r = await convergeTo([B, C], t, CONVERGE_BUDGET);
            check('after GAMMA B + C converge', r.ok, `target=${t} ${JSON.stringify(r.counts)}`);
        }
        await snap(C, 'C_after_GAMMA');

        // Phase 5: B disconnects.
        log('=== Phase 5: B disconnects ===');
        await leavePart(B);
        await sleep(5000);
        check('C still running after B disconnect', (await charCount(C)) > 0);

        // Phase 6: D late-joins (only C live), converges, types DELTA.
        log('=== Phase 6: D late-joins, types DELTA ===');
        const D = seen.D = await joinPart(browser, joinLink, 'D', 'Stress Dora');
        {
            const t = await stableCount(C, CONVERGE_BUDGET);
            const r = await convergeTo([C, D], t, CONVERGE_BUDGET);
            check('D got the accumulated state', r.ok, `target=${t} ${JSON.stringify(r.counts)}`);
        }
        await typeAtEnd(D, 'DELTA');
        {
            const t = await stableCount(D, CONVERGE_BUDGET);
            const r = await convergeTo([C, D], t, CONVERGE_BUDGET);
            check('after DELTA C + D converge', r.ok, `target=${t} ${JSON.stringify(r.counts)}`);
        }
        // C saves so the reconnecting A gets a rotated checkpoint.
        await clickSave(C.page);
        await sleep(6000);
        await snap(D, 'D_after_DELTA');

        // Phase 7: A RECONNECTS (fresh context, same join link), types EPSILON.
        log('=== Phase 7: A reconnects, types EPSILON ===');
        const A2 = seen.A2 = await joinPart(browser, joinLink, 'A2', 'Stress Alice (reconnect)');
        {
            const t = await stableCount(C, CONVERGE_BUDGET);
            const r = await convergeTo([C, D, A2], t, CONVERGE_BUDGET);
            check('reconnected A got the full accumulated state', r.ok, `target=${t} ${JSON.stringify(r.counts)}`);
        }
        await typeAtEnd(A2, 'EPSILON');
        {
            const t = await stableCount(A2, CONVERGE_BUDGET);
            const r = await convergeTo([C, D, A2], t, CONVERGE_BUDGET);
            check('final convergence across C + D + reconnected A', r.ok, `target=${t} ${JSON.stringify(r.counts)}`);
        }
        await snap(A2, 'A2_after_EPSILON'); await snap(C, 'C_final'); await snap(D, 'D_final');

        // Error-flag gate over every participant that ever existed.
        for (const id of Object.keys(seen)) {
            const p = seen[id];
            check(`${id}: no checkpoint-mismatch / abort / OOB`, p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
        }
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        for (const id of Object.keys(seen)) { const p = seen[id]; if (p && !p.dead && p.context) { try { await p.context.close(); } catch (e) {} } }
        try { await browser.close(); } catch (e) {}
    }
    log('\n' + (allPassed ? 'ALL PASS' : 'SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
