// test-cv-regression-latejoin-overwrite.js — a late joiner must NOT overwrite
// the room with blank/stale content: after each client joins + saves + leaves,
// the next joiner must still see the accumulated content (never blank).
//
// Legacy subject (viewer): A opens/types/Ctrl+S/closes; B opens same doc and
// must see A's saved content (not a blank prewarm-activation checkpoint); B
// types/saves/closes; C opens and must see A+B content. The bug was a
// premature activation saveAndUploadCheckpoint() overwriting stored bytes
// with blank prewarm content.
//
// CV port: the overwrite-safety is observed as convergence. A creates a
// co-edit room and types; B late-joins and must converge to A's char count
// (a blank/stale overwrite would leave B below A). A saves (tester Save
// button → /shared-file checkpoint rotation) and LEAVES; B types more and
// saves + leaves; a fresh C late-joins and must land on the full accumulated
// state — never blank, never below the last saved baseline. All input is
// real visible-UI (keyboard/mouse/Save button); state is read only from the
// visible #StateWordCount.
//
// Migrated from wasm/tests/regression/test-regression-latejoin-overwrite.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-latejoin-overwrite.js [base-url]

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
const SHOT_DIR = '/tmp/content-viewer-report/regression-latejoin-overwrite';
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
// Tester Save button — in a CV co-edit room this rotates the relay
// checkpoint (server-side /shared-file gets the saved bytes so later
// joiners stage the SAVED doc).
async function clickSave(page) {
    const h = await page.evaluateHandle(() =>
        [...document.querySelectorAll('button')].find(b => /^save$/i.test((b.textContent || '').trim())));
    const el = h.asElement();
    if (!el) return false;
    await el.click();
    return true;
}
async function joinParticipant(browser, joinLink, id, userName) {
    log(`--- ${id} late-joining (co-edit link) ---`);
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await joinViaContentViewer(browser, joinLink, { page, userName, iframeTimeout: 90000 });
    const part = { id, page, context, dead: false };
    check(`${id}: joined + editor interactive`, await waitCvInteractive(page, LOAD_BUDGET));
    await sleep(6000);
    return part;
}
async function leaveParticipant(part) {
    log(`--- ${part.id} leaving (closing context) ---`);
    part.dead = true;
    try { await part.context.close(); } catch (e) {}
}

(async () => {
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
    log('=== CV regression: late-join must NOT overwrite with blank/stale ===');
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    const parts = {};
    try {
        const bytes = fs.readFileSync(FIXTURE);
        const NAME = 'cv-ljover-' + Date.now() + '.docx';

        // A creates the co-edit room; B joins in an isolated context.
        const pair = await openCoEditPair(browser, BASE, NAME, bytes, {
            userA: 'Overwrite Alice', userB: 'Overwrite Bob',
        });
        const A = parts.A = { id: 'A', page: pair.A.page, context: null, dead: false };
        const B = parts.B = { id: 'B', page: pair.B.page, context: pair.contextB, dead: false };
        await sleep(6000);
        const base = await stableCount(A, CONVERGE_BUDGET);
        check('A loaded doc (char count > 0)', base > 0, `base=${base}`);

        // A types content that must survive every join/save/leave cycle.
        log('--- A types CONTENT_FROM_A ---');
        await typeAtEnd(A, 'CONTENT_FROM_A ');
        const afterA = await stableCount(A, CONVERGE_BUDGET);
        check('A typed content', afterA > base, `afterA=${afterA}`);

        // KEY CHECK 1: B (already joined) converges to A — no blank overwrite.
        {
            const r = await convergeTo([A, B], afterA, CONVERGE_BUDGET);
            check('B sees A content (not blank / not stale)', r.ok, JSON.stringify(r.counts));
        }
        check('B is NOT blank (well above base)', (await charCount(B)) > base + 5,
            'B=' + (await charCount(B)) + ' base=' + base);
        await snap(A, 'A_typed'); await snap(B, 'B_sees_A');

        // A saves (rotates the /shared-file checkpoint), then LEAVES.
        log('--- A saves (tester Save → checkpoint rotate) then leaves ---');
        check('A: tester Save button clicked', await clickSave(A.page));
        await sleep(6000);
        A.dead = true; // A's page belongs to the shared default context; drop it logically
        try { await A.page.close(); } catch (e) {}
        await sleep(3000);

        // B types more, then saves + leaves. B is now the surviving baseline.
        log('--- B types ADDED_BY_B then saves ---');
        await typeAtEnd(B, 'ADDED_BY_B ');
        const afterB = await stableCount(B, CONVERGE_BUDGET);
        check('B typed more on top of A content', afterB > afterA, `afterB=${afterB}`);
        check('B: tester Save button clicked', await clickSave(B.page));
        await sleep(6000);
        await snap(B, 'B_saved');
        const savedBaseline = afterB;
        await leaveParticipant(B);
        await sleep(3000);

        // KEY CHECK 2: a fresh C late-joins with NO peers connected — it must
        // reconstruct the full A+B saved baseline, never a blank/stale doc.
        const C = parts.C = await joinParticipant(browser, pair.joinLink, 'C', 'Overwrite Cara');
        const cConverged = await stableCount(C, CONVERGE_BUDGET);
        check('C sees A+B content (converged to saved baseline)',
            Math.abs(cConverged - savedBaseline) <= 5,
            'C=' + cConverged + ' saved=' + savedBaseline);
        check('C is NOT blank (above initial base)', cConverged > base,
            'C=' + cConverged + ' base=' + base);
        await snap(C, 'C_joined');
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
