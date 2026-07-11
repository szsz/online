// test-cv-coedit-spell-correct-latejoin.js — co-editing SPELL-CORRECT then
// LATE-JOIN through the Tresorit content viewer: the correction must reach a
// joiner who arrives AFTER the correction was made and saved.
//
// Reproduces the user-reported bug "fixing a word with spellcheck breaks
// co-editing". Mechanism:
//   1. A right-clicks a misspelled word and picks a suggestion. The
//      correction applies to A's live model (char count +1) and broadcasts
//      to live peers, so LIVE co-editing looks fine.
//   2. A deselects the word (clicks elsewhere — normal use) and saves.
//      LO does NOT re-serialize the correction on save once the word is
//      deselected (the doc reads back "unmodified"), so the export POSTs the
//      UNCHANGED original bytes.
//   3. The relay used to rotate the checkpoint to those stale bytes and
//      prune the messageLog — dropping the correction message. A late-joiner
//      then downloaded the stale checkpoint with nothing left to replay and
//      permanently DIVERGED from A (corrector 447 vs joiner 446).
//
// The fix (relay-adapter.js cvSaveAndRotate) enforces a checkpoint invariant:
// only rotate when the saved bytes actually advanced past the current
// checkpoint (hash changed). A byte-identical save no longer prunes the log,
// so the correction stays replayable and the late-joiner converges.
//
// In the CV room, "Save" = the tester Save button (cvSaveAndRotate: 0x07 +
// /shared-file overwrite). This test drives the exact flow through the
// visible UI and asserts the late-joiner converges to the corrector's char
// count.
//
// Migrated from wasm/tests/coedit/test-coedit-spell-correct-latejoin.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-coedit-spell-correct-latejoin.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const {
    openCoEditPair, joinViaContentViewer, waitCvInteractive, cvEditorFrame, cvCharCount,
} = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'mixed-lang-paragraphs.docx');
const SHOT_DIR = '/tmp/content-viewer-report/coedit-spell-correct-latejoin';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const CONVERGE_BUDGET = parseInt(process.env.CONVERGE_BUDGET || '120000', 10);
const VP = { width: 1600, height: 1000 };
// mixed-lang-paragraphs.docx: EN paragraph misspelling "manuscrit" at ~985,337
// (frame-relative; the iframe page offset is added before every mouse op).
const EN = { x: 985, y: 337 };

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

async function ifrOffset(page) {
    return page.evaluate(() => { const f = document.querySelector('iframe'); const r = f.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top) }; }).catch(() => ({ left: 0, top: 0 }));
}
async function clickDoc(page, x, y, opts) {
    const o = await ifrOffset(page);
    await page.mouse.click(x + o.left, y + o.top, opts);
}
async function evalFr(page, fn, ...args) {
    const fr = cvEditorFrame(page);
    if (!fr) return null;
    return fr.evaluate(fn, ...args).catch(() => null);
}

// Read the whole-doc char count; -9 when a selection is active (caller
// escapes and retries so we never read a "Selected: N characters" figure).
async function rawCount(page) {
    return (await evalFr(page, () => {
        const t = document.querySelector('#StateWordCount')?.textContent || '';
        if (/^\s*Selected/i.test(t)) return -9;
        const m = t.match(/([\d,]+)\s*characters?\b/);
        return m ? parseInt(m[1].replace(/,/g, '')) : -1;
    }));
}
async function docCount(page) {
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(400);
    let c = await rawCount(page);
    for (let i = 0; i < 5 && c === -9; i++) { await page.keyboard.press('Escape').catch(() => {}); await sleep(400); c = await rawCount(page); }
    return c;
}
async function convergeTo(pages, target, timeoutMs) {
    const deadline = Date.now() + timeoutMs; let counts = {};
    while (Date.now() < deadline) {
        counts = {}; let all = true;
        for (const [id, p] of Object.entries(pages)) { const c = await docCount(p); counts[id] = c; if (c !== target) all = false; }
        if (all) return { ok: true, counts };
        await sleep(700);
    }
    return { ok: false, counts };
}
async function menuItems(page) {
    return (await evalFr(page, () => [...document.querySelectorAll('.context-menu-list')]
        .filter(l => l.offsetParent)
        .flatMap(l => [...l.querySelectorAll('.context-menu-item')].map(i => (i.textContent || '').trim()).filter(Boolean)))) || [];
}
// Tester Save button — in a CV co-edit room this rotates the relay checkpoint
// (cvSaveAndRotate: 0x07 + /shared-file overwrite).
async function clickTesterSave(page) {
    const h = await page.evaluateHandle(() =>
        [...document.querySelectorAll('button')].find(b => /^save$/i.test((b.textContent || '').trim())));
    const el = h.asElement();
    if (!el) return false;
    await el.click();
    return true;
}

