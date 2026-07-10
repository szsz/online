// test-cv-regression-pptx-transitions-iconview.js — the Impress Transition
// tab's iconview must show clickable transition tiles (Fade, Wipe, Cover, …),
// not invisible 2-pixel strips, in the content viewer.
//
// Root cause history: Notebookbar.ImpressTransitionTab.ts created the
// transitions iconview with 29 `ondemand: true` entries without
// width/height; setupSize() in Widget.IconView.ts was a no-op, so each
// entry collapsed to a 2-pixel flat strip and the ribbon looked empty.
//
// Asserts (identical to the legacy test):
//   - Transition tab present + clickable
//   - transitions iconview container exists, >= 20 entry slots
//   - first 5 entries each have rendered height >= 30 px
//   - at least 1 of the first 5 entries shows an image or title
//
// Migrated from wasm/tests/regression/test-regression-pptx-transitions-iconview.js
// — legacy version retired.
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, waitCvInteractive, cvEditorFrame } =
    require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'testdoc.pptx');
const SHOT_DIR = '/tmp/content-viewer-report/regression-pptx-transitions-iconview';
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

(async () => {
    log('=== CV Regression: PPTX Transitions iconview tiles render ===');
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
        await openViaContentViewer(browser, BASE, FIXTURE,
            { page, viewport: { width: 1280, height: 800 }, iframeTimeout: 60000 });
        if (!(await waitCvInteractive(page, LOAD_BUDGET)))
            throw new Error('doc never became interactive in content viewer');
        const frame = cvEditorFrame(page);
        if (!frame) throw new Error('editor frame never loaded');
        await sleep(3000);
        await snap(page, 'loaded');

        // Iframe offset in the tester page — page.mouse clicks need it.
        const ifr = await page.evaluate(() => {
            const f = document.querySelector('iframe');
            if (!f) return null;
            const r = f.getBoundingClientRect();
            return { left: Math.round(r.left), top: Math.round(r.top) };
        });
        if (!ifr) throw new Error('editor iframe missing');

        // Switch to the Transitions tab via a REAL bounding-box mouse click.
        const tabBox = await frame.evaluate(() => {
            const b = document.getElementById('Transition-tab-label');
            if (!b) return null;
            const r = b.getBoundingClientRect();
            return { x: r.left, y: r.top, w: r.width, h: r.height };
        });
        check('Transition tab present + clickable', !!tabBox, tabBox ? '' : 'no tab');
        if (tabBox) {
            await page.mouse.click(tabBox.x + tabBox.w / 2 + ifr.left,
                                   tabBox.y + tabBox.h / 2 + ifr.top);
        }
        await sleep(2500);
        await snap(page, 'transition_tab');

        // Capture entry dimensions for the first 5 tiles.
        const entries = await frame.evaluate(() => {
            const cont = document.getElementById('transitions_icons');
            if (!cont) return { exists: false };
            const els = cont.querySelectorAll('.ui-iconview-entry');
            const out = [];
            for (let i = 0; i < Math.min(els.length, 5); i++) {
                const r = els[i].getBoundingClientRect();
                out.push({
                    id: els[i].id,
                    width: Math.round(r.width),
                    height: Math.round(r.height),
                    title: els[i].getAttribute('title') ||
                           els[i].firstElementChild?.getAttribute('title') || '',
                    childInnerHTML: (els[i].innerHTML || '').substring(0, 80),
                });
            }
            return { exists: true, total: els.length, firstFive: out };
        });
        log(`entries: ${JSON.stringify(entries)}`);

        check('transitions iconview container exists',
              entries.exists === true);
        check('transitions iconview has at least 20 entry slots',
              entries.exists && entries.total >= 20,
              `total=${entries.total}`);

        // The bug: each entry has height 2 px. Real tiles need >= 30 px
        // to be clickable and recognisable.
        if (entries.firstFive) {
            for (const e of entries.firstFive) {
                check(`entry ${e.id} height ≥ 30 px`,
                      e.height >= 30,
                      `h=${e.height}px w=${e.width}px`);
            }
            // Also: tiles should have visible title (transition name)
            // OR the placeholder should have been replaced with <img>.
            const haveContent = entries.firstFive.filter(e =>
                /\<img/i.test(e.childInnerHTML) ||
                (e.title && e.title.length > 0));
            check('at least 1 of the first 5 entries shows an image or title',
                  haveContent.length >= 1,
                  `${haveContent.length}/5 have content`);
        }

        log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 200));
    } finally {
        try { await browser.close(); } catch (_) {}
    }

    process.exit(allPassed ? 0 : 1);
})();
