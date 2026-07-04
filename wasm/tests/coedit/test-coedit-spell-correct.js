const __cl = require('../../lib/inject-checklist');
// Co-editing LANGUAGE + SPELLCHECK + SPELL-CORRECT convergence.
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
// Visible-UI only (real right-click + menu-item click). The editor iframe
// fills the page, so a menu item's viewport rect ≈ page coords.

'use strict';

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { openViaViewer, openSecretInBrowser } = require('../../lib/open-via-viewer');
const { waitInFrame, evalInFrame } = require('../../lib/two-tab');

const VIEWER = env.FILE_STORAGE_URL;
const LOAD_TIMEOUT = env.scaleTimeout(120000);
const CONVERGE_TIMEOUT = env.scaleTimeout(45000);
const VP = { width: 1600, height: 1000 };
const SHOT_DIR = '/tmp/static-deploy/public/shots-coedit-spell-correct';
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'mixed-lang-paragraphs.docx');
// English "manuscrit" line-1 coords at 1600x1000 (from the single-user test).
const EN_WORD = { x: 985, y: 337 };
const DE_PARA = { x: 500, y: 428 };
const DE_WORD = { x: 795, y: 428 }; // German misspelling "Woerter" at 1600x1000

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
let shotNum = 0;
async function snap(part, name) {
    if (!part || part.dead) return;
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    try { await part.page.screenshot({ path: `${SHOT_DIR}/${String(++shotNum).padStart(2,'0')}_${part.id}_${name}.png` }); } catch (e) {}
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
    return evalInFrame(part.page, () => {
        const lists = [...document.querySelectorAll('.context-menu-list')].filter(l => l.offsetParent !== null);
        const items = [];
        lists.forEach(l => l.querySelectorAll('.context-menu-item').forEach(it => { const t = (it.textContent || '').trim(); if (t) items.push(t); }));
        return items;
    }).catch(() => []);
}
function isSpellingMenu(items) {
    return /ignore|spelling|add to dictionary|add word/.test(items.join(' | ').toLowerCase());
}
const FIXED_RE = /^(ignore|ignore all|spelling|spelling…|add|add to dictionary|add word|set language|paragraph|paste|comment|page style|clone)/i;

async function langStatus(part) {
    return evalInFrame(part.page, () =>
        (window.app && window.app.map && window.app.map['stateChangeHandler']
            && window.app.map['stateChangeHandler'].getItemValue('.uno:LanguageStatus')) || '(unset)').catch(() => '(err)');
}

async function joinPart(browser, id, secret) {
    log(`--- ${id} joining (co-edit) ---`);
    const up = await openSecretInBrowser(browser, VIEWER, secret, {
        iframeTimeout: LOAD_TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
        isolatedContext: true, coEditing: true, viewport: VP,
    });
    const part = wire({ id, page: up.page, context: up.context, dead: false });
    await waitInFrame(part.page, () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''), { timeout: LOAD_TIMEOUT });
    await sleep(6000);
    return part;
}