(async () => {
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
    log('=== CV co-editing SPELL-CORRECT then LATE-JOIN ===');
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    let ctxC = null, pair = null;
    try {
        const bytes = fs.readFileSync(FIXTURE);
        const NAME = 'cv-spellcorrlj-' + Date.now() + '.docx';
        // A creates the co-edit room; B joins (co-edit peer) so the room has a
        // live participant across the correction (subject-identical setup).
        pair = await openCoEditPair(browser, BASE, NAME, bytes, {
            userA: 'Alice SpellLJ', userB: 'Bob SpellLJ', viewport: VP,
            loadBudgetMs: LOAD_BUDGET, iframeTimeout: 60000,
        });
        const A = pair.A.page;
        await sleep(14000);
        const base = await docCount(A);
        check('A opened', base > 0, 'chars=' + base);

        // A right-clicks the misspelled word and picks a suggestion.
        await clickDoc(A, EN.x - 120, EN.y); await sleep(1200);
        await clickDoc(A, EN.x, EN.y, { button: 'right' }); await sleep(2500);
        const items = await menuItems(A);
        const sug = items.find(t => t && !/^(ignore|spelling|add|set lang|paragraph|paste|page style|clone)/i.test(t));
        check('spelling suggestion menu appeared', !!sug, 'pick="' + sug + '" from ' + JSON.stringify(items.slice(0, 4)));
        const rect = await evalFr(A, (txt) => {
            for (const l of [...document.querySelectorAll('.context-menu-list')].filter(l => l.offsetParent))
                for (const it of l.querySelectorAll('.context-menu-item'))
                    if ((it.textContent || '').trim() === txt) { const r = it.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
            return null;
        }, sug);
        if (rect) { const o = await ifrOffset(A); await A.mouse.click(rect.x + o.left, rect.y + o.top); await sleep(3000); }

        // Deselect (normal use) then save.
        await clickDoc(A, EN.x, EN.y + 130); await sleep(1500);
        const aCorr = await docCount(A);
        check('A correction applied (char count advanced by 1)', aCorr === base + 1, `base=${base} afterCorrect=${aCorr}`);
        check('A: tester Save button clicked', await clickTesterSave(A));
        await sleep(9000);

        // C late-joins AFTER the correction was made + saved.
        log('--- C late-joins ---');
        ctxC = await browser.createBrowserContext();
        const pageC = await ctxC.newPage();
        const upC = await joinViaContentViewer(browser, pair.joinLink, {
            page: pageC, userName: 'Cara SpellLJ', viewport: VP, iframeTimeout: 90000,
        });
        const C = upC.page;
        try { await waitCvInteractive(C, LOAD_BUDGET); } catch (e) { log('  C interactive-wait failed: ' + String(e).slice(0, 80)); }
        await sleep(6000);

        const r = await convergeTo({ A, C }, aCorr, CONVERGE_BUDGET);
        check('late-joiner C converges to A\'s corrected state', r.ok, `target=${aCorr} ${JSON.stringify(r.counts)}`);
        await snap(A, 'A_final'); await snap(C, 'C_final');
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        for (const c of [pair && pair.contextB, ctxC]) { if (c) { try { await c.close(); } catch (e) {} } }
        try { await browser.close(); } catch (e) {}
    }
    log('\n' + (allPassed ? 'ALL PASS' : 'SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
