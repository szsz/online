// test-cv-regression-impress-transition-click.js — clicking a transition
// tile in the Impress Transitions tab must APPLY the transition (not just
// select the tile) in the content viewer.
//
// Root cause history: the transitions iconview lacked `singleclickactivate`,
// so a single click only fired the 'select' builderCallback and never the
// 'activate' that propagates the transition apply to the kit.
//
// Asserts (identical to the legacy test):
//   - iconview populated with >= 20 visible tiles (h >= 30 px)
//   - clicked tile picks up the `.selected` class
//   - >= 2 kit-bound `dialogevent ... transitions_icons` console messages
//     after the click (select + activate)
//   - the two dialogevents have distinct lengths (different cmd values)
//
// Migrated from wasm/tests/regression/test-regression-impress-transition-click.js
// — legacy version retired.
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, waitCvInteractive, cvEditorFrame } =
    require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'testdoc.pptx');
const SHOT_DIR = '/tmp/content-viewer-report/regression-impress-transition-click';
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

// Real Puppeteer click on an in-frame element by id: read the bounding box
// via frame.evaluate (a DOM-state READ, not a synthetic click), then drive
// page.mouse.click at its centre plus the tester-page iframe offset.
async function realClickById(page, frame, id, ifr) {
    const box = await frame.evaluate((id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
    }, id);
    if (!box) throw new Error(`element #${id} not found`);
    await page.mouse.click(box.x + box.w / 2 + ifr.left, box.y + box.h / 2 + ifr.top);
    return box;
}

