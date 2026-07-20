// test-cv-singleuser.js — single-user editing flows through the Tresorit
// content-viewer (/collabora-tester), adapted from tests/misc/
// test-singleuser-copy-paste.js.
//
// Drives the real content-viewer UI (no backend): open a .docx via the file
// <input>, then exercise the single-user contract that the content-viewer
// exposes — type, copy/paste (internal + external), Save (content-preview's
// Save button → exportCurrentDocument → browser download), a re-open of the
// downloaded file to prove the edits persisted, and the edit/readonly toggle.
//
// The editor iframe is same-origin to the content-viewer (SW-proxied), so we
// read #StateWordCount from it and drive keyboard/clipboard exactly like the
// original single-user test. Save/readonly go through content-preview's own
// toolbar buttons (the ones that were disabled by the "stuck loading" bug).
//
// Usage: node wasm/tests/content-viewer/test-cv-singleuser.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer } = require('../../lib/open-via-content-viewer');
// Patience timeouts here use the test's OWN waiters (not the scaled helper),
// so widen them by JOBS_SCALE for the shared-Azure contention in CI.
const { scaleTimeout } = require('../../lib/test-env');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOCX = process.env.DOCX
    || path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const DL_DIR = '/tmp/cv-downloads';
const SHOT_DIR = '/tmp/content-viewer-report/singleuser';
const LOAD_BUDGET = scaleTimeout(parseInt(process.env.LOAD_BUDGET || '150000', 10));

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

