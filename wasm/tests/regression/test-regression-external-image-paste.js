// Regression: external 1x1 PNG paste (Ctrl+V) embeds image in docx.
//
// Ported smoke from ai/tasks/todo/copy-paste-master.md "Bucket B
// case 8" — image paste in single-user. Lives today as case 7 in
// tests/misc/test-singleuser-copy-paste.js inside a multi-case run;
// this regression isolates the flow.
//
// Background (iter9 bug, fixed long ago — kept as a tripwire):
// `insertfile` had to route to the LOCAL Kit (no relay) in single-user
// mode. The relay path silently dropped it. This test re-checks that
// path each cold open.
//
// Shape (real puppeteer mouse + keyboard — no sendUnoCommand,
// no app.dispatcher.dispatch, no page.evaluate(()=>el.click())):
//   1. Open new.docx via the viewer (single-user mode).
//   2. Click into the canvas to place caret. Wait for editor ready.
//   3. Write a 1x1 transparent PNG to the OS clipboard.
//   4. Ctrl+V on the canvas.
//   5. Assert: relay-adapter logged "insertfile → local Kit" AND the
//      kit logged the insertfile graphic message. (Image paste lands
//      as canvas pixels which are flaky to assert; the message-routed
//      signal is the smoke gate.)

'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const __cl = require('../../lib/inject-checklist');
const env = require('../../lib/test-env');
const { openViaViewer } = require('../../lib/open-via-viewer');

const VIEWER = env.FILE_STORAGE_URL;
const DOC_NAME = 'img-paste-' + Date.now() + '.docx';
const DOC_PATH = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-external-image-paste';

// 1x1 transparent PNG (smallest valid).
const TINY_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const T0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch (_) {}
}

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  PASS: ${label}`);
    else { log(`  FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

async function writeClipboardImage(page, b64) {
    // Seed permission on parent first (some headless setups don't
    // propagate iframe grants on the first call).
    try {
        await page.evaluate(async (data) => {
            const bin = atob(data);
            const buf = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
            const blob = new Blob([buf], { type: 'image/png' });
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        }, b64);
    } catch (_) { /* parent might lack permission; iframe write below is the real one */ }

    const writeBlobInContext = async (target) => {
        return target.evaluate(async (data) => {
            const bin = atob(data);
            const buf = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
            const blob = new Blob([buf], { type: 'image/png' });
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        }, b64);
    };
    // Write from the editor iframe (which has the editor-origin permission grant).
    const fr = page.frames().find(f => f.url().includes('cool.html'));
    if (!fr) throw new Error('no editor iframe found for clipboard write');
    await writeBlobInContext(fr);
    await sleep(200);
}

(async () => {
    log('=== Regression: external image paste (PNG) ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(DOC_PATH)) {
        log('ERROR: fixture missing: ' + DOC_PATH);
        process.exit(1);
    }

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    try {
        const bytes = fs.readFileSync(DOC_PATH);
        const up = await openViaViewer(browser, VIEWER, DOC_NAME, bytes, {
            iframeTimeout: env.scaleTimeout(120000),
            gotoTimeout: env.scaleTimeout(60000),
            isolatedContext: true,
            singleUser: true,
            viewport: { width: 1280, height: 900 },
        });
        const { page, editorFrame: frame } = up;

        const cdp = await page.createCDPSession();
        try {
            await cdp.send('Browser.grantPermissions', {
                permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
            });
        } catch (_) { /* older Chrome */ }

        // Capture relay-adapter and kit logs to assert the insertfile path.
        const capturedLogs = [];
        page.on('console', m => capturedLogs.push(m.text()));
        page.frames().forEach(f => {
            f.on?.('console', m => capturedLogs.push(m.text()));
        });

        await frame.waitForFunction(() => {
            const wc = document.querySelector('#StateWordCount');
            return !!(wc && wc.textContent && wc.textContent.includes('characters'));
        }, { timeout: env.scaleTimeout(180000) });
        log('Editor ready');
        await sleep(env.scaleTimeout(1500));
        await snap(page, 'editor_ready');

        // Click into the canvas to place caret.
        const iframeEl = await page.$('iframe#editor-frame');
        const ifBox = await iframeEl.boundingBox();
        const clickX = ifBox.x + ifBox.width / 2;
        const clickY = ifBox.y + Math.min(ifBox.height * 0.55, 450);
        await page.mouse.click(clickX, clickY);
        await sleep(env.scaleTimeout(500));
        await snap(page, 'caret_placed');

        // Write image to clipboard from the editor iframe context.
        const logsBeforePaste = capturedLogs.length;
        await writeClipboardImage(page, TINY_PNG_B64);
        log('clipboard image written');

        // Ctrl+V on the canvas — drive via keyboard, real user input.
        await page.keyboard.down('Control');
        await page.keyboard.press('v');
        await page.keyboard.up('Control');
        await sleep(env.scaleTimeout(2500));
        await snap(page, 'after_paste');

        const newLogs = capturedLogs.slice(logsBeforePaste);
        const sawLocalKitInsert = newLogs.some(l =>
            /\[relay\]\s+insertfile\s*→\s*local\s+Kit/i.test(l));
        const sawKitHandle = newLogs.some(l =>
            /KitWS\s+handleMessage[\s\S]*insertfile[\s\S]*type=graphic/i.test(l));

        check('relay-adapter dispatched insertfile to local Kit',
              sawLocalKitInsert,
              sawLocalKitInsert ? 'present' :
                  'no "[relay] insertfile → local Kit" log in ' + newLogs.length + ' new lines');
        check('Kit received insertfile (graphic)',
              sawKitHandle,
              sawKitHandle ? 'present' :
                  'no KitWS handleMessage insertfile log');

        log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    } catch (e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        await browser.close().catch(() => {});
    }

    __cl.flush(process.argv[1]);
    process.exit(allPassed ? 0 : 1);
})();
