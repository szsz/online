// test-cv-coedit-typing.js — two browsers co-edit one doc through the
// Tresorit content viewer: typing propagates A→B and B→A.
//
// A opens /collabora-tester, ticks the real "Co-edit" checkbox, uploads a
// doc (tester seeds /shared-file/<room> and opens the editor into a relay
// room). B — an ISOLATED browser context, its own SW + storage — pastes the
// join link. Both type through the real keyboard; the test asserts both
// sides converge on the combined character count. Also asserts the co-edit
// iframe actually carries the relay param (tripwire: co-edit reaches the
// editor, not just the tester UI).
//
// Usage: node wasm/tests/content-viewer/test-cv-coedit-typing.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, joinViaContentViewer } = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOCX = process.env.DOCX || path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/coedit-typing';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '180000', 10);
const PROPAGATE_BUDGET = parseInt(process.env.PROPAGATE_BUDGET || '90000', 10);

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
const editorFrame = page => page.frames().find(f => (f.url() || '').includes('cool.html'));
async function waitInteractive(page, budget) {
    const d = Date.now() + budget;
    while (Date.now() < d) {
        const ok = await page.evaluate(() => {
            if (document.querySelector('[role="status"][aria-label="Loading"]')) return false;
            const s = [...document.querySelectorAll('button')].find(b => /^sav/i.test((b.textContent || '').trim()));
            return !!(s && !s.disabled);
        }).catch(() => false);
        if (ok) return true;
        await sleep(500);
    }
    return false;
}
async function charCount(page) {
    const fr = editorFrame(page);
    if (!fr) return -1;
    return fr.evaluate(() => {
        const t = document.querySelector('#StateWordCount')?.textContent || '';
        const m = t.match(/([\d,.]+)\s+character/i);
        return m ? parseInt(m[1].replace(/[,.]/g, ''), 10) : -1;
    }).catch(() => -1);
}
async function waitCharCount(page, pred, budget) {
    const d = Date.now() + budget;
    let last = -1;
    while (Date.now() < d) {
        last = await charCount(page);
        if (pred(last)) return last;
        await sleep(500);
    }
    return last;
}
async function typeIntoDoc(page, text) {
    const el = await page.$('iframe');
    const box = await el.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
    await sleep(800);
    await page.keyboard.type(text, { delay: 60 });
}

(async () => {
    if (!fs.existsSync(DOCX)) { check('fixture present', false, DOCX); process.exit(2); }
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    try {
        // ── A: create the co-edit session ──
        const A = await openViaContentViewer(browser, BASE, DOCX, {
            userName: 'Alice CoEdit', coEdit: true, iframeTimeout: 60000,
        });
        check('A: editor iframe appeared', !!A.editorFrame);
        check('A: join link rendered', !!A.joinLink, A.joinLink || '(none)');
        const aUrl = A.editorFrame ? A.editorFrame.url() : '';
        check('A: iframe URL carries the relay room param', /[?&]relay=/.test(aUrl),
            aUrl.replace(/^.*cool\.html/, 'cool.html').slice(0, 140));
        check('A: editor interactive', await waitInteractive(A.page, LOAD_BUDGET));
        await sleep(3000);
        const aBase = await waitCharCount(A.page, c => c >= 0, 30000);
        check('A: char count readable', aBase >= 0, 'base=' + aBase);

        // ── B: join via the shared link in an isolated context ──
        const ctxB = await browser.createBrowserContext();
        const pageB = await ctxB.newPage();
        const B = await joinViaContentViewer(browser, A.joinLink, {
            page: pageB, userName: 'Bob CoEdit', iframeTimeout: 90000,
        });
        check('B: editor iframe appeared', !!B.editorFrame);
        check('B: editor interactive', await waitInteractive(B.page, LOAD_BUDGET));
        await sleep(3000);
        const bBase = await waitCharCount(B.page, c => c >= 0, 30000);
        check('B: opened the same doc (matching baseline)', bBase === aBase,
            'A=' + aBase + ' B=' + bBase);

        // ── A types → must reach B ──
        await typeIntoDoc(A.page, 'HELLOA');
        const aAfter = await waitCharCount(A.page, c => c >= aBase + 6, 30000);
        check('A: own typing landed', aAfter >= aBase + 6, 'count=' + aAfter);
        const bSeesA = await waitCharCount(B.page, c => c >= aBase + 6, PROPAGATE_BUDGET);
        check('B: received A\'s edits (A→B propagation)', bSeesA >= aBase + 6,
            'B=' + bSeesA + ' expected>=' + (aBase + 6));

        // ── B types → must reach A ──
        await typeIntoDoc(B.page, 'BYE');
        const bAfter = await waitCharCount(B.page, c => c >= aBase + 9, 30000);
        check('B: own typing landed', bAfter >= aBase + 9, 'count=' + bAfter);
        const aSeesB = await waitCharCount(A.page, c => c >= aBase + 9, PROPAGATE_BUDGET);
        check('A: received B\'s edits (B→A propagation)', aSeesB >= aBase + 9,
            'A=' + aSeesB + ' expected>=' + (aBase + 9));

        try {
            fs.mkdirSync(SHOT_DIR, { recursive: true });
            await A.page.screenshot({ path: SHOT_DIR + '/a-final.png' });
            await B.page.screenshot({ path: SHOT_DIR + '/b-final.png' });
        } catch (e) {}
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
