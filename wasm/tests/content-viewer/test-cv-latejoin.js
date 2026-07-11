// test-cv-latejoin.js — multi-phase late-join stress: participants keep
// arriving (and the creator eventually leaves) and every newcomer must land
// on the accumulated document state, then co-edit live.
//
// Phase 1: A creates a co-edit session, types ALPHA, SAVES (tester Save
//          button → cvSaveAndRotate: 0x07 + /shared-file overwrite — the CV
//          analog of the legacy checkpoint upload).
// Phase 2: B late-joins (its page stages the ROTATED /shared-file bytes),
//          must see ALPHA, types BETA.
// Phase 3: C late-joins while A+B are active, must see ALPHA+BETA, types
//          GAMMA; B and C must stay close.
// Phase 4: A leaves; D late-joins, must see the full accumulated state,
//          types DELTA; B, C, D must stay close.
//
// ALL input via real keyboard/mouse.
// Migrated from wasm/tests/misc/test-late-join.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-latejoin.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const {
    openBytesViaContentViewer, joinViaContentViewer,
    waitCvInteractive, cvCharCount, waitCvCharCount,
} = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/latejoin';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const PROPAGATE_BUDGET = parseInt(process.env.PROPAGATE_BUDGET || '120000', 10);
// Late joiners run docx round-trips on save/rotation (export → /shared-file
// → re-stage); each round-trip can mutate a few chars of metadata. Same
// documented bound as the legacy test (task #169 cluster A tracks the
// structural fix).
const LATEJOIN_DIVERGENCE_CEIL = 75;

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

// Focus the doc the way the PASSING co-edit tests do: click into the iframe
// body via its bounding box, then wait 800ms for the click to register focus
// BEFORE any keyboard input (a shorter settle or an immediate Ctrl+End on a
// freshly-opened editor loses the keystrokes — that was the harness bug).
// No Ctrl+End: the new.docx fixture is a single short paragraph, so the click
// already lands the caret at the end; the reference typeIntoDoc omits it too.
async function typeAtEnd(page, text) {
    await page.bringToFront().catch(() => {});
    const el = await page.$('iframe');
    const box = await el.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
    await sleep(800);
    await page.keyboard.type(text, { delay: 60 });
    await sleep(1500);
}
// Real click on the tester's Save button (parent page, not the iframe).
async function clickTesterSave(page) {
    const box = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')]
            .find(x => /^save$/i.test((x.textContent || '').trim()));
        if (!b || b.disabled) return null;
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (!box) return false;
    await page.mouse.click(box.x, box.y);
    return true;
}
// Observable save-rotation signal: relay-adapter logs the 0x07 send (or the
// no-op skip) to the console.
function watchRotations(page, sink) {
    page.on('console', m => {
        const t = m.text();
        const mm = t.match(/CV save-rotation 0x07 sent: hash=([0-9a-f]{8,})/i);
        if (mm) sink.push({ rotated: true, hashPrefix: mm[1] });
        else if (/CV save produced unchanged bytes/i.test(t)) sink.push({ rotated: false });
    });
}
async function waitForRotation(sink, sinceLen, budgetMs) {
    const d = Date.now() + budgetMs;
    while (Date.now() < d) {
        if (sink.length > sinceLen) return sink[sink.length - 1];
        await sleep(500);
    }
    return null;
}
async function joinFresh(browser, joinLink, userName) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    const r = await joinViaContentViewer(browser, joinLink, {
        page, userName, iframeTimeout: 90000,
    });
    // Let the freshly-joined editor settle before the caller reads state /
    // types. Typing the instant the doc renders (right after the first char
    // read) silently drops the keys on a just-joined client — that dropped
    // BETA/GAMMA/DELTA and cascaded into every downstream "got state" check.
    // The passing test-cv-regression-latejoin-overwrite settles the same 6s.
    await waitCvInteractive(page, 300000);
    await sleep(6000);
    return { page: r.page, editorFrame: r.editorFrame, ctx };
}

