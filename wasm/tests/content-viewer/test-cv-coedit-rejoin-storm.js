// test-cv-coedit-rejoin-storm.js — the harshest "browsers coming and going"
// case. A stays and edits continuously while a second participant repeatedly
// LEAVES and REJOINS the live session across several rounds, each rejoin
// hitting the late-join replay path against an ever-growing message log and
// rotated checkpoints. After every rejoin the newcomer must converge to A's
// current char count; nobody may log a checkpoint mismatch / abort / OOB. A
// final fresh participant then joins and must replay the full accumulated
// state.
//
// CV port: A creates a co-edit room; each round a fresh Jn joins the co-edit
// link in an isolated context, converges, both edit, A saves (tester Save
// button → /shared-file checkpoint rotation), Jn leaves, A keeps editing
// solo. A final F joins and must replay everything. Visible-UI only;
// convergence = equal #StateWordCount.
//
// Migrated from wasm/tests/coedit/test-coedit-rejoin-storm.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-coedit-rejoin-storm.js [base-url]

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
const SHOT_DIR = '/tmp/content-viewer-report/coedit-rejoin-storm';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const CONVERGE_BUDGET = parseInt(process.env.CONVERGE_BUDGET || '120000', 10);
const ROUNDS = parseInt(process.env.ROUNDS || '4', 10);

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
    await sleep(300);
    await part.page.keyboard.down('Control');
    await part.page.keyboard.press('End');
    await part.page.keyboard.up('Control');
    await sleep(200);
    await part.page.keyboard.type(text, { delay: 30 });
    await sleep(1200);
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
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await joinViaContentViewer(browser, joinLink, { page, userName, iframeTimeout: 90000 });
    const part = wire({ id, page, context, dead: false });
    check(`${id}: joined + editor interactive`, await waitCvInteractive(page, LOAD_BUDGET));
    await sleep(5000);
    return part;
}

(async () => {
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
    log('=== CV co-editing REJOIN STORM ===');
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    const seen = {};
    try {
        const bytes = fs.readFileSync(FIXTURE);
        const NAME = 'cv-coedit-rejoin-' + Date.now() + '.docx';

        // A creates the co-edit room and stays for the whole storm.
        const openA = await openBytesViaContentViewer(browser, BASE, NAME, bytes, {
            userName: 'Storm Alice', coEdit: true, iframeTimeout: 60000,
        });
        const A = seen.A = wire({ id: 'A', page: openA.page, context: null, dead: false });
        check('A: editor iframe + join link', !!openA.editorFrame && !!openA.joinLink);
        const joinLink = openA.joinLink;
        check('A: editor interactive', await waitCvInteractive(A.page, LOAD_BUDGET));
        await sleep(6000);
        check('A opened (char count > 0)', (await charCount(A)) > 0);

        for (let round = 1; round <= ROUNDS; round++) {
            // A types before the join.
            await typeAtEnd(A, `r${round}Aaaa`);
            // A fresh participant joins.
            log(`--- round ${round}: joiner J${round} joins ---`);
            const J = seen['J' + round] = await joinPart(browser, joinLink, 'J' + round, 'Joiner ' + round);
            let target = await stableCount(A, CONVERGE_BUDGET);
            let r = await convergeTo([A, J], target, CONVERGE_BUDGET);
            check(`round ${round}: joiner converges on join`, r.ok, `target=${target} ${JSON.stringify(r.counts)}`);

            // Both edit while connected.
            await typeAtEnd(J, `r${round}Jjjj`);
            target = await stableCount(J, CONVERGE_BUDGET);
            r = await convergeTo([A, J], target, CONVERGE_BUDGET);
            check(`round ${round}: joiner's edit converges to A`, r.ok, `target=${target} ${JSON.stringify(r.counts)}`);

            // A saves (rotates checkpoint via /shared-file) then the joiner LEAVES.
            await clickSave(A.page);
            await sleep(4000);
            log(`--- round ${round}: joiner J${round} leaves ---`);
            J.dead = true;
            try { await J.context.close(); } catch (e) {}
            await sleep(2500);
            // A keeps editing solo while nobody else is connected.
            await typeAtEnd(A, `r${round}Solo`);
        }

        // Final fresh participant must replay the whole storm's accumulated state.
        log('--- final joiner F ---');
        const F = seen.F = await joinPart(browser, joinLink, 'F', 'Final Fran');
        const target = await stableCount(A, CONVERGE_BUDGET);
        const r = await convergeTo([A, F], target, CONVERGE_BUDGET);
        check('final fresh joiner replays full accumulated state', r.ok, `target=${target} ${JSON.stringify(r.counts)}`);

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
