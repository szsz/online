// test-cv-regression-first-client-overwrite.js — the FIRST client's
// activation checkpoint must not save stale/blank content over a newer relay
// state. A second client joining must still see the real document content.
//
// Legacy subject (viewer): the viewer prewarms with a blank doc then
// hot-switches to the real doc; the relay-adapter activates and immediately
// calls saveAndUploadCheckpoint(). If Kit hadn't finished loading the real
// doc, the activation checkpoint captured the BLANK doc, so a later joiner
// received blank content. The legacy test also probed /api/v2/file byte
// sizes for corruption — that endpoint is a legacy-viewer-only surface and
// is NOT ported; the behavioural guard (a joiner converges to the real
// content, never blank) is what survives.
//
// CV port: A creates a co-edit room (the "first client" — its activation
// seeds the room checkpoint via /shared-file). B late-joins and must
// converge to the real document's char count, never a blank/stale
// activation snapshot. A then saves and leaves; a fresh C late-joins with no
// peers and must still see the content (the first activation must not have
// poisoned the checkpoint). All input is real visible-UI; state is read only
// from #StateWordCount.
//
// Migrated from wasm/tests/regression/test-regression-first-client-overwrite.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-first-client-overwrite.js [base-url]

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
const SHOT_DIR = '/tmp/content-viewer-report/regression-first-client-overwrite';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const CONVERGE_BUDGET = parseInt(process.env.CONVERGE_BUDGET || '90000', 10);
// The fixture (new.docx) carries a known ~19 chars of body text.
const EXPECTED_CHARS = parseInt(process.env.EXPECTED_CHARS || '19', 10);

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

(async () => {
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
    log('=== CV regression: first-client activation must not overwrite blank ===');
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    const parts = {};
    try {
        const bytes = fs.readFileSync(FIXTURE);
        const NAME = 'cv-fc-overwrite-' + Date.now() + '.docx';

        // A is the FIRST client — its activation seeds the room checkpoint.
        // B joins in an isolated context.
        const pair = await openCoEditPair(browser, BASE, NAME, bytes, {
            userA: 'First Alice', userB: 'Second Bob',
        });
        const A = parts.A = { id: 'A', page: pair.A.page, context: null, dead: false };
        const B = parts.B = { id: 'B', page: pair.B.page, context: pair.contextB, dead: false };
        await sleep(8000); // let A's activation checkpoint complete

        // A sees the real document content (not blank prewarm).
        const aChars = await stableCount(A, CONVERGE_BUDGET);
        await snap(A, 'A_loaded');
        check('A sees real content (~' + EXPECTED_CHARS + ' chars)',
            Math.abs(aChars - EXPECTED_CHARS) <= 5, 'A=' + aChars);
        check('A is NOT blank', aChars > 10, 'A=' + aChars);

        // KEY CHECK: B (joined against A's activation checkpoint) must see the
        // real content, never a blank/stale first-client activation snapshot.
        const bChars = await stableCount(B, CONVERGE_BUDGET);
        await snap(B, 'B_loaded');
        check('B sees real content (within ±5 of A)', Math.abs(bChars - aChars) <= 5,
            'B=' + bChars + ' A=' + aChars);
        check('B is NOT blank', bChars > 10, 'B=' + bChars);

        // A saves + leaves; the checkpoint the first client wrote must not
        // have been poisoned — a fresh joiner with no peers still sees it.
        log('--- A saves (tester Save → checkpoint rotate) then leaves ---');
        check('A: tester Save button clicked', await clickSave(A.page));
        await sleep(6000);
        A.dead = true;
        try { await A.page.close(); } catch (e) {}
        B.dead = true;
        try { await B.context.close(); } catch (e) {}
        await sleep(4000);

        const C = parts.C = await joinParticipant(browser, pair.joinLink, 'C', 'Third Cara');
        const cChars = await stableCount(C, CONVERGE_BUDGET);
        await snap(C, 'C_loaded');
        check('C (no peers) still sees real content (within ±5 of A)',
            Math.abs(cChars - aChars) <= 5, 'C=' + cChars + ' A=' + aChars);
        check('C is NOT blank', cChars > 10, 'C=' + cChars);
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