function editorFrame(page) { return page.frames().find(f => (f.url() || '').includes('cool.html')); }
async function getCharCount(page) {
    const fr = editorFrame(page);
    if (!fr) return -1;
    const t = await fr.evaluate(() => document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
    const m = t.match(/([\d,]+)\s*character/);
    return m ? parseInt(m[1].replace(/,/g, '')) : -1;
}
// content-viewer reaches uiState==='loaded' → the spinner is gone and Save is
// enabled. Same probe as the snapshot test.
async function interactive(page) {
    return page.evaluate(() => {
        if (document.querySelector('[role="status"][aria-label="Loading"]')) return false;
        const s = [...document.querySelectorAll('button')].find(b => /^save$/i.test((b.textContent || '').trim()));
        return !!(s && !s.disabled);
    }).catch(() => false);
}
async function waitInteractive(page, budget) {
    const d = Date.now() + budget;
    while (Date.now() < d) { if (await interactive(page)) return true; await sleep(500); }
    return false;
}
async function clickButton(page, re) {
    const h = await page.evaluateHandle((src) => {
        const rx = new RegExp(src, 'i');
        return [...document.querySelectorAll('button')].find(b => rx.test((b.textContent || '').trim()));
    }, re.source);
    const el = h.asElement();
    if (el) { await el.click(); return true; }
    return false;
}
async function buttonText(page, reMatch) {
    return page.evaluate((src) => {
        const rx = new RegExp(src, 'i');
        const b = [...document.querySelectorAll('button')].find(x => rx.test((x.textContent || '').trim()));
        return b ? (b.textContent || '').trim() : '';
    }, reMatch.source).catch(() => '');
}
async function focusDoc(page) {
    const el = await page.$('iframe');
    const box = el && await el.boundingBox();
    if (!box) return false;
    await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.55, 450));
    await sleep(250);
    return true;
}
async function ctrl(page, key) { await page.keyboard.down('Control'); await page.keyboard.press(key); await page.keyboard.up('Control'); await sleep(200); }
async function ctrlEnd(page) { await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control'); await sleep(150); }
async function waitCharAtLeast(page, n, ms = 10000) { const d = Date.now() + scaleTimeout(ms); while (Date.now() < d) { if (await getCharCount(page) >= n) return true; await sleep(200); } return false; }
async function writeClip(page, text) {
    try { await page.evaluate(t => navigator.clipboard.writeText(t), text); } catch (e) {
        const fr = editorFrame(page); if (fr) await fr.evaluate(t => navigator.clipboard.writeText(t), text).catch(() => {});
    }
    await sleep(200);
}

(async () => {
    fs.rmSync(DL_DIR, { recursive: true, force: true }); fs.mkdirSync(DL_DIR, { recursive: true });
    if (!fs.existsSync(DOCX)) { check('fixture present', false, DOCX); process.exit(2); }
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        const cdp = await page.target().createCDPSession();
        try { await cdp.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }); } catch (e) {}
        try { await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_DIR, eventsEnabled: true }); } catch (e) {}
        page.on('console', m => { const t = m.text(); if (/error|abort|paste|clipboard/i.test(t)) log('  [page] ' + t.slice(0, 140)); });

        log('open writer via /collabora-tester');
        await openViaContentViewer(browser, BASE, DOCX, { page, iframeTimeout: 45000 });
        check('editor became interactive (Save enabled)', await waitInteractive(page, LOAD_BUDGET));
        // waitInteractive returns on the viewer's loaded-state, which precedes
        // the editor canvas + #StateWordCount rendering. Poll for the count to
        // become readable rather than a fixed sleep (fixes the flaky base=-1
        // race on the slow CI open).
        const baseReady = await waitCharAtLeast(page, 0, 30000);
        // Render being readable (word count present) precedes the canvas being
        // ready to accept keystrokes; give a settle so the first type() lands
        // (without it the count-readable poll can return ~1s in and the typing
        // race — keystrokes dropped, count stuck at base — resurfaces).
        await sleep(2500);
        await snap(page, 'opened');
        const base = await getCharCount(page);
        check('char count readable after open', baseReady && base >= 0, 'base=' + base);

        // Case 1 — type.
        await focusDoc(page); await ctrlEnd(page);
        await page.keyboard.type('ABC', { delay: 40 });
        check('type ABC (+3)', await waitCharAtLeast(page, base + 3), 'got=' + await getCharCount(page));
        await snap(page, 'typed');

        // Case 2 — select-all → copy → end → paste (doubles).
        await ctrl(page, 'a'); await ctrl(page, 'c'); await ctrlEnd(page); await ctrl(page, 'v');
        check('select-all/copy/paste doubled', await waitCharAtLeast(page, (base + 3) * 2 - 1), 'got=' + await getCharCount(page));
        await snap(page, 'pasted');

        // Case 3 — external clipboard text sentinel.
        await ctrlEnd(page);
        const SENT = 'CVPASTE12345';
        const b3 = await getCharCount(page);
        await writeClip(page, SENT);
        await focusDoc(page); await ctrl(page, 'v');
        check('external clipboard text paste grew doc', await waitCharAtLeast(page, b3 + SENT.length), 'got=' + await getCharCount(page));
        await snap(page, 'external_paste');

        const editedCount = await getCharCount(page);

        // Case 4 — Save round-trip through content-preview's Save button.
        log('save via content-preview Save button');
        const clicked = await clickButton(page, /^save$/);
        check('Save button clickable', clicked);
        // Wait for the downloaded file to appear + settle.
        let dl = null;
        const dlDeadline = Date.now() + scaleTimeout(30000);
        while (Date.now() < dlDeadline && !dl) {
            const files = fs.readdirSync(DL_DIR).filter(f => /\.docx$/i.test(f) && !f.endsWith('.crdownload'));
            if (files.length) { const f = path.join(DL_DIR, files[0]); if (fs.statSync(f).size > 0) dl = f; }
            await sleep(500);
        }
        check('Save produced a downloaded .docx', !!dl, dl ? (fs.statSync(dl).size + ' bytes') : 'no file');

        // Case 5 — re-open the downloaded file, confirm edits persisted.
        if (dl) {
            const page2 = await browser.newPage();
            const cdp2 = await page2.target().createCDPSession();
            try { await cdp2.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite'] }); } catch (e) {}
            await openViaContentViewer(browser, BASE, dl, { page: page2, iframeTimeout: 45000 });
            check('re-opened saved file became interactive', await waitInteractive(page2, LOAD_BUDGET));
            // Poll for the reopened doc to actually render its content (the
            // viewer flips to loaded before the canvas + word count appear on
            // the slow CI reopen; a fixed sleep read reopened=-1). Reaching the
            // persisted total both waits out the render AND asserts the edits
            // survived; a genuine data-loss would never reach it and still fail.
            const persisted = await waitCharAtLeast(page2, editedCount - 2, 45000);
            const reCount = await getCharCount(page2);
            check('saved file preserved the edits (char count persisted)',
                persisted, 'edited=' + editedCount + ' reopened=' + reCount);
            await snap(page2, 'reopened');
            try { await page2.close(); } catch (e) {}
        }

        // Case 6 — readonly toggle (content-preview "Switch to view").
        const before = await buttonText(page, /switch to (view|edit)/);
        await clickButton(page, /switch to view/);
        await sleep(1500);
        const after = await buttonText(page, /switch to (view|edit)/);
        check('permission toggle flips button (edit⇄view)', /switch to edit/i.test(after) && before !== after,
            'before="' + before + '" after="' + after + '"');
        await snap(page, 'readonly');
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
