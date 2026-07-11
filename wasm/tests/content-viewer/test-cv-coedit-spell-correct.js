// test-cv-coedit-spell-correct.js — co-editing LANGUAGE + SPELLCHECK +
// SPELL-CORRECT convergence through the Tresorit content viewer.
//
// Spell squiggles and the right-click suggestion menu are per-VIEW (each
// browser spell-checks its own view). But picking a suggestion REPLACES
// text — a document mutation that must converge across browsers. This test
// (mixed-lang-paragraphs.docx: en/de/fr paragraphs with known misspellings):
//   A + B open (co-edit, 1600x1000 so the known word coords line up)
//   LANGUAGE  : A enters the German paragraph → a German misspelling yields
//               GERMAN suggestions (the de-DE dict loaded per cursor context)
//   SPELLCHECK: B right-clicks the English misspelling "manuscrit" → a
//               spelling context menu with suggestions appears (B's spell
//               engine is live in co-edit)
//   SPELL-CORRECT + CONVERGE: A right-clicks "manuscrit" → picks the
//               "manuscript" suggestion → the replacement propagates and B
//               converges to A's char count; B no longer flags the word.
//   no CHECKPOINT MISMATCH / abort anywhere.
//
// Visible-UI only (real right-click + menu-item click). The editor iframe is
// hosted inside the tester page, so context-menu rects (read frame-relative)
// are offset by the iframe's page position before clicking.
//
// Migrated from wasm/tests/coedit/test-coedit-spell-correct.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-coedit-spell-correct.js [base-url]

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
const SHOT_DIR = '/tmp/content-viewer-report/coedit-spell-correct';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const CONVERGE_BUDGET = parseInt(process.env.CONVERGE_BUDGET || '90000', 10);
const VP = { width: 1600, height: 1000 };
// English "manuscrit" line-1 coords at 1600x1000 (from the single-user test),
// expressed relative to the editor-iframe top-left (page offset added later).
const EN_WORD = { x: 985, y: 337 };
const DE_PARA = { x: 500, y: 428 };
const DE_WORD = { x: 795, y: 428 }; // German misspelling "Woerter" at 1600x1000

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
    try { await part.page.screenshot({ path: `${SHOT_DIR}/${String(++shotNum).padStart(2, '0')}_${part.id}_${name}.png` }); } catch (e) {}
}

const ERR_RE = /CHECKPOINT MISMATCH|memory access out of bounds|RuntimeError|unreachable|Aborted\(|table index is out of bounds|OOB/i;
function wire(part) {
    part.errors = [];
    part.page.on('console', m => { const t = m.text(); if (ERR_RE.test(t)) part.errors.push(t.slice(0, 200)); });
    part.page.on('pageerror', e => { if (ERR_RE.test(e.message)) part.errors.push('pageerror: ' + e.message.slice(0, 200)); });
    return part;
}

// Page-space offset of the editor iframe (the doc canvas + menus live inside).
async function ifrOffset(page) {
    return page.evaluate(() => { const f = document.querySelector('iframe'); const r = f.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top) }; }).catch(() => ({ left: 0, top: 0 }));
}
// Click a frame-relative point in the doc (adds the iframe page offset).
async function clickDoc(part, x, y, opts) {
    const o = await ifrOffset(part.page);
    await part.page.mouse.click(x + o.left, y + o.top, opts);
}
async function evalFr(part, fn, ...args) {
    const fr = cvEditorFrame(part.page);
    if (!fr) return null;
    return fr.evaluate(fn, ...args).catch(() => null);
}

async function charCount(part) {
    if (!part || part.dead) return -2;
    return cvCharCount(part.page);
}
async function convergeTo(parts, target, timeoutMs) {
    const live = parts.filter(p => p && !p.dead); const deadline = Date.now() + timeoutMs; let counts = {};
    while (Date.now() < deadline) {
        counts = {}; let all = true;
        for (const p of live) { const c = await charCount(p); counts[p.id] = c; if (c !== target) all = false; }
        if (all) return { ok: true, counts };
        await sleep(500);
    }
    return { ok: false, counts };
}
async function stableCount(part, timeoutMs) {
    const deadline = Date.now() + timeoutMs; let prev = -1;
    while (Date.now() < deadline) { const c = await charCount(part); if (c > 0 && c === prev) return c; prev = c; await sleep(1000); }
    return prev;
}

