// Regression: mouse-drag selection → Ctrl+C → Ctrl+End → Ctrl+V
// actually pastes the dragged text at end-of-doc.
//
// Ported smoke from ai/tasks/todo/copy-paste-master.md "Bucket B
// case 3" — mouse-drag-select-then-copy-paste. Lives today as case
// 4 in tests/misc/test-singleuser-copy-paste.js inside a multi-case
// run; this regression isolates the flow so a kit-side drag-select /
// clipboard regression surfaces on its own.
//
// Known failure mode (per copy-paste-master): drag coords need to
// be computed BEFORE any Ctrl+End scroll, otherwise the drag lands
// in the wrong place. This test does drag at the initial caret
// position (no scroll first), then Ctrl+End ONLY after Ctrl+C.
//
// Shape (real puppeteer mouse + keyboard — no sendUnoCommand,
// no app.dispatcher.dispatch, no page.evaluate(()=>el.click())):
//   1. Upload a fresh new.docx via the viewer (single-user mode).
//   2. Wait for editor ready.
//   3. Click into the doc body to place caret. Type "drag-target".
//   4. Ctrl+Home to position the caret at the top (deterministic
//      starting Y for the drag).
//   5. Mouse-drag horizontally across part of the typed phrase.
//   6. Ctrl+C → Ctrl+End → Ctrl+V.
//   7. Assert StateWordCount grew (text was pasted).
//
// Smoke: doesn't pin the exact text, just that some text was pasted.

'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const __cl = require('../../lib/inject-checklist');
const env = require('../../lib/test-env');
const { openViaViewer } = require('../../lib/open-via-viewer');

const VIEWER = env.FILE_STORAGE_URL;
const DOC_NAME = 'drag-cp-' + Date.now() + '.docx';
const DOC_PATH = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-mouse-drag-copypaste';

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

async function readCharCount(frame) {
    try {
        const t = await frame.evaluate(() =>
            document.querySelector('#StateWordCount')?.textContent || '');
        const m = t.match(/([\d,]+)\s*character/i);
        return m ? parseInt(m[1].replace(/,/g, ''), 10) : -1;
    } catch (_) { return -1; }
}

async function waitForCharsAtLeast(frame, n, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const c = await readCharCount(frame);
        if (c >= n) return c;
        await sleep(200);
    }
    return await readCharCount(frame);
}

async function pressCtrl(page, key) {
    await page.keyboard.down('Control');
    await page.keyboard.press(key);
    await page.keyboard.up('Control');
    await sleep(150);
}

(async () => {
    log('=== Regression: mouse-drag select → copy → ctrl-end → paste ===');
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

        await frame.waitForFunction(() => {
            const wc = document.querySelector('#StateWordCount');
            return !!(wc && wc.textContent && wc.textContent.includes('characters'));
        }, { timeout: env.scaleTimeout(180000) });
        log('Editor ready');
        await sleep(env.scaleTimeout(1500));
        await snap(page, 'editor_ready');

        const baseChars = await readCharCount(frame);
        log('baseline chars=' + baseChars);

        // Click into the canvas, then type a deterministic phrase.
        const iframeEl = await page.$('iframe#editor-frame');
        const ifBox = await iframeEl.boundingBox();
        const clickX = ifBox.x + ifBox.width / 2;
        const clickY = ifBox.y + Math.min(ifBox.height * 0.55, 450);
        await page.mouse.click(clickX, clickY);
        await sleep(env.scaleTimeout(500));

        const PHRASE = 'drag-target';
        for (const ch of PHRASE) {
            await page.keyboard.type(ch);
            await sleep(30);
        }
        const targetChars = baseChars >= 0 ? baseChars + PHRASE.length : PHRASE.length;
        const afterType = await waitForCharsAtLeast(frame, targetChars, env.scaleTimeout(10000));
        log('after-type chars=' + afterType);
        check('Typed "drag-target"', afterType >= targetChars,
              'expected≥' + targetChars + ' got=' + afterType);
        await snap(page, 'after_type');

        // Ctrl+Home so the caret + the typed text are reachable at a
        // known Y for the drag — the doc fits on screen at this point.
        await pressCtrl(page, 'Home');
        await sleep(env.scaleTimeout(500));

        // Drag-select a horizontal span across the FIRST LINE of text.
        // GEOMETRY (2026-06-12 root-cause): in a near-blank doc the
        // typed text lands at the document TOP — the original drag at
        // mid-page clickY crossed empty space and selected nothing
        // (verified via kit mouse-frame trace). After the Ctrl+Home
        // above, the visible blinking cursor sits at the start of the
        // first line; drag rightwards from it across the text.
        const cursorBox = await frame.evaluate(() => {
            const el = document.querySelector('.blinking-cursor');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, h: r.height };
        });
        check('Blinking cursor visible after Ctrl+Home', !!cursorBox,
              cursorBox ? '' : 'no .blinking-cursor element');
        const dragY = cursorBox ? ifBox.y + cursorBox.y + cursorBox.h / 2 : clickY;
        const dragStartX = cursorBox ? ifBox.x + cursorBox.x + 2 : clickX - 40;
        const dragEndX = dragStartX + 80;
        await page.mouse.move(dragStartX, dragY);
        await page.mouse.down();
        // Let kit register the press before the drag begins — under
        // contention an 8-step move can outpace the click-down handler
        // and the kit never sees a drag-start.
        await sleep(env.scaleTimeout(200));
        await page.mouse.move(dragEndX, dragY, { steps: 30 });
        await page.mouse.up();
        await sleep(env.scaleTimeout(500));
        await snap(page, 'after_drag');

        // Copy → Ctrl+End → paste.
        await pressCtrl(page, 'c');
        await sleep(env.scaleTimeout(400));
        await page.keyboard.down('Control');
        await page.keyboard.press('End');
        await page.keyboard.up('Control');
        await sleep(env.scaleTimeout(300));
        const beforePaste = await readCharCount(frame);
        log('before-paste chars=' + beforePaste);
        await pressCtrl(page, 'v');
        const finalChars = await waitForCharsAtLeast(frame, beforePaste + 1,
            env.scaleTimeout(10000));
        log('after-paste chars=' + finalChars);
        await snap(page, 'after_paste');

        check('Paste after mouse-drag grew the character count',
              finalChars >= beforePaste + 1,
              'before=' + beforePaste + ' after=' + finalChars);

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
