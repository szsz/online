// Regression: double-click word → Ctrl+C → Ctrl+End → Ctrl+V actually
// pastes the selected word at end-of-doc.
//
// Ported smoke from ai/tasks/in-progress/copy-paste-master.md
// "Bucket B case 2" — `double-click-word-select-then-copy-paste`. Lives
// today as case 3 in tests/misc/test-singleuser-copy-paste.js inside a
// multi-case run where prior cases pre-populate the clipboard; this
// regression isolates the flow so a kit-side word-select / clipboard
// regression surfaces on its own.
//
// Shape (real puppeteer mouse + keyboard — no sendUnoCommand,
// no app.dispatcher.dispatch, no page.evaluate(()=>el.click())):
//   1. Upload a fresh new.docx via the viewer (single-user mode).
//   2. Wait for the editor to be ready.
//   3. Click into the doc body to place caret. Type "hello world".
//   4. Wait for the StateWordCount to reflect the typed chars.
//   5. Double-click on a word in the canvas to select it.
//   6. Ctrl+C → Ctrl+End → Ctrl+V.
//   7. Assert StateWordCount has grown by at least 1 char (the word
//      was pasted).
//
// Smoke: doesn't pin the exact word, just that some text was pasted.
// The kit-side word-select + copy + paste-at-end chain is the surface
// under test; specifics of which word landed where are out of scope.

'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const __cl = require('../../lib/inject-checklist');
const env = require('../../lib/test-env');
const { openViaViewer } = require('../../lib/open-via-viewer');

const VIEWER = env.FILE_STORAGE_URL;
const DOC_NAME = 'dclick-word-cp-' + Date.now() + '.docx';
const DOC_PATH = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-double-click-word-copypaste';

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
    log('=== Regression: double-click word → copy → ctrl-end → paste ===');
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
        // Grant clipboard permissions browser-wide via CDP. The cross-
        // origin iframe doesn't inherit page.overridePermissions; without
        // this Ctrl+V hits "Paste: empty clipboard — ignored" in the
        // wasm-loader's paste handler.
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

        // Click into the doc canvas to place the caret. Aim well below
        // the toolbar.
        const iframeEl = await page.$('iframe#editor-frame');
        const ifBox = await iframeEl.boundingBox();
        const clickX = ifBox.x + ifBox.width / 2;
        const clickY = ifBox.y + Math.min(ifBox.height * 0.55, 450);
        await page.mouse.click(clickX, clickY);
        await sleep(env.scaleTimeout(500));

        // Type a deterministic phrase. The double-click below selects a
        // word inside this phrase.
        const PHRASE = 'hello world';
        for (const ch of PHRASE) {
            await page.keyboard.type(ch);
            await sleep(40);
        }
        const targetChars = baseChars >= 0 ? baseChars + PHRASE.length : PHRASE.length;
        const after = await waitForCharsAtLeast(frame, targetChars, env.scaleTimeout(10000));
        log('after-type chars=' + after);
        check('Typing "hello world" added characters',
              after >= targetChars, 'expected≥' + targetChars + ' got=' + after);
        await snap(page, 'after_type');

        // Double-click on a word. We aimed our caret at roughly the
        // centre-ish of the doc; the freshly-typed text lands at the
        // caret, so a double-click somewhere near the same Y line and
        // a bit to the left of the click point should hit one of the
        // words in "hello world".
        await page.mouse.click(clickX - 30, clickY, { clickCount: 2 });
        await sleep(env.scaleTimeout(500));
        await snap(page, 'word_double_clicked');

        // Copy → ctrl-end → paste.
        await pressCtrl(page, 'c');
        await sleep(env.scaleTimeout(400));
        await page.keyboard.down('Control');
        await page.keyboard.press('End');
        await page.keyboard.up('Control');
        await sleep(env.scaleTimeout(300));
        const beforePaste = await readCharCount(frame);
        log('before-paste chars=' + beforePaste);
        await pressCtrl(page, 'v');
        // Paste round-trips to kit; allow time for the state-update.
        const finalChars = await waitForCharsAtLeast(frame, beforePaste + 1,
            env.scaleTimeout(10000));
        log('after-paste chars=' + finalChars);
        await snap(page, 'after_paste');

        check('Paste after double-click-word grew the character count',
              finalChars >= beforePaste + 1,
              'before=' + beforePaste + ' after=' + finalChars);

        log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    } catch (e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        await browser.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
