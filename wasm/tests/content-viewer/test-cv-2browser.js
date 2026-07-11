// test-cv-2browser.js — two browsers co-edit one doc through the content
// viewer: per-keystroke convergence in both directions.
//
// A creates a co-edit session via /collabora-tester, B joins the link in an
// isolated context. A types "ABC" one char at a time — after EVERY char B's
// char count must reach the expected value (per-keystroke propagation, not
// just eventual convergence). Then B moves to the end (Ctrl+End) and types
// "XYZ" the same way — A must follow per char. Final: both at base+6.
//
// Fixture note: the legacy test uploaded a generated 11-char "Hello World"
// .txt through the legacy viewer and asserted absolute counts (11→14→17);
// the CV port opens test/data/new.docx and asserts the same deltas relative
// to the fixture's baseline count (subject unchanged: per-char A→B and B→A
// propagation with exact convergence).
//
// Migrated from wasm/tests/diag/test-cursor-debug.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-2browser.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const {
    openCoEditPair, waitCvCharCount,
} = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/2browser';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const PER_CHAR_BUDGET = parseInt(process.env.PER_CHAR_BUDGET || '30000', 10);
const PROPAGATE_BUDGET = parseInt(process.env.PROPAGATE_BUDGET || '90000', 10);

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
let shotN = 0;
async function snap(page, name) {
    try {
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${SHOT_DIR}/${String(++shotN).padStart(2, '0')}_${name}.png` });
    } catch (e) {}
}
async function clickIntoDoc(page) {
    const el = await page.$('iframe');
    const box = await el.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
    await sleep(800);
}

(async () => {
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
    log('=== 2-browser co-edit: per-keystroke propagation (content viewer) ===');
    log('viewer: ' + BASE);
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });

    const { browser } = await launch({ headless: 'new' });
    try {
        const bytes = fs.readFileSync(FIXTURE);
        const { A, B } = await openCoEditPair(browser, BASE,
            'cv-2browser-' + Date.now() + '.docx', bytes,
            { userA: 'Alice 2B', userB: 'Bob 2B', loadBudgetMs: LOAD_BUDGET });
        log('A + B interactive');
        await sleep(3000);

        const base = await waitCvCharCount(A.page, c => c >= 0, 30000);
        check('A: baseline char count readable', base >= 0, 'base=' + base);
        const bBase = await waitCvCharCount(B.page, c => c === base, 30000);
        check('B: opened the same doc (matching baseline)', bBase === base,
            'A=' + base + ' B=' + bBase);
        await snap(A.page, 'A_initial');
        await snap(B.page, 'B_initial');

        // ── Phase 1: A types ABC one char at a time; B must follow per char ──
        log('\n--- Phase 1: A types ABC per-char ---');
        await clickIntoDoc(A.page);
        for (let i = 0; i < 3; i++) {
            const ch = 'ABC'[i];
            const expected = base + i + 1;
            await A.page.keyboard.type(ch, { delay: 50 });
            const got = await waitCvCharCount(B.page, c => c === expected, PER_CHAR_BUDGET);
            check(`After A types "${ch}": B at ${expected}`, got === expected, 'B=' + got);
        }
        const convA1 = await waitCvCharCount(A.page, c => c === base + 3, PROPAGATE_BUDGET);
        const convB1 = await waitCvCharCount(B.page, c => c === base + 3, PROPAGATE_BUDGET);
        check('Both at base+3 after ABC', convA1 === base + 3 && convB1 === base + 3,
            'A=' + convA1 + ' B=' + convB1);
        await snap(A.page, 'A_after_ABC');
        await snap(B.page, 'B_after_ABC');

        // ── Phase 2: B moves to end and types XYZ; A must follow per char ──
        log('\n--- Phase 2: B Ctrl+End then types XYZ per-char ---');
        await clickIntoDoc(B.page);
        await B.page.keyboard.down('Control');
        await B.page.keyboard.press('End');
        await B.page.keyboard.up('Control');
        await sleep(2000);
        for (let i = 0; i < 3; i++) {
            const ch = 'XYZ'[i];
            const expected = base + 3 + i + 1;
            await B.page.keyboard.type(ch, { delay: 50 });
            const got = await waitCvCharCount(A.page, c => c === expected, PER_CHAR_BUDGET);
            check(`After B types "${ch}": A at ${expected}`, got === expected, 'A=' + got);
        }

        // ── Final convergence ──
        const fA = await waitCvCharCount(A.page, c => c === base + 6, PROPAGATE_BUDGET);
        const fB = await waitCvCharCount(B.page, c => c === base + 6, PROPAGATE_BUDGET);
        check('Final: both at base+6', fA === base + 6 && fB === base + 6,
            'A=' + fA + ' B=' + fB + ' expected=' + (base + 6));
        await snap(A.page, 'A_final');
        await snap(B.page, 'B_final');
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