(async () => {
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
    log('viewer: ' + BASE);
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    const { browser } = await launch({ headless: 'new' });
    try {
        // ===== Phase 1: A creates, types ALPHA, saves (rotation) =====
        log('===== Phase 1: A creates, types ALPHA, saves =====');
        const rotations = [];
        const A = await openBytesViaContentViewer(browser, BASE,
            'cv-latejoin-' + Date.now() + '.docx', fs.readFileSync(FIXTURE),
            { userName: 'Alpha A', coEdit: true, iframeTimeout: 60000 });
        watchRotations(A.page, rotations);
        check('A: editor iframe + join link', !!A.editorFrame && !!A.joinLink);
        check('A: editor interactive', await waitCvInteractive(A.page, LOAD_BUDGET));
        // Let the editor settle before the first keystroke: a stable char
        // count (two equal consecutive reads) means the doc is genuinely
        // interactive and will accept keyboard input. Typing too early — right
        // after the first c>=0 read — silently drops the keys (the ALPHA bug).
        await sleep(6000);
        let base = -1, prevBase = -2;
        for (const t0 = Date.now(); Date.now() - t0 < 60000;) {
            base = await cvCharCount(A.page);
            if (base > 0 && base === prevBase) break;
            prevBase = base; await sleep(1000);
        }
        check('A: char count readable', base >= 0, 'base=' + base);
        await snap(A.page, 'A_initial');

        await typeAtEnd(A.page, 'ALPHA');   // +5
        const afterAlpha = await waitCvCharCount(A.page, c => c >= base + 5, 30000);
        check('ALPHA inserted', afterAlpha === base + 5, 'count=' + afterAlpha);
        await snap(A.page, 'A_after_ALPHA');

        // Save: tester Save button rotates the room checkpoint (0x07 +
        // /shared-file overwrite) — future joiners stage the saved bytes.
        check('A: Save button clicked', await clickTesterSave(A.page));
        const rot1 = await waitForRotation(rotations, 0, 30000);
        check('A: save rotated the checkpoint', !!(rot1 && rot1.rotated),
            rot1 ? JSON.stringify(rot1) : 'no rotation signal');

        // ===== Phase 2: B late-joins, types BETA =====
        log('===== Phase 2: B late-joins =====');
        const B = await joinFresh(browser, A.joinLink, 'Beta B');
        check('B: editor iframe appeared', !!B.editorFrame);
        check('B: editor interactive', await waitCvInteractive(B.page, LOAD_BUDGET));
        const bJoin = await waitCvCharCount(B.page, c => c >= afterAlpha, PROPAGATE_BUDGET);
        check('B got saved state from A', bJoin >= afterAlpha,
            'B=' + bJoin + ' expected>=' + afterAlpha);
        await snap(B.page, 'B_initial');

        await typeAtEnd(B.page, 'BETA');    // +4
        const bAfterBeta = await waitCvCharCount(B.page, c => c >= bJoin + 4, 30000);
        check('BETA typing worked', bAfterBeta > bJoin, 'B=' + bAfterBeta);
        const aAfterBeta = await waitCvCharCount(A.page, c => c >= afterAlpha + 4, PROPAGATE_BUDGET);
        check('A received BETA', aAfterBeta >= afterAlpha + 4, 'A=' + aAfterBeta);
        await snap(A.page, 'A_after_BETA');

        // ===== Phase 3: C late-joins while A+B active =====
        log('===== Phase 3: C late-joins =====');
        const C = await joinFresh(browser, A.joinLink, 'Gamma C');
        check('C: editor iframe appeared', !!C.editorFrame);
        check('C: editor interactive', await waitCvInteractive(C.page, LOAD_BUDGET));
        const cJoin = await waitCvCharCount(C.page, c => c >= afterAlpha + 4, PROPAGATE_BUDGET);
        check('C got state from A and B', cJoin >= afterAlpha + 4,
            'C=' + cJoin + ' expected>=' + (afterAlpha + 4));
        await snap(C.page, 'C_initial');

        await typeAtEnd(C.page, 'GAMMA');   // +5
        // B and C must end up close (convergence poll toward equality).
        let bAfterGamma = -1, cAfterGamma = -1;
        const gDeadline = Date.now() + PROPAGATE_BUDGET;
        do {
            bAfterGamma = await cvCharCount(B.page);
            cAfterGamma = await cvCharCount(C.page);
            if (bAfterGamma > 0 && bAfterGamma === cAfterGamma) break;
            await sleep(500);
        } while (Date.now() < gDeadline);
        const bcDiff = Math.abs(bAfterGamma - cAfterGamma);
        check(`B and C close after GAMMA (diff=${bcDiff})`, bcDiff < LATEJOIN_DIVERGENCE_CEIL,
            'B=' + bAfterGamma + ' C=' + cAfterGamma);
        await snap(B.page, 'B_after_GAMMA');
        await snap(C.page, 'C_after_GAMMA');

        // ===== Phase 4: A leaves, D late-joins =====
        log('===== Phase 4: A leaves, D late-joins =====');
        await A.page.close();
        log('A closed');
        await sleep(5000);

        const D = await joinFresh(browser, A.joinLink, 'Delta D');
        check('D: editor iframe appeared', !!D.editorFrame);
        check('D: editor interactive', await waitCvInteractive(D.page, LOAD_BUDGET));
        const dJoin = await waitCvCharCount(D.page, c => c >= afterAlpha + 9, PROPAGATE_BUDGET);
        check('D got accumulated state', dJoin >= afterAlpha + 9,
            'D=' + dJoin + ' expected>=' + (afterAlpha + 9));
        await snap(D.page, 'D_initial');

        await typeAtEnd(D.page, 'DELTA');   // +5
        let bcd = [];
        const dDeadline = Date.now() + PROPAGATE_BUDGET;
        do {
            bcd = [await cvCharCount(B.page), await cvCharCount(C.page), await cvCharCount(D.page)];
            if (bcd[0] > 0 && bcd[0] === bcd[1] && bcd[1] === bcd[2]) break;
            await sleep(500);
        } while (Date.now() < dDeadline);
        const maxDiff = Math.max(...bcd) - Math.min(...bcd);
        check(`B,C,D close after DELTA (maxDiff=${maxDiff})`, maxDiff < LATEJOIN_DIVERGENCE_CEIL,
            'B/C/D=' + bcd.join('/'));
        await snap(B.page, 'B_final');
        await snap(C.page, 'C_final');
        await snap(D.page, 'D_final');
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