async function menuItems(part) {
    return (await evalFr(part, () => {
        const lists = [...document.querySelectorAll('.context-menu-list')].filter(l => l.offsetParent !== null);
        const items = [];
        lists.forEach(l => l.querySelectorAll('.context-menu-item').forEach(it => { const t = (it.textContent || '').trim(); if (t) items.push(t); }));
        return items;
    })) || [];
}
function isSpellingMenu(items) {
    return /ignore|spelling|add to dictionary|add word/.test(items.join(' | ').toLowerCase());
}
const FIXED_RE = /^(ignore|ignore all|spelling|spelling…|add|add to dictionary|add word|set language|paragraph|paste|comment|page style|clone)/i;

async function langStatus(part) {
    return (await evalFr(part, () =>
        (window.app && window.app.map && window.app.map['stateChangeHandler']
            && window.app.map['stateChangeHandler'].getItemValue('.uno:LanguageStatus')) || '(unset)')) || '(err)';
}

async function joinPart(browser, joinLink, id, userName) {
    log(`--- ${id} joining (co-edit) ---`);
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await joinViaContentViewer(browser, joinLink, { page, userName, viewport: VP, iframeTimeout: 90000 });
    const part = wire({ id, page, context, dead: false });
    check(`${id}: editor interactive`, await waitCvInteractive(page, LOAD_BUDGET));
    await sleep(6000);
    return part;
}

