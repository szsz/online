// Verify a LIVE content-viewer deployment end-to-end: open a doc through the
// real /collabora-tester UI against a deployed URL (no local servers).
//
// Usage: node wasm/tests/content-viewer/verify-live.js <base-url> [docx-path]
//   node wasm/tests/content-viewer/verify-live.js https://wasm-viewer-test.azurewebsites.net

'use strict';
const path = require('path');
const { launch, sleep } = require('../../lib/browser');

const BASE = (process.argv[2] || process.env.BASE_URL || '').replace(/\/+$/, '');
const DOCX = process.argv[3] || process.env.DOCX || '/home/localadmin/content-preview/dist/test.docx';
const BUDGET = parseInt(process.env.LOAD_BUDGET || '210000', 10);
if (!BASE) { console.error('usage: verify-live.js <base-url> [docx]'); process.exit(2); }

let passed = true;
const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
const check = (l, c, e) => { if (c) log(`  ✓ ${l}${e ? ' [' + e + ']' : ''}`); else { log(`  ✗ FAIL: ${l}${e ? ' [' + e + ']' : ''}`); passed = false; } };

(async () => {
    let browser;
    try {
        ({ browser } = await launch({ headless: 'new' }));
        const page = await browser.newPage();
        const errs = [];
        page.on('console', m => {
            const t = m.text();
            if (/content-viewer|local-file|Aborted|memory access|RuntimeError|unreachable/i.test(t)) log('  [page] ' + t.slice(0, 150));
            if (/Aborted|memory access out of bounds|RuntimeError|unreachable/i.test(t)) errs.push(t.slice(0, 120));
        });
        log('open ' + BASE + '/collabora-tester');
        await page.goto(`${BASE}/collabora-tester`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const coi = await page.evaluate(() => self.crossOriginIsolated);
        check('cross-origin isolated (SAB)', coi === true, 'crossOriginIsolated=' + coi);

        const input = await page.waitForSelector('input[type=file]', { timeout: 20000 });
        log('upload ' + path.basename(DOCX));
        await input.uploadFile(DOCX);
        await page.waitForFunction(() => {
            const f = document.querySelector('iframe');
            return !!(f && f.src && f.src.includes('cool.html'));
        }, { timeout: 40000 });
        check('editor iframe → cool.html', true);

        log('waiting for document load (cold, budget ' + (BUDGET / 1000) + 's)…');
        const deadline = Date.now() + BUDGET;
        let frame = null;
        while (Date.now() < deadline && !frame) { frame = page.frames().find(f => f.url().includes('cool.html')); if (!frame) await sleep(500); }
        check('editor frame acquired', !!frame);
        let cc = '';
        if (frame) {
            try {
                await frame.waitForFunction(() => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''), { timeout: deadline - Date.now() });
                cc = await frame.evaluate(() => document.querySelector('#StateWordCount')?.textContent || '');
            } catch (e) {}
        }
        check('document loaded (#StateWordCount)', /character/i.test(cc), cc.trim());
        check('no WASM abort/OOB', errs.length === 0, errs.slice(0, 2).join(' | '));
    } catch (e) {
        check('ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        if (browser) { try { await browser.close(); } catch (e) {} }
    }
    log(passed ? 'LIVE VERIFY PASSED' : 'LIVE VERIFY FAILED');
    process.exit(passed ? 0 : 1);
})();