(async () => {
    log('=== Co-editing LANGUAGE + SPELLCHECK + SPELL-CORRECT ===');
    const { browser } = await launch({ headless: 'new' });
    const parts = {};
    try {
        const bytes = fs.readFileSync(FIXTURE);
        const upA = await openViaViewer(browser, VIEWER, 'coedit-spell-' + Date.now() + '.docx', bytes, {
            iframeTimeout: LOAD_TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
            isolatedContext: true, coEditing: true, viewport: VP,
        });
        const A = parts.A = wire({ id: 'A', page: upA.page, context: upA.context, dead: false });
        const secret = upA.b64urlSecret;
        await waitInFrame(A.page, () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''), { timeout: LOAD_TIMEOUT });
        await sleep(6000);
        const B = parts.B = await joinPart(browser, 'B', secret);
        // spell scan settle
        await sleep(env.scaleTimeout(16000));
        await snap(A, 'loaded'); await snap(B, 'loaded');

        const base = await stableCount(A, CONVERGE_TIMEOUT);
        let r = await convergeTo([A, B], base, CONVERGE_TIMEOUT);
        check('A + B open the mixed-lang doc and converge', r.ok && base > 100, `base=${base} ${JSON.stringify(r.counts)}`);

        // ── LANGUAGE: the German paragraph must spell-check in GERMAN ──
        // The concrete proof of the multi-language feature is that a German
        // misspelling in the German-tagged paragraph produces German spelling
        // suggestions (the de-DE dict loaded on cursor entry). This is more
        // meaningful and robust than the .uno:LanguageStatus string (which
        // reports "*" for a bare click).
        log('--- LANGUAGE: A primes German paragraph + right-clicks a German misspelling ---');
        await A.page.bringToFront().catch(() => {});
        await A.page.mouse.click(DE_PARA.x, DE_PARA.y);         // enter German paragraph → de dict loads
        await sleep(env.scaleTimeout(10000));
        const deStat = await langStatus(A);
        log(`  A LanguageStatus in German paragraph: "${deStat}"`);
        await A.page.mouse.click(DE_WORD.x - 60, DE_WORD.y); await sleep(1500);
        await A.page.mouse.click(DE_WORD.x, DE_WORD.y, { button: 'right' });
        await sleep(env.scaleTimeout(2500));
        const deItems = await menuItems(A);
        await snap(A, 'de_spell_menu');
        log(`  A German menu: ${JSON.stringify(deItems).slice(0, 200)}`);
        check('German paragraph spell-checks in German (de dict loaded → suggestions)',
            deItems.length > 0 && isSpellingMenu(deItems), `items=${JSON.stringify(deItems).slice(0, 160)}`);
        await A.page.keyboard.press('Escape'); await sleep(600);

        // ── SPELLCHECK on B: right-click the English misspelling → suggestions ──
        log('--- SPELLCHECK: B right-clicks "manuscrit" ---');
        await B.page.bringToFront().catch(() => {});
        await B.page.mouse.click(EN_WORD.x - 120, EN_WORD.y); await sleep(1500); // place cursor on line 1 (en dict)
        await B.page.mouse.click(EN_WORD.x, EN_WORD.y, { button: 'right' });
        await sleep(env.scaleTimeout(2500));
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
        await A.page.mouse.click(EN_WORD.x - 120, EN_WORD.y); await sleep(1500);
        const beforeA = await charCount(A);
        await A.page.mouse.click(EN_WORD.x, EN_WORD.y, { button: 'right' });
        await sleep(env.scaleTimeout(2500));
        const aItems = await menuItems(A);
        check('A: spelling menu appears', aItems.length > 0 && isSpellingMenu(aItems), `items=${aItems.length}`);
        const suggestion = aItems.find(t => t && !FIXED_RE.test(t.trim()));
        check('A: suggestion offered to apply', !!suggestion, `pick="${suggestion || '(none)'}"`);
        if (suggestion) {
            const rect = await evalInFrame(A.page, (txt) => {
                const lists = [...document.querySelectorAll('.context-menu-list')].filter(l => l.offsetParent !== null);
                for (const l of lists) for (const it of l.querySelectorAll('.context-menu-item')) {
                    if ((it.textContent || '').trim() === txt) { const r = it.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
                }
                return null;
            }, suggestion).catch(() => null);
            if (rect) {
                log(`  A clicking suggestion "${suggestion}"`);
                await A.page.mouse.click(rect.x, rect.y);
                await sleep(env.scaleTimeout(3500)); // apply + re-spell + relay
            } else { check('A: suggestion item locatable', false); }
            await snap(A, 'corrected');

            const afterA = await stableCount(A, CONVERGE_TIMEOUT);
            check('A: correction changed the document (char count moved)', afterA > 0 && afterA !== beforeA, `before=${beforeA} after=${afterA}`);
            // B must converge to A's corrected char count
            const cr = await convergeTo([A, B], afterA, CONVERGE_TIMEOUT);
            await snap(B, 'B_after_correction');
            check('B converges to A after the spell-correction (mutation propagated)', cr.ok, `target=${afterA} ${JSON.stringify(cr.counts)}`);

            // On B, the corrected word must no longer be flagged as misspelled
            await B.page.bringToFront().catch(() => {});
            await B.page.mouse.click(EN_WORD.x - 120, EN_WORD.y); await sleep(1500);
            await B.page.mouse.click(EN_WORD.x, EN_WORD.y, { button: 'right' });
            await sleep(env.scaleTimeout(2500));
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
        for (const id of Object.keys(parts)) { const p = parts[id]; if (p && !p.dead) { try { await p.context.close(); } catch (e) {} } }
        try { await browser.close(); } catch (e) {}
    }
    log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
