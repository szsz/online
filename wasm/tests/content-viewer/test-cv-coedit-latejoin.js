// test-cv-coedit-latejoin.js — a browser that joins AFTER the creator has
// typed unsaved edits must converge to them (relay message-log replay), then
// keep receiving live edits.
//
// A creates a co-edit session via /collabora-tester, types BEFORE anyone
// joins. B then pastes the join link (isolated context): its page stages the
// original /shared-file bytes, and the relay replays A's buffered edits on
// top — B must land on A's exact character count without any save having
// happened. A then types more; B must follow live.
//
// Usage: node wasm/tests/content-viewer/test-cv-coedit-latejoin.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep: _rawSleep } = require('../../lib/browser');
const { scaleTimeout } = require('../../lib/test-env');
const { openViaContentViewer, joinViaContentViewer } = require('../../lib/open-via-content-viewer');
// Scale patience waits by JOBS_SCALE (co-edit relay/propagation waits race
// under JOBS=2 contention). No perf-budget assertions here, so it's safe.
const sleep = ms => _rawSleep(scaleTimeout(ms));

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOCX = process.env.DOCX || path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/coedit-latejoin';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '180000', 10);
const PROPAGATE_BUDGET = parseInt(process.env.PROPAGATE_BUDGET || '120000', 10);

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
    // LO creates its hidden keyboard-input element (#clipboard-area) AFTER the
    // canvas + word count are ready. Typing before it exists focuses <body> and
    // the keystrokes are silently dropped (the co-edit typing race: count stays
    // at base). Wait for it to exist — then the click focuses it and input lands.
    const fr = editorFrame(page);
    if (fr) { try { await fr.waitForSelector('#clipboard-area', { timeout: scaleTimeout(45000) }); } catch (e) {} }
    const el = await page.$('iframe');
    const box = await el.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
    await sleep(1200);
    await page.keyboard.type(text, { delay: 60 });
}

(async () => {
    if (!fs.existsSync(DOCX)) { check('fixture present', false, DOCX); process.exit(2); }
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    try {
        // ── A creates + types UNSAVED edits before anyone joins ──
        const A = await openViaContentViewer(browser, BASE, DOCX, {
            userName: 'Early Alice', coEdit: true, iframeTimeout: 60000,
        });
        check('A: editor iframe + join link', !!A.editorFrame && !!A.joinLink);
        check('A: editor interactive', await waitInteractive(A.page, LOAD_BUDGET));
        await sleep(3000);
        const aBase = await waitCharCount(A.page, c => c >= 0, 30000);
        check('A: char count readable', aBase >= 0, 'base=' + aBase);

        await typeIntoDoc(A.page, 'EARLY99');   // 7 chars, never saved
        const aTyped = await waitCharCount(A.page, c => c >= aBase + 7, 30000);
        check('A: unsaved pre-join edits landed', aTyped >= aBase + 7, 'count=' + aTyped);
        await sleep(2000);                       // let the relay buffer the frames

        // ── B late-joins: replay must deliver A's unsaved edits ──
        const ctxB = await browser.createBrowserContext();
        const pageB = await ctxB.newPage();
        const B = await joinViaContentViewer(browser, A.joinLink, {
            page: pageB, userName: 'Late Bob', iframeTimeout: 90000,
        });
        check('B: editor iframe appeared', !!B.editorFrame);
        check('B: editor interactive', await waitInteractive(B.page, LOAD_BUDGET));
        const bConverged = await waitCharCount(B.page, c => c >= aBase + 7, PROPAGATE_BUDGET);
        check('B: converged to A\'s UNSAVED pre-join edits (replay)',
            bConverged >= aBase + 7, 'B=' + bConverged + ' expected>=' + (aBase + 7));

        // ── and stays live after the replay ──
        await typeIntoDoc(A.page, 'MORE');       // +4
        const bLive = await waitCharCount(B.page, c => c >= aBase + 11, PROPAGATE_BUDGET);
        check('B: receives live edits after replay', bLive >= aBase + 11,
            'B=' + bLive + ' expected>=' + (aBase + 11));

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
