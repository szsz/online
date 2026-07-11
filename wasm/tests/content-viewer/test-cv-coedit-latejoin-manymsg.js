// test-cv-coedit-latejoin-manymsg.js — a late-join after MANY unsaved
// messages must reconstruct the full state; replay must not be lost to the
// switchdocument reload.
//
// Legacy subject (viewer): with the host holding many UNSAVED edits (typing +
// a paragraph split (Enter) + a concurrent peer edit ≈ 90 relay messages), a
// fresh joiner used to land on the BARE BASE DOCUMENT — every edit lost —
// because its replayed messages applied to the prewarm-blank doc and finished
// BEFORE switchdocument loaded the real base checkpoint, which then discarded
// them. The fix holds replay until window.__wasmSwitchDocLoaded so replay
// lands on the switched-in doc. The test asserts the late-joiner converges to
// the host's full unsaved state (fails pre-fix, one+ edits short).
//
// CV port: A creates a co-edit room, B joins. Both accumulate many unsaved
// messages (A types a run of words, moves the cursor, splits a paragraph
// while B types concurrently). Nothing is saved. A fresh C late-joins the
// co-edit link and must reconstruct the full unsaved state with no edit loss
// and no checkpoint mismatch / abort / OOB. Visible-UI only; convergence =
// equal #StateWordCount.
//
// Migrated from wasm/tests/coedit/test-coedit-latejoin-manymsg.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-coedit-latejoin-manymsg.js [base-url]

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
const SHOT_DIR = '/tmp/content-viewer-report/coedit-latejoin-manymsg';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const CONVERGE_BUDGET = parseInt(process.env.CONVERGE_BUDGET || '120000', 10);

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
const errs = [];
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
const ERR = /CHECKPOINT MISMATCH|memory access out of bounds|RuntimeError|unreachable|Aborted\(|OOB/i;
function wire(page, tag) { page.on('console', m => { if (ERR.test(m.text())) errs.push(tag + ':' + m.text().slice(0, 80)); }); return page; }

// The #StateWordCount flips to "Selected: …" when a selection is active;
// press Escape first so we read the doc-wide character count.
async function cc(page) {
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(300);
    const fr = page.frames().find(f => (f.url() || '').includes('cool.html'));
    if (!fr) return -1;
    return fr.evaluate(() => {
        const t = document.querySelector('#StateWordCount')?.textContent || '';
        if (/^\s*Selected/i.test(t)) return -9;
        const m = t.match(/([\d,.]+)\s*characters?\b/i);
        return m ? parseInt(m[1].replace(/[,.]/g, ''), 10) : -1;
    }).catch(() => -1);
}
async function stable(page, ms) {
    const d = Date.now() + ms; let pv = -1;
    while (Date.now() < d) { const c = await cc(page); if (c > 0 && c === pv) return c; pv = c; await sleep(800); }
    return pv;
}
async function convergeTo(pages, target, ms) {
    const d = Date.now() + ms; let cs = {};
    while (Date.now() < d) {
        cs = {}; let ok = true;
        for (const [id, p] of Object.entries(pages)) { const c = await cc(p); cs[id] = c; if (c !== target) ok = false; }
        if (ok) return { ok: true, cs };
        await sleep(600);
    }
    return { ok: false, cs };
}
async function atEnd(page, txt) {
    await page.bringToFront().catch(() => {});
    const box = await (await page.$('iframe')).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
    await sleep(200);
    await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
    await sleep(150);
    await page.keyboard.type(txt, { delay: 40 });
    await sleep(800);
}

(async () => {
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
    log('=== CV co-editing LATE-JOIN after MANY UNSAVED messages ===');
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    let ctxB, ctxC;
    try {
        const bytes = fs.readFileSync(FIXTURE);
        const NAME = 'cv-ljmm-' + Date.now() + '.docx';

        const pair = await openCoEditPair(browser, BASE, NAME, bytes, {
            userA: 'Many Alice', userB: 'Many Bob',
        });
        ctxB = pair.contextB;
        const A = wire(pair.A.page, 'A');
        const B = wire(pair.B.page, 'B');
        await sleep(6000);
        check('A + B open + converge', (await cc(A)) > 0);

        // Accumulate many UNSAVED messages: A types, moves cursor, splits a
        // paragraph (Enter), while B types concurrently. No save → the joiner
        // must replay all of it onto the switched-in base checkpoint.
        await atEnd(A, 'one two three four five ');
        await sleep(2000);
        await stable(A, CONVERGE_BUDGET);

        await A.bringToFront();
        {
            const box = await (await A.$('iframe')).boundingBox();
            await A.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
        }
        await A.keyboard.down('Control'); await A.keyboard.press('Home'); await A.keyboard.up('Control');
        await sleep(200);
        for (let i = 0; i < 8; i++) await A.keyboard.press('ArrowRight');
        await sleep(200);
        await Promise.all([
            (async () => { await A.keyboard.press('Enter'); await A.keyboard.type('SPLIT', { delay: 40 }); })(),
            atEnd(B, 'Bend '),
        ]);
        await sleep(3500);
        const target = await stable(A, CONVERGE_BUDGET);
        const liveB = await stable(B, CONVERGE_BUDGET);
        check('live A + B converge on the unsaved edits', target > 19 && target === liveB, `A=${target} B=${liveB}`);

        // Fresh joiner C must reconstruct the full unsaved state (replay must
        // land on the switched-in checkpoint doc, not the discarded blank).
        log('--- C late-joins after many unsaved messages ---');
        ctxC = await browser.createBrowserContext();
        const C = wire(await ctxC.newPage(), 'C');
        await joinViaContentViewer(browser, pair.joinLink, {
            page: C, userName: 'Many Cara', iframeTimeout: 90000,
        });
        check('C: editor interactive', await waitCvInteractive(C, LOAD_BUDGET));
        await sleep(6000);
        const r = await convergeTo({ A, C }, target, CONVERGE_BUDGET);
        check('late-joiner C converges to full unsaved state (no edit loss)', r.ok, `target=${target} ${JSON.stringify(r.cs)}`);
        check('no checkpoint-mismatch / abort / OOB', errs.length === 0, errs.slice(0, 3).join(' | '));
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        for (const c of [ctxB, ctxC]) { if (c) { try { await c.close(); } catch (e) {} } }
        try { await browser.close(); } catch (e) {}
    }
    log('\n' + (allPassed ? 'ALL PASS' : 'SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
