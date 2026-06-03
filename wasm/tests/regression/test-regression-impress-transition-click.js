const __cl = require('../../lib/inject-checklist');
// Regression: PPTX Transitions — clicking a transition tile must apply it.
//
// User report (2026-05-28, ai/tasks/todo/impress-transition-menu-doesnt-work):
// "Transitions tab: tiles render but clicking them does nothing — no
// transition gets applied to the slide."
//
// Background: e5a635886296 (2026-05-28) fixed tile rendering (29 tiles
// each 76x64). That's a prerequisite — without it the tiles were 2px
// strips. After the rendering fix the user can SEE the tiles but
// clicking still doesn't activate any transition.
//
// Hypothesis (confirmed by reading Widget.IconView.ts:163-194):
// The transitions iconview definition in
// Notebookbar.ImpressTransitionTab.ts:48-49 lacks
// `singleclickactivate: true`. Single-click therefore only fires
// builderCallback('iconview', 'select', ...) — it never fires the
// 'activate' callback that triggers the actual transition application
// in LO core. The user has to DOUBLE-click to activate, which doesn't
// match the PowerPoint / LO-desktop convention of single-click apply.
//
// This test drives the user flow with REAL puppeteer mouse clicks
// (no frame.evaluate(()=>el.click()), no sendUnoCommand):
//   1. Open a pptx
//   2. Real-click the "Transition" notebookbar tab
//   3. Locate the iconview container; pick a non-first tile (the first
//      is typically "None" which is also a transition but the no-op
//      one — we want a visible-effect tile, e.g. row 2 or 3)
//   4. Real-click the tile (page.mouse.click on its bounding box)
//   5. Assert: the clicked tile picks up the `.selected` class
//   6. Assert: a UNO command containing "slide" or "transit" fired on
//      the wire (relay-adapter's outbound log) — this proves the
//      activation crossed into the kit.

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

const VIEWER  = env.FILE_STORAGE_URL;
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'testdoc.pptx');
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-impress-transition-click';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0    = Date.now();
const log   = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
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

// Real Puppeteer click on an in-frame element by id. Resolves the
// element's bounding box (via frame.evaluate to read getBoundingClientRect
// — that's READING DOM state, not invoking a click handler) and then
// drives page.mouse.click at the centre.
async function realClickById(page, frame, id) {
    const box = await frame.evaluate((id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
    }, id);
    if (!box) throw new Error(`element #${id} not found`);
    // Frame coords are relative to the iframe origin in puppeteer; for a
    // top-level iframe at (0,0) viewport, page.mouse.click(box.x,box.y)
    // hits the same pixel. Test viewport doesn't scroll the iframe so
    // additional offsets aren't needed (the existing transitions-iconview
    // test confirms the iframe occupies the full viewport when loaded
    // via /?singleuser).
    await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
    return box;
}

(async () => {
    log('=== Regression: PPTX Transition click applies transition ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(FIXTURE)) {
        log(`SKIP: fixture missing: ${FIXTURE}`);
        process.exit(2);
    }

    const bytes = fs.readFileSync(FIXTURE);
    const name  = `transition-click-${Date.now()}.pptx`;
    const up    = await uploadV2(VIEWER, name, bytes);
    log(`uploaded ${name}`);

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });

        // Capture relay outbound UNO traffic to prove the activation
        // reached the kit. relay-adapter logs all outbound `uno .uno:...`
        // and iconview activate messages on the console.
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
        // Expose toggle so the rest of the test can flip the broad capture
        // for a focused window.
        const setCaptureAll = (v) => { captureAll = v; };

        await page.goto(`${VIEWER}/?singleuser#file=${up.b64urlSecret}`,
            { waitUntil: 'domcontentloaded',
              timeout: env.scaleTimeout(120000) });

        let frame = null;
        for (let i = 0; i < 90 && !frame; i++) {
            frame = page.frames().find(f => f.url().includes('cool.html'));
            if (frame && !(await frame.$('#document-canvas').catch(() => null))) frame = null;
            if (!frame) await sleep(1000);
        }
        if (!frame) throw new Error('editor frame never loaded');
        await frame.waitForFunction(
            () => window.__wasmInitialDocLoaded === true,
            { timeout: env.scaleTimeout(60000) });
        await sleep(3000);
        await snap(page, 'loaded');

        // 1. Real-click the Transition tab.
        log('--- Real-click Transition tab ---');
        await realClickById(page, frame, 'Transition-tab-label');
        await sleep(2500);
        await snap(page, 'transition_tab_open');

        // 2. Confirm the iconview is populated. (e5a6358862 should have
        //    already made tiles visible; this is the precondition.)
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
        }

        // 3. Pick a non-first tile (skip "None" which is row 0). Use
        //    row 2 for a visibly-distinct transition like "Push" or
        //    "Wipe". The exact tile doesn't matter — any non-None
        //    transition should activate.
        const targetIdx = Math.min(2, tiles.length - 1);
        const target = tiles[targetIdx];
        log(`Picked tile #${targetIdx}: id=${target.id} bbox=${target.x},${target.y} ${target.w}x${target.h}`);

        // 4. Real puppeteer mouse click on the tile's centre.
        unoOutbound.length = 0;
        allMsgsAfterClick.length = 0;
        setCaptureAll(true);
        log('--- Real-click transition tile ---');
        await page.mouse.click(target.x + target.w / 2, target.y + target.h / 2);
        await sleep(3000);
        setCaptureAll(false);
        await snap(page, 'after_tile_click');
        log(`(broad capture: ${allMsgsAfterClick.length} lines in 3s window)`);
        allMsgsAfterClick.slice(0, 15).forEach(m => log(`  ALL| ${m}`));

        // 5. Tile should now be .selected. This proves the click handler
        //    fired. Pre-fix: still passes (select fires fine). Post-fix:
        //    still passes.
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

        // 6. The activation must reach the kit. Count kit-bound
        //    `dialogevent ... transitions_icons` messages. Pre-fix
        //    (no singleclickactivate): exactly 1 message — the 'select'
        //    cmd. Post-fix (singleclickactivate:true): exactly 2 — the
        //    'select' AND the 'activate'. The 'activate' is what
        //    propagates the transition apply to the kit.
        //
        //    The kit-side logger truncates the message tail so we can't
        //    read the cmd value directly, but the BYTE LENGTHS differ —
        //    "cmd":"select"  (15 chars) vs "cmd":"activate" (17 chars).
        //    Two distinct lengths in the captured pair is corroborating
        //    evidence the activate command fired.
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
    } finally {
        await browser.close();
    }

    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e.stack || e.message);
    process.exit(2);
});
