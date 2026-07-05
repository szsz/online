const __cl = require('../../lib/inject-checklist');
// Co-editing SPELL-CORRECT then LATE-JOIN — the correction must reach a
// joiner who arrives AFTER the correction was made and saved.
//
// Reproduces the user-reported bug "fixing a word with spellcheck breaks
// co-editing". Mechanism:
//   1. A right-clicks a misspelled word and picks a suggestion. The
//      correction applies to A's live model (char count +1) and broadcasts
//      to live peers, so LIVE co-editing looks fine.
//   2. A deselects the word (clicks elsewhere — normal use) and saves.
//      LO does NOT re-serialize the correction on .uno:Save once the word
//      is deselected (the doc reads back "unmodified"), so saveToServer
//      POSTs the UNCHANGED original bytes.
//   3. The relay used to rotate the checkpoint to those stale bytes and
//      prune the messageLog — dropping the correction message. A late-joiner
//      then downloaded the stale checkpoint with nothing left to replay and
//      permanently DIVERGED from A (corrector 447 vs joiner 446).
//
// The fix (relay-adapter.js saveAndUploadCheckpoint) enforces a checkpoint
// invariant: only rotate when the saved bytes actually advanced past the
// current checkpoint (hash changed). A byte-identical save no longer prunes
// the log, so the correction stays replayable and the late-joiner converges.
//
// This test drives the exact flow through the visible UI and asserts the
// late-joiner converges to the corrector's char count. It FAILS on the
// pre-fix relay-adapter (joiner stuck one char behind).

'use strict';

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { openViaViewer, openSecretInBrowser } = require('../../lib/open-via-viewer');
const { waitInFrame, evalInFrame } = require('../../lib/two-tab');

const VIEWER = env.FILE_STORAGE_URL;
const LOAD_TIMEOUT = env.scaleTimeout(120000);
const CONVERGE_TIMEOUT = env.scaleTimeout(120000);
const VP = { width: 1600, height: 1000 };
// mixed-lang-paragraphs.docx: EN paragraph misspelling "manuscrit" at ~985,337
const EN = { x: 985, y: 337 };
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'mixed-lang-paragraphs.docx');

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

async function charCount(page) {
    return evalInFrame(page, () => {
        const t = document.querySelector('#StateWordCount')?.textContent || '';
        // Escape any active selection first so we read the DOC count, not a
        // "Selected: N characters" figure.
        const m = t.match(/([\d,]+)\s*characters?\b/);
        // Reject the selection form so callers can retry after Escape.
        if (/^\s*Selected/i.test(t)) return -9;
        return m ? parseInt(m[1].replace(/,/g, '')) : -1;
    }).catch(() => -1);
}
async function docCount(page) {
    // Press Escape to clear selection, then read the whole-doc count.
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(400);
    let c = await charCount(page);
    for (let i = 0; i < 5 && c === -9; i++) { await page.keyboard.press('Escape').catch(() => {}); await sleep(400); c = await charCount(page); }
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
    return evalInFrame(page, () => [...document.querySelectorAll('.context-menu-list')]
        .filter(l => l.offsetParent)
        .flatMap(l => [...l.querySelectorAll('.context-menu-item')].map(i => (i.textContent || '').trim()).filter(Boolean))).catch(() => []);
}

(async () => {
    log('=== Co-editing SPELL-CORRECT then LATE-JOIN ===');
    const { browser } = await launch({ headless: 'new' });
    let ctxA = null, ctxC = null;
    try {
        const bytes = fs.readFileSync(FIXTURE);
        const upA = await openViaViewer(browser, VIEWER, 'spellcorrlj-' + Date.now() + '.docx', bytes, {
            iframeTimeout: LOAD_TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
            isolatedContext: true, coEditing: true, viewport: VP,
        });
        const A = upA.page; ctxA = upA.context;
        await waitInFrame(A, () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''), { timeout: LOAD_TIMEOUT });
        await sleep(14000);
        const base = await docCount(A);
        check('A opened', base > 0, 'chars=' + base);

        // A right-clicks the misspelled word and picks a suggestion.
        await A.mouse.click(EN.x - 120, EN.y); await sleep(1200);
        await A.mouse.click(EN.x, EN.y, { button: 'right' }); await sleep(2500);
        const items = await menuItems(A);
        const sug = items.find(t => t && !/^(ignore|spelling|add|set lang|paragraph|paste|page style|clone)/i.test(t));
        check('spelling suggestion menu appeared', !!sug, 'pick="' + sug + '" from ' + JSON.stringify(items.slice(0, 4)));
        const rect = await evalInFrame(A, (txt) => {
            for (const l of [...document.querySelectorAll('.context-menu-list')].filter(l => l.offsetParent))
                for (const it of l.querySelectorAll('.context-menu-item'))
                    if ((it.textContent || '').trim() === txt) { const r = it.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
            return null;
        }, sug).catch(() => null);
        if (rect) { await A.mouse.click(rect.x, rect.y); await sleep(3000); }

        // Deselect (normal use) then save.
        await A.mouse.click(EN.x, EN.y + 130); await sleep(1500);
        const aCorr = await docCount(A);
        check('A correction applied (char count advanced by 1)', aCorr === base + 1, `base=${base} afterCorrect=${aCorr}`);
        await A.keyboard.down('Control'); await A.keyboard.press('KeyS'); await A.keyboard.up('Control');
        await sleep(9000);

        // C late-joins AFTER the correction was made + saved.
        log('--- C late-joins ---');
        const upC = await openSecretInBrowser(browser, VIEWER, upA.b64urlSecret, {
            iframeTimeout: LOAD_TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
            isolatedContext: true, coEditing: true, viewport: VP,
        });
        const C = upC.page; ctxC = upC.context;
        try {
            await waitInFrame(C, () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''), { timeout: LOAD_TIMEOUT });
        } catch (e) { log('  C frame-wait failed: ' + e.message.slice(0, 80)); }
        await sleep(6000);

        const r = await convergeTo({ A, C }, aCorr, CONVERGE_TIMEOUT);
        check('late-joiner C converges to A\'s corrected state', r.ok, `target=${aCorr} ${JSON.stringify(r.counts)}`);
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        for (const c of [ctxA, ctxC]) { if (c) { try { await c.close(); } catch (e) {} } }
        try { await browser.close(); } catch (e) {}
    }
    log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
