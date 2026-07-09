// test-cv-multiopen.js — opening more than one document per browser session
// must work in the content-viewer.
//
// The editor iframe can re-navigate mid-load (warm-restore reload); a listener
// bound to the pre-reload app.map goes stale, so before the fix only the FIRST
// editor opened in a browser reached the interactive/'loaded' state — every
// subsequent open rendered the doc but left content-preview stuck "loading"
// (Save disabled, host never told document-loaded). This opens several docs in
// one browser and asserts each becomes interactive:
//   A: first (cold)
//   B: second, with A's page still open
//   C: third, after closing A + B (fresh page)
//
// Usage: node wasm/tests/content-viewer/test-cv-multiopen.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer } = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const SRC = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const WORK = '/tmp/cv-multiopen-test';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '120000', 10);

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
async function interactive(page) {
    return page.evaluate(() => {
        if (document.querySelector('[role="status"][aria-label="Loading"]')) return false;
        const s = [...document.querySelectorAll('button')].find(b => /^save$/i.test((b.textContent || '').trim()));
        return !!(s && !s.disabled);
    }).catch(() => false);
}
async function waitI(page, budget) {
    const d = Date.now() + budget;
    while (Date.now() < d) { if (await interactive(page)) return true; await sleep(500); }
    return false;
}

(async () => {
    if (!fs.existsSync(SRC)) { check('source fixture present', false, SRC); process.exit(2); }
    fs.rmSync(WORK, { recursive: true, force: true }); fs.mkdirSync(WORK, { recursive: true });
    const bytes = fs.readFileSync(SRC);
    const mk = n => { const p = path.join(WORK, n); fs.writeFileSync(p, bytes); return p; };
    log('viewer: ' + BASE);

    const { browser } = await launch({ headless: 'new' });
    try {
        const p1 = await browser.newPage();
        await openViaContentViewer(browser, BASE, mk('one.docx'), { page: p1, iframeTimeout: 45000 });
        check('1st open interactive', await waitI(p1, LOAD_BUDGET));

        const p2 = await browser.newPage();
        await openViaContentViewer(browser, BASE, mk('two.docx'), { page: p2, iframeTimeout: 45000 });
        check('2nd open interactive (1st page still open)', await waitI(p2, LOAD_BUDGET));

        try { await p1.close(); } catch (e) {}
        try { await p2.close(); } catch (e) {}
        const p3 = await browser.newPage();
        await openViaContentViewer(browser, BASE, mk('three.docx'), { page: p3, iframeTimeout: 45000 });
        check('3rd open interactive (after closing 1st+2nd)', await waitI(p3, LOAD_BUDGET));
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 200));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
