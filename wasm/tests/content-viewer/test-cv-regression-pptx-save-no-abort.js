// test-cv-regression-pptx-save-no-abort.js — saving a pptx after an edit
// must not abort the WASM kit.
//
// Legacy context: relay-adapter's interceptedSend used to forward
// `.uno:Save` to the kit, whose DocumentBroker forwardToChild has an
// assertion that aborts on `uno .uno:Save` → kit dead, user saw "save
// failed / only Discard". In the content viewer the user-visible save
// gesture is the tester's Save button (exports the doc); the subject
// assertion is the same: after edit + save, NO kit abort.
//
// Asserts (identical to the legacy test):
//   - no WASM_ABORT / Aborted( / Assertion-failed console line after save
//   - no "unreachable"/"abort" pageerror after save
//   - window.app still defined, Module.HEAP8 still alive
//   - slide status indicator (Slide N of M) survives the save
//
// Migrated from wasm/tests/regression/test-regression-pptx-save-no-abort.js
// — legacy version retired.
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, waitCvInteractive, cvEditorFrame } =
    require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'testdoc.pptx');
const SHOT_DIR = '/tmp/content-viewer-report/regression-pptx-save-no-abort';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  PASS: ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}`, fullPage: false }); }
    catch (_) {}
}

// Real click on the tester's Save button (parent page, not the iframe).
async function clickTesterSave(page) {
    const box = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')]
            .find(x => /^save$/i.test((x.textContent || '').trim()));
        if (!b || b.disabled) return null;
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (!box) return false;
    await page.mouse.click(box.x, box.y);
    return true;
}

(async () => {
    log('=== CV Regression: PPTX save must not abort kit ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(FIXTURE)) {
        log(`SKIP: fixture missing: ${FIXTURE}`);
        process.exit(2);
    }
    log('viewer: ' + BASE);

    const { browser } = await launch({ headless: 'new' });
    try {
        const page = await browser.newPage();

        // Capture WASM_ABORT / unreachable / assertion-failed signals —
        // attached BEFORE the doc opens so init-time aborts are visible too.
        const fatalLines = [];
        page.on('console', m => {
            const t = m.text();
            if (/WASM_ABORT|Assertion failed|Aborted\(/.test(t)) {
                fatalLines.push(t.substring(0, 300));
            }
        });
        const pageErrors = [];
        page.on('pageerror', e => pageErrors.push(e.message));

        await openViaContentViewer(browser, BASE, FIXTURE,
            { page, viewport: { width: 1280, height: 800 }, iframeTimeout: 60000 });
        if (!(await waitCvInteractive(page, LOAD_BUDGET)))
            throw new Error('doc never became interactive in content viewer');
        const frame = cvEditorFrame(page);
        if (!frame) throw new Error('editor frame never loaded');
        await frame.waitForFunction(
            () => document.querySelector('#SlideStatus')?.textContent?.includes('Slide'),
            { timeout: 60000 });
        await sleep(2000);
        await snap(page, 'loaded');

        const ifr = await page.evaluate(() => {
            const f = document.querySelector('iframe');
            if (!f) return null;
            const r = f.getBoundingClientRect();
            return { left: Math.round(r.left), top: Math.round(r.top) };
        });
        if (!ifr) throw new Error('editor iframe missing');

        // Make a visible edit so the save has something to save.
        const box = await frame.evaluate(() => {
            const c = document.querySelector('#document-canvas');
            if (!c) return null;
            const r = c.getBoundingClientRect();
            return { x: r.left, y: r.top };
        });
        if (!box) throw new Error('document canvas missing');
        await page.mouse.click(box.x + 400 + ifr.left, box.y + 200 + ifr.top);
        await sleep(500);
        await page.keyboard.type('test', { delay: 60 });
        await sleep(1500);
        await snap(page, 'edited');

        // Trigger Save via the tester's Save button — the content-viewer
        // user-visible save gesture (exports the document).
        log('--- clicking tester Save button ---');
        fatalLines.length = 0;
        pageErrors.length = 0;
        const saved = await clickTesterSave(page);
        check('tester Save button present + enabled + clicked', saved === true);
        await sleep(4000);
        await snap(page, 'after_save');

        // Assertions: no WASM abort, no unreachable pageerror, app still alive.
        check('no WASM_ABORT log line after save',
              fatalLines.length === 0,
              fatalLines[0] ? fatalLines[0].substring(0, 120) : '');
        const unreachable = pageErrors.filter(e => /unreachable|abort/i.test(e));
        check('no "unreachable" pageerror after save',
              unreachable.length === 0,
              unreachable[0] || '');

        const stillAlive = await frame.evaluate(() => ({
            hasApp:    !!window.app,
            hasMap:    !!window.app?.map,
            hasModule: !!(window.Module && window.Module.HEAP8),
            slideStatus: document.querySelector('#SlideStatus')?.textContent || '',
        }));
        check('window.app still defined after save',
              stillAlive.hasApp === true);
        check('window.Module still healthy (HEAP8 present)',
              stillAlive.hasModule === true,
              `app=${stillAlive.hasApp} map=${stillAlive.hasMap}`);
        check('slide status indicator survives save',
              /Slide\s+\d+\s+of\s+\d+/i.test(stillAlive.slideStatus),
              `"${stillAlive.slideStatus}"`);

        log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 200));
    } finally {
        try { await browser.close(); } catch (_) {}
    }

    process.exit(allPassed ? 0 : 1);
})();