(async () => {
    log('=== CV Regression: PPTX Transition click applies transition ===');
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

        // Capture relay outbound UNO traffic to prove the activation
        // reached the kit. relay-adapter logs all outbound `uno .uno:...`
        // and iconview activate messages on the console. Attach BEFORE the
        // document opens so nothing is missed.
        const unoOutbound = [];
        const allMsgsAfterClick = [];
        let captureAll = false;
        page.on('console', m => {
            const t = m.text();
            if (captureAll) allMsgsAfterClick.push(t.substring(0, 240));
            // Outbound iconview events from the notebookbar reach the kit
            // as `dialogevent ... {"id":"transitions_icons", "cmd":"activate"}`.
            // Pre-fix: only the 'select' dialogevent appears. Post-fix
            // (singleclickactivate:true): both 'select' AND 'activate'
            // fire. The 'activate' is the one that applies the transition.
            if (/dialogevent.*transitions_icons|\.uno:SlideChange|\.uno:.*[Tt]ransition/i.test(t)) {
                unoOutbound.push(t.substring(0, 300));
            }
        });
        const setCaptureAll = (v) => { captureAll = v; };

        await openViaContentViewer(browser, BASE, FIXTURE,
            { page, viewport: { width: 1280, height: 800 }, iframeTimeout: 60000 });
        if (!(await waitCvInteractive(page, LOAD_BUDGET)))
            throw new Error('doc never became interactive in content viewer');
        const frame = cvEditorFrame(page);
        if (!frame) throw new Error('editor frame never loaded');
        await sleep(3000);
        await snap(page, 'loaded');

        const ifr = await page.evaluate(() => {
            const f = document.querySelector('iframe');
            if (!f) return null;
            const r = f.getBoundingClientRect();
            return { left: Math.round(r.left), top: Math.round(r.top) };
        });
        if (!ifr) throw new Error('editor iframe missing');

        // 1. Real-click the Transition tab.
        log('--- Real-click Transition tab ---');
        await realClickById(page, frame, 'Transition-tab-label', ifr);
        await sleep(2500);
        await snap(page, 'transition_tab_open');

        // 2. Confirm the iconview is populated (tile-rendering fix is the
        //    precondition for this test).
        const tiles = await frame.evaluate(() => {
            const cont = document.getElementById('transitions_icons');
            if (!cont) return null;
            const els = cont.querySelectorAll('.ui-iconview-entry');
            const rows = [];
            for (let i = 0; i < els.length; i++) {
                const r = els[i].getBoundingClientRect();
                rows.push({
                    id: els[i].id,
                    x: Math.round(r.left),
                    y: Math.round(r.top),
                    w: Math.round(r.width),
                    h: Math.round(r.height),
                    selected: els[i].classList.contains('selected'),
                });
            }
            return rows;
        });
        check('iconview populated with >= 20 visible tiles',
              tiles && tiles.length >= 20 && tiles.every(t => t.h >= 30),
              `n=${tiles?.length} avgH=${
                  tiles ? (tiles.reduce((s,t)=>s+t.h,0)/tiles.length).toFixed(0) : '?'}`);
        if (!tiles || tiles.length < 3) {
            log('CANNOT PROCEED: insufficient tiles');
            allPassed = false;
            log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
            process.exit(allPassed ? 0 : 1);
        }

        // 3. Pick a non-first tile (skip "None" which is row 0).
        const targetIdx = Math.min(2, tiles.length - 1);
        const target = tiles[targetIdx];
        log(`Picked tile #${targetIdx}: id=${target.id} bbox=${target.x},${target.y} ${target.w}x${target.h}`);

        // 4. Real puppeteer mouse click on the tile's centre (+ iframe offset).
        unoOutbound.length = 0;
        allMsgsAfterClick.length = 0;
        setCaptureAll(true);
        log('--- Real-click transition tile ---');
        await page.mouse.click(target.x + target.w / 2 + ifr.left,
                               target.y + target.h / 2 + ifr.top);
        await sleep(3000);
        setCaptureAll(false);
        await snap(page, 'after_tile_click');
        log(`(broad capture: ${allMsgsAfterClick.length} lines in 3s window)`);
        allMsgsAfterClick.slice(0, 15).forEach(m => log(`  ALL| ${m}`));

        // 5. Tile should now be .selected — proves the click handler fired.
        const postClick = await frame.evaluate((idx) => {
            const cont = document.getElementById('transitions_icons');
            if (!cont) return null;
            const els = cont.querySelectorAll('.ui-iconview-entry');
            const el = els[idx];
            return { selected: el?.classList.contains('selected') === true,
                     id: el?.id };
        }, targetIdx);
        check(`tile #${targetIdx} (${postClick?.id}) is .selected after click`,
              postClick?.selected === true);

        // 6. The activation must reach the kit. Pre-fix: exactly 1
        //    transitions_icons dialogevent (the 'select'). Post-fix:
        //    2 — 'select' AND 'activate'. The kit-side logger truncates
        //    the tail, but "cmd":"select" vs "cmd":"activate" differ in
        //    BYTE LENGTH, so two distinct len= values corroborate that
        //    the activate fired.
        const dialogeventMsgs = unoOutbound.filter(m =>
            /dialogevent.*transitions_icons/i.test(m));
        const lens = dialogeventMsgs.map(m => {
            const mt = m.match(/len=(\d+)/); return mt ? parseInt(mt[1], 10) : null;
        }).filter(n => n != null);
        log(`outbound after click (${unoOutbound.length} total; ${
            dialogeventMsgs.length} transitions_icons dialogevents; ` +
            `lens=${lens.join(',')}):`);
        dialogeventMsgs.slice(0, 8).forEach(m => log(`  | ${m}`));
        check('at least 2 kit-bound transitions_icons dialogevents after click ' +
              '(select + activate, i.e. singleclickactivate fires)',
              dialogeventMsgs.length >= 2,
              `${dialogeventMsgs.length} dialogevents (need >=2)`);
        check('the two dialogevents have distinct lengths (different cmd values)',
              new Set(lens).size >= 2,
              `lens=${lens.join(',')}`);

        log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 200));
    } finally {
        try { await browser.close(); } catch (_) {}
    }

    process.exit(allPassed ? 0 : 1);
})();