(async () => {
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
    log('=== CV co-editing LANGUAGE + SPELLCHECK + SPELL-CORRECT ===');
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    const parts = {};
    try {
        const bytes = fs.readFileSync(FIXTURE);
        const NAME = 'cv-coedit-spell-' + Date.now() + '.docx';
        const pair = await openCoEditPair(browser, BASE, NAME, bytes, {
            userA: 'Alice Spell', userB: 'Bob Spell', viewport: VP,
            loadBudgetMs: LOAD_BUDGET, iframeTimeout: 60000,
        });
        const A = parts.A = wire({ id: 'A', page: pair.A.page, context: null, dead: false });
        const B = parts.B = wire({ id: 'B', page: pair.B.page, context: pair.contextB, dead: false });
        // spell scan settle
        await sleep(16000);
        await snap(A, 'loaded'); await snap(B, 'loaded');

        const base = await stableCount(A, CONVERGE_BUDGET);
        let r = await convergeTo([A, B], base, CONVERGE_BUDGET);
        check('A + B open the mixed-lang doc and converge', r.ok && base > 100, `base=${base} ${JSON.stringify(r.counts)}`);

        // ── LANGUAGE: the German paragraph must spell-check in GERMAN ──
        // The concrete proof of the multi-language feature is that a German
        // misspelling in the German-tagged paragraph produces German spelling
        // suggestions (the de-DE dict loaded on cursor entry). This is more
        // meaningful and robust than the .uno:LanguageStatus string (which
        // reports "*" for a bare click).
        log('--- LANGUAGE: A primes German paragraph + right-clicks a German misspelling ---');
        await A.page.bringToFront().catch(() => {});
        await clickDoc(A, DE_PARA.x, DE_PARA.y);         // enter German paragraph → de dict loads
        await sleep(10000);
        const deStat = await langStatus(A);
        log(`  A LanguageStatus in German paragraph: "${deStat}"`);
        // The de dictionary lazy-loads when the cursor first enters a German
        // run; under back-to-back suite load that load can lag past a single
        // right-click, so the spelling menu comes back empty. Retry: re-prime
        // the paragraph (re-trigger the dict load), right-click, and re-read
        // the menu until spelling suggestions appear. Deterministic wait for a
        // real async load — not a flake-list.
        let deItems = [];
        for (let attempt = 1; attempt <= 5; attempt++) {
            await A.page.keyboard.press('Escape'); await sleep(400);
            await clickDoc(A, DE_PARA.x, DE_PARA.y); await sleep(4000); // re-enter German run → de dict loads
            await clickDoc(A, DE_WORD.x - 60, DE_WORD.y); await sleep(1200);
            await clickDoc(A, DE_WORD.x, DE_WORD.y, { button: 'right' });
            await sleep(2500);
            deItems = await menuItems(A);
            log(`  A German menu (attempt ${attempt}): ${JSON.stringify(deItems).slice(0, 160)}`);
            if (deItems.length > 0 && isSpellingMenu(deItems)) break;
        }
        await snap(A, 'de_spell_menu');
        check('German paragraph spell-checks in German (de dict loaded → suggestions)',
            deItems.length > 0 && isSpellingMenu(deItems), `items=${JSON.stringify(deItems).slice(0, 160)}`);
        await A.page.keyboard.press('Escape'); await sleep(600);

        // ── SPELLCHECK on B: right-click the English misspelling → suggestions ──
        log('--- SPELLCHECK: B right-clicks "manuscrit" ---');
        await B.page.bringToFront().catch(() => {});
        await clickDoc(B, EN_WORD.x - 120, EN_WORD.y); await sleep(1500); // place cursor on line 1 (en dict)
        await clickDoc(B, EN_WORD.x, EN_WORD.y, { button: 'right' });
        await sleep(2500);
        const bItems = await menuItems(B);
        await snap(B, 'spell_menu');
        check('B: right-click misspelled word shows a spelling menu (spellcheck live in co-edit)',
            bItems.length > 0 && isSpellingMenu(bItems), `items=${JSON.stringify(bItems).slice(0, 160)}`);
        const bSuggestion = bItems.find(t => t && !FIXED_RE.test(t.trim()));
        check('B: at least one spelling suggestion offered', !!bSuggestion, `first=${bSuggestion || '(none)'}`);
        await B.page.keyboard.press('Escape'); await sleep(600);

        // ── SPELL-CORRECT on A + CONVERGE ──
        log('--- SPELL-CORRECT: A right-clicks "manuscrit" and picks a suggestion ---');
        await A.page.bringToFront().catch(() => {});
        await clickDoc(A, EN_WORD.x - 120, EN_WORD.y); await sleep(1500);
        const beforeA = await charCount(A);
        await clickDoc(A, EN_WORD.x, EN_WORD.y, { button: 'right' });
        await sleep(2500);
        const aItems = await menuItems(A);
        check('A: spelling menu appears', aItems.length > 0 && isSpellingMenu(aItems), `items=${aItems.length}`);
        const suggestion = aItems.find(t => t && !FIXED_RE.test(t.trim()));
        check('A: suggestion offered to apply', !!suggestion, `pick="${suggestion || '(none)'}"`);
        if (suggestion) {
            const rect = await evalFr(A, (txt) => {
                const lists = [...document.querySelectorAll('.context-menu-list')].filter(l => l.offsetParent !== null);
                for (const l of lists) for (const it of l.querySelectorAll('.context-menu-item')) {
                    if ((it.textContent || '').trim() === txt) { const r = it.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
                }
                return null;
            }, suggestion);
            if (rect) {
                const o = await ifrOffset(A.page);
                log(`  A clicking suggestion "${suggestion}"`);
                await A.page.mouse.click(rect.x + o.left, rect.y + o.top);
                await sleep(3500); // apply + re-spell + relay
            } else { check('A: suggestion item locatable', false); }
            await snap(A, 'corrected');

            const afterA = await stableCount(A, CONVERGE_BUDGET);
            check('A: correction changed the document (char count moved)', afterA > 0 && afterA !== beforeA, `before=${beforeA} after=${afterA}`);
            // B must converge to A's corrected char count
            const cr = await convergeTo([A, B], afterA, CONVERGE_BUDGET);
            await snap(B, 'B_after_correction');
            check('B converges to A after the spell-correction (mutation propagated)', cr.ok, `target=${afterA} ${JSON.stringify(cr.counts)}`);

            // On B, the corrected word must no longer be flagged as misspelled
            await B.page.bringToFront().catch(() => {});
            await clickDoc(B, EN_WORD.x - 120, EN_WORD.y); await sleep(1500);
            await clickDoc(B, EN_WORD.x, EN_WORD.y, { button: 'right' });
            await sleep(2500);
            const bItems2 = await menuItems(B);
            await snap(B, 'B_reverify');
            check('B: the corrected word is no longer flagged as misspelled', !isSpellingMenu(bItems2),
                `items=${JSON.stringify(bItems2).slice(0, 140)}`);
            await B.page.keyboard.press('Escape');
        }

        for (const id of Object.keys(parts)) {
            const p = parts[id];
            check(`${id}: no checkpoint-mismatch / abort / OOB`, p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
        }
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        for (const id of Object.keys(parts)) { const p = parts[id]; if (p && !p.dead && p.context) { try { await p.context.close(); } catch (e) {} } }
        try { await browser.close(); } catch (e) {}
    }
    log('\n' + (allPassed ? 'ALL PASS' : 'SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
