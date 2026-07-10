// test-cv-regression-writer-navigator-flash.js — clicking the floating
// Navigator icon in Writer opens the panel and it STAYS open (no flash-close).
//
// Pre-fix bug: Control.NavigatorPanel.createFloatingNavigatorBtn was called
// from initializeImpl, which fires twice on cold open — without a guard each
// call attached another click listener to #navigator-floating-icon. A single
// user click dispatched .uno:Navigator twice; the kit treats it as a toggle,
// so the panel opened then immediately closed ("Navigator only flashes").
// Fix: floatingIconClickBound flag → listener added at most once.
//
// WHAT IS VERIFIED (same subject as the legacy test):
//   1. Click the floating Navigator icon the user clicks
//      (#navigator-floating-icon button#floating-navigator).
//   2. Wait ~2.5 s — long enough for any double-dispatch to have closed it.
//   3. #navigation-sidebar exists, is visible (class + computed display +
//      width > 100 px) AND app.showNavigator is true.
//
// Migrated from wasm/tests/regression/test-regression-writer-navigator-flash.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-writer-navigator-flash.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, waitCvInteractive } = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOCX = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const SHOT_DIR = '/tmp/content-viewer-report/regression-writer-navigator-flash';

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
const editorFrame = page => page.frames().find(f => (f.url() || '').includes('cool.html'));
let shotN = 0;
async function snap(page, name) {
    try { fs.mkdirSync(SHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${SHOT_DIR}/${String(++shotN).padStart(2, '0')}_${name}.png` }); } catch (e) {}
}

(async () => {
    if (!fs.existsSync(DOCX)) { check('fixture present', false, DOCX); process.exit(2); }
    log('=== Regression: Writer Navigator does not flash (content viewer) ===');
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        await openViaContentViewer(browser, BASE, DOCX, {
            page, viewport: { width: 1280, height: 900 }, iframeTimeout: 45000,
        });
        check('editor interactive', await waitCvInteractive(page, LOAD_BUDGET));
        const frame = editorFrame(page);
        if (!frame) throw new Error('editor frame never appeared');

        // Wait for the first paint pass (StateWordCount populated), then a
        // settle beat so any loading overlay has fully faded — without this
        // the click can land on overlay chrome instead of the button.
        await frame.waitForFunction(() => {
            const wc = document.querySelector('#StateWordCount');
            return !!(wc && wc.textContent && wc.textContent.includes('characters'));
        }, { timeout: 60000 });
        await sleep(1500);
        log('Editor ready');
        await snap(page, 'doc_open');

        // Wait for the floating Navigator icon to render (appears after the
        // editor's specialized-UI init; can take a beat on cold open).
        await frame.waitForSelector(
            '#navigator-floating-icon button#floating-navigator',
            { visible: true, timeout: 30000 });
        log('Floating Navigator icon visible');
        await snap(page, 'icon_ready');

        // Click it via a REAL mouse click at page coordinates (same-origin
        // iframe → iframe box + element rect).
        const rect = await frame.evaluate(() => {
            const el = document.querySelector('#navigator-floating-icon button#floating-navigator');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        if (!rect) throw new Error('floating Navigator button rect unreadable');
        const ifEl = await page.$('iframe');
        const ifBox = await ifEl.boundingBox();
        await page.mouse.click(ifBox.x + rect.x, ifBox.y + rect.y);
        log('Clicked floating Navigator icon');

        // Settle: kit dispatches .uno:Navigator, panel renders; pre-fix the
        // second listener toggled it straight back closed. 2.5 s covers the
        // kit round-trip plus an extra beat.
        await sleep(2500);
        await snap(page, 'after_settle');

        // Verify the panel is STILL visible (visible-outcome assertion).
        const state = await frame.evaluate(() => {
            const sidebar = document.getElementById('navigation-sidebar');
            const visibleClass = sidebar ? sidebar.classList.contains('visible') : false;
            const computed = sidebar
                ? window.getComputedStyle(sidebar).display !== 'none'
                : false;
            const r = sidebar ? sidebar.getBoundingClientRect() : null;
            return {
                exists: !!sidebar,
                hasVisibleClass: visibleClass,
                displayedInCSS: computed,
                widthPx: r ? r.width : 0,
                showNavigatorState: !!(window.app && window.app.showNavigator),
            };
        });
        log('State after settle: ' + JSON.stringify(state));

        check('navigation-sidebar element exists in DOM',
            state.exists, 'exists=' + state.exists);
        check('navigation-sidebar is visible after click (no flash-close)',
            state.hasVisibleClass && state.displayedInCSS && state.widthPx > 100,
            'visibleClass=' + state.hasVisibleClass
            + ' display=' + state.displayedInCSS + ' width=' + state.widthPx);
        check('app.showNavigator state is true (next toggle would close, not open)',
            state.showNavigatorState, 'showNavigator=' + state.showNavigatorState);
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
