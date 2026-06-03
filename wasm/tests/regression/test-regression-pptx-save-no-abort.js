const __cl = require('../../lib/inject-checklist');
// Regression: Ctrl+S (uno .uno:Save) in WASM editing must not abort
// the kit.
//
// User report (2026-05-28): in PPTX, after making any edit (the
// trigger was an Area-dialog fill change, but the actual cause is
// the save itself), the user can only "Discard" — Save fails.
//
// Root cause: relay-adapter.js's interceptedSend at line 765-770
// forwards every user-input command to the kit (singleUserMode) or
// relay (co-edit), THEN at line 777-780 it also calls
// saveAndUploadCheckpoint(). The forwarded `.uno:Save` reaches the
// kit's DocumentBroker.cpp:5284 forwardToChild, which has an
// assertion:
//     assert(!message.starts_with("uno .uno:Save") ||
//            message.starts_with("uno .uno:SaveGraphic"));
// → WASM aborts, process dies, user sees "save failed / discard
// only" because the kit is gone.
//
// This test:
//   1. Open a pptx in singleuser editing mode.
//   2. Modify the doc (type into a slide, or insert a shape).
//   3. Send `.uno:Save` via app.map.sendUnoCommand.
//   4. Wait a few seconds.
//   5. Assert: window.app is still alive (no WASM abort), no
//      pageerror with "unreachable", canvas still painting.
//
// Pre-fix: WASM_ABORT log line appears, pageerror fires,
// __wasmInitialDocLoaded stays true but Module is dead → canvas
// stops responding.

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

const VIEWER  = env.FILE_STORAGE_URL;
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'testdoc.pptx');
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-pptx-save-no-abort';

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
    log('=== Regression: PPTX .uno:Save must not abort kit ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(FIXTURE)) {
        log(`SKIP: fixture missing: ${FIXTURE}`);
        process.exit(2);
    }

    const bytes = fs.readFileSync(FIXTURE);
    const name  = `save-no-abort-${Date.now()}.pptx`;
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

        // Capture WASM_ABORT / unreachable / assertion-failed signals.
        const fatalLines = [];
        page.on('console', m => {
            const t = m.text();
            if (/WASM_ABORT|Assertion failed|Aborted\(/.test(t)) {
                fatalLines.push(t.substring(0, 300));
            }
        });
        const pageErrors = [];
        page.on('pageerror', e => pageErrors.push(e.message));

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
        await frame.waitForFunction(
            () => document.querySelector('#SlideStatus')?.textContent?.includes('Slide'),
            { timeout: env.scaleTimeout(30000) });
        await sleep(2000);
        await snap(page, 'loaded');

        // Make a visible edit so .uno:Save has something to save.
        const canvas = await frame.$('#document-canvas');
        const box = await canvas.boundingBox();
        await page.mouse.click(box.x + 400, box.y + 200);
        await sleep(500);
        await page.keyboard.type('test', { delay: 60 });
        await sleep(1500);
        await snap(page, 'edited');

        // Trigger Save.
        log('--- sending .uno:Save ---');
        fatalLines.length = 0;
        pageErrors.length = 0;
        await frame.evaluate(() => {
            window.app?.map?.sendUnoCommand?.('.uno:Save');
        });
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
    } finally {
        await browser.close();
    }

    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e.stack || e.message);
    process.exit(2);
});
