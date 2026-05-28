const __cl = require('./lib/inject-checklist');
// Regression: PPTX Transitions tab — the iconview must show clickable
// transition tiles (Fade, Wipe, Cover, …), not invisible 2-pixel strips.
//
// User report (2026-05-28): "Transition menu does not work. You cannot
// set any transitions, they don't appear as choices, the buttons don't
// do anything."
//
// Root cause: Notebookbar.ImpressTransitionTab.ts creates the
// transitions iconview with 29 entries marked `ondemand: true` but
// without width/height. setupSize() in Widget.IconView.ts is a no-op
// when those fields are missing, so each entry collapses to a 2-pixel
// flat strip. The IntersectionObserver fires (the strip is "visible"
// at 0.01 threshold) but the tiles look blank and there is nothing to
// click, so the user perceives the menu as completely inert.
//
// This test:
//   1. Open a pptx in editing mode.
//   2. Click the "Transition" notebookbar tab.
//   3. Read the transitions iconview's first 5 entries' rendered
//      bounding rects.
//   4. Assert each entry's HEIGHT is at least 30 px (real tiles
//      target ~64 px). FAILS pre-fix at height=2px.
//   5. Assert each entry has a non-empty placeholder image (or at
//      least a title) — pre-fix the inner span is empty.

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');

const VIEWER  = env.FILE_STORAGE_URL;
const FIXTURE = path.join(__dirname, '..', 'test', 'data', 'testdoc.pptx');
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-pptx-transitions-iconview';

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

(async () => {
    log('=== Regression: PPTX Transitions iconview tiles render ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(FIXTURE)) {
        log(`SKIP: fixture missing: ${FIXTURE}`);
        process.exit(2);
    }

    const bytes = fs.readFileSync(FIXTURE);
    const name  = `transitions-${Date.now()}.pptx`;
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
        await page.goto(`${VIEWER}/?singleuser#file=${up.b64urlSecret}`,
            { waitUntil: 'domcontentloaded',
              timeout: env.scaleTimeout(120000) });

        // Wait for editor iframe + canvas + doc-loaded.
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

        // Switch to the Transitions tab.
        const tabOk = await frame.evaluate(() => {
            const b = document.getElementById('Transition-tab-label');
            if (!b) return { ok: false, why: 'no tab' };
            b.click();
            return { ok: true };
        });
        check('Transition tab present + clickable', tabOk.ok === true, tabOk.why);
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
    } finally {
        await browser.close();
    }

    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e.stack || e.message);
    process.exit(2);
});
