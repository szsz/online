// test-regression-writer-navigator-flash.js
//
// Regression: clicking the floating Navigator icon in Writer no longer
// opens the panel for only a single frame and then closes it.
//
// Pre-fix bug: `Control.NavigatorPanel.createFloatingNavigatorBtn` was
// called from `initializeImpl`, which fires twice on cold open (once
// from TileLayer.beforeAdd, once from Socket._onStatusMsg). Without
// a guard each call attached another `click` listener to the same
// `#navigator-floating-icon` DOM element. A single user click then
// dispatched `.uno:Navigator` twice — the kit treats the UNO command
// as a toggle, so two toggles netted to "panel open then immediately
// closed". User-visible symptom: "Navigator only flashes."
//
// Fix: track a `floatingIconClickBound` flag on the panel instance and
// add the listener at most once.
//
// E2E shape (per /write-test discipline — drive through visible UI,
// verify visible outcome):
//   1. Open a docx.
//   2. Click the floating Navigator icon the user clicks
//      (`#navigator-floating-icon button#floating-navigator`).
//   3. Wait long enough that any double-dispatch would have closed
//      the panel (~2 s — kit round-trip + onNavigator handler).
//   4. Assert `#navigation-sidebar` is visible AND `app.showNavigator`
//      is true. Both checks: the DOM (what the user sees) and the
//      logical state (what the next UNO dispatch would observe).
//
// On the pre-fix build redPx-equivalent fails: the panel is gone or
// hidden after step 3. On the post-fix build the panel stays open.

'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const __cl = require('../../lib/inject-checklist');
const env = require('../../lib/test-env');
const { openViaViewer } = require('../../lib/open-via-viewer');

const VIEWER = env.FILE_STORAGE_URL;
const DOC_NAME = 'navigator-flash-test.docx';
const DOC_PATH = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-writer-navigator-flash';

const T0 = Date.now();
const log = (m) => console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch (_) {}
}

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

(async () => {
    log('=== Regression: Writer Navigator does not flash ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(DOC_PATH)) {
        log('ERROR: fixture missing: ' + DOC_PATH);
        process.exit(1);
    }

    const browser = await puppeteer.launch({
        headless: 'new',
        protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    try {
        const bytes = fs.readFileSync(DOC_PATH);
        const up = await openViaViewer(browser, VIEWER, DOC_NAME, bytes, {
            iframeTimeout: env.scaleTimeout(120000),
            gotoTimeout: env.scaleTimeout(60000),
            isolatedContext: true,
        });
        const frame = up.editorFrame;

        // Wait for the doc to be loaded — use the SAME gate that fires
        // overlay-hide (`__wasmInitialDocLoaded` flips in fireDocReady).
        // `#StateWordCount` populates earlier (when LO emits the
        // first state message), but the loading overlay only fades on
        // fireDocReady. Without this wait, the loading overlay is still
        // up at click time → Puppeteer's mouse-click lands on the
        // overlay z-index:999999 rather than on the Navigator button,
        // the click handler never fires, and the test fails with a
        // misleading "panel never opened" signature.
        await frame.waitForFunction(() => window.__wasmInitialDocLoaded === true,
            { timeout: env.scaleTimeout(120000) });
        // Also wait for the StateWordCount to fully populate so the
        // editor has done its first paint pass.
        await frame.waitForFunction(() => {
            const wc = document.querySelector('#StateWordCount');
            return !!(wc && wc.textContent && wc.textContent.includes('characters'));
        }, { timeout: env.scaleTimeout(30000) });
        // Belt-and-braces: ensure the loading overlay has finished its
        // 400 ms opacity fade + 500 ms removeChild timeout before clicking.
        await sleep(env.scaleTimeout(1000));
        log('Editor ready');
        await snap(frame.page(), 'doc_open');

        // Wait for the floating Navigator icon to render (it appears
        // after the editor's specialized-UI init completes; can take a
        // beat on cold open).
        await frame.waitForSelector(
            '#navigator-floating-icon button#floating-navigator',
            { visible: true, timeout: env.scaleTimeout(20000) });
        log('Floating Navigator icon visible');
        await snap(frame.page(), 'icon_ready');

        // Click it through the visible button. This is the user-visible
        // surface (same selector the user clicks).
        await frame.click('#navigator-floating-icon button#floating-navigator');
        log('Clicked floating Navigator icon');

        // Settle: kit dispatches `.uno:Navigator`, sends back the
        // 'navigator' event with children, COOL renders the panel, then
        // (pre-fix) the second listener dispatched another `.uno:Navigator`
        // → kit toggled OFF → action=close → panel closes. 2 s patience
        // covers the kit round-trip plus an extra beat. scaleTimeout
        // widens under JOBS_SCALE.
        await sleep(env.scaleTimeout(2000));
        await snap(frame.page(), 'after_settle');

        // Verify panel is still visible (visible-outcome assertion).
        const state = await frame.evaluate(() => {
            const sidebar = document.getElementById('navigation-sidebar');
            const visibleClass = sidebar ? sidebar.classList.contains('visible') : false;
            const computed = sidebar
                ? window.getComputedStyle(sidebar).display !== 'none'
                : false;
            const rect = sidebar ? sidebar.getBoundingClientRect() : null;
            return {
                exists: !!sidebar,
                hasVisibleClass: visibleClass,
                displayedInCSS: computed,
                widthPx: rect ? rect.width : 0,
                showNavigatorState: !!(window.app && window.app.showNavigator),
            };
        });
        log(`State after settle: ${JSON.stringify(state)}`);

        check('navigation-sidebar element exists in DOM',
              state.exists, 'exists=' + state.exists);
        check('navigation-sidebar is visible after click (no flash-close)',
              state.hasVisibleClass && state.displayedInCSS && state.widthPx > 100,
              'visibleClass=' + state.hasVisibleClass +
              ' display=' + state.displayedInCSS +
              ' width=' + state.widthPx);
        check('app.showNavigator state is true (next toggle would close, not open)',
              state.showNavigatorState,
              'showNavigator=' + state.showNavigatorState);

        log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    } catch (e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        await browser.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
