// test-cv-regression-docname-switch.js — opening a different document must
// update the displayed file name.
//
// Legacy subject: the OLD viewer's title bar (#document-name-input inside
// cool.html) kept showing the previous doc's name after a hot-switch,
// because BaseFileName was only set from the WOPISrc query param at load
// time. The content-viewer equivalent of that visible surface is the
// TESTER's filename label in the page header (the tester shows the open
// file's name; the editor iframe has no title bar of its own here).
//
// CV port (per migration guidance): open doc A, then open doc B on the SAME
// tester page (a second upload through the same file <input> — the real
// "open another document" flow), and assert:
//   1. After opening A, the tester header shows A's file name.
//   2. After opening B, the label updates to B's name (THE BUG) and A's
//      name is gone.
//   3. The editor is interactive again after the switch (doc B usable).
//
// The legacy test's second scenario (prewarm blank → A → B via the viewer
// sidebar) is legacy-viewer machinery (prewarm/shield/sidebar) with no CV
// equivalent — not ported.
//
// Migrated from wasm/tests/regression/test-regression-docname-switch.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-docname-switch.js [base-url]

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, waitCvInteractive } = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const SWITCH_BUDGET = 150000;
const DOC_A = 'cv-docname-A.docx';
const DOC_B = 'cv-docname-B.docx';
const SHOT_DIR = '/tmp/content-viewer-report/regression-docname-switch';

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
let shotN = 0;
async function snap(page, name) {
    try { fs.mkdirSync(SHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${SHOT_DIR}/${String(++shotN).padStart(2, '0')}_${name}.png` }); } catch (e) {}
}

// The tester's filename label lives in the TOP page (outside the iframe);
// body.innerText does not include iframe content, so this reads exactly the
// tester chrome the user sees.
async function headerShows(page, name) {
    return page.evaluate(n => (document.body.innerText || '').includes(n), name)
        .catch(() => false);
}

// "doc B is interactive after the switch" — proved at the EDITOR level rather
// than through the tester-host Save button. On a same-page 2nd upload the
// tester reuses its single iframe and re-points its src at doc B; the editor
// re-navigates and loads B. We assert the LIVE editor frame is now doc B's URL
// (not the stale doc-A frame) AND it has rendered B's content (#StateWordCount
// reports a character count) — the editor-side equivalent of "spinner gone +
// document loaded", independent of the host handshake. The frame is
// re-resolved every poll so it survives the re-navigation.
async function waitDocFrameReady(page, docName, budgetMs) {
    const d = Date.now() + budgetMs;
    while (Date.now() < d) {
        const ok = await page.evaluate((name) => {
            const frames = [];
            // Puppeteer frame list isn't reachable from page.evaluate; inspect
            // the iframe element's current src + the doc it points at.
            const el = document.querySelector('iframe');
            return el && el.src && el.src.includes('cool.html') &&
                el.src.includes(name);
        }, docName).catch(() => false);
        if (ok) {
            // The iframe points at doc B; now confirm the live frame rendered
            // its content (character count present).
            const fr = page.frames().find(f =>
                (f.url() || '').includes('cool.html') && (f.url() || '').includes(docName));
            if (fr) {
                const rendered = await fr.evaluate(() =>
                    /\d+\s+character/i.test(
                        document.querySelector('#StateWordCount')?.textContent || ''))
                    .catch(() => false);
                if (rendered) return true;
            }
        }
        await sleep(500);
    }
    return false;
}

(async () => {
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
    log('=== Regression: file name label updates on doc switch (content viewer) ===');
    log('viewer: ' + BASE);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-docname-'));
    const bytes = fs.readFileSync(FIXTURE);
    const pathA = path.join(dir, DOC_A);
    const pathB = path.join(dir, DOC_B);
    fs.writeFileSync(pathA, bytes);
    fs.writeFileSync(pathB, bytes);

    const { browser } = await launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        await openViaContentViewer(browser, BASE, pathA, {
            page, viewport: { width: 1280, height: 900 }, iframeTimeout: 45000,
        });
        check('doc A interactive', await waitCvInteractive(page, LOAD_BUDGET));
        await sleep(1000);
        await snap(page, 'doc_A');

        check(`Doc A: tester header shows "${DOC_A}"`,
            await headerShows(page, DOC_A));

        const srcBefore = await page.evaluate(() =>
            document.querySelector('iframe') ? document.querySelector('iframe').src : '');

        // ── Open doc B on the SAME tester page: second upload through the
        //    same file <input> — the real "open another document" flow.
        log('--- Opening doc B on the same tester page (2nd upload) ---');
        const input = await page.waitForSelector('input[type=file]', { timeout: 20000 });
        await input.uploadFile(pathB);

        // Wait for the label to flip to B's name.
        let labelB = false;
        const d = Date.now() + SWITCH_BUDGET;
        while (Date.now() < d) {
            if (await headerShows(page, DOC_B)) { labelB = true; break; }
            await sleep(500);
        }
        check(`Doc B: tester filename label updated to "${DOC_B}" (THE BUG)`,
            labelB, labelB ? '' : 'label never showed the new name');
        check(`Doc B: old name "${DOC_A}" no longer shown`,
            !(await headerShows(page, DOC_A)));

        // The editor must be usable on the new doc too. Prove it at the editor
        // level: the live iframe re-navigated to doc B and rendered B's content
        // (the tester-host Save button is not a reliable signal for a same-page
        // switch — it re-arms only on the host's document-loaded handshake).
        check('doc B interactive after switch',
            await waitDocFrameReady(page, DOC_B, SWITCH_BUDGET));
        const srcAfter = await page.evaluate(() =>
            document.querySelector('iframe') ? document.querySelector('iframe').src : '');
        log(`iframe src before/after switch:\n  ${srcBefore}\n  ${srcAfter}`);
        await snap(page, 'doc_B');
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
