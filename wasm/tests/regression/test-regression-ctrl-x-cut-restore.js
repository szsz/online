// Regression: Ctrl+X on selection → Ctrl+V restores cut content.
//
// TRIPWIRE — expected to FAIL until the LO-side .uno:Cut bug is
// fixed. Tracked at ai/proposals/promoted/ctrl-x-isolated-single-
// user-clipboard.md (Bucket A bug in
// ai/tasks/todo/copy-paste-master.md).
//
// Bug shape: kit's .uno:Cut handler removes the selected content
// from the document but does NOT write it to the OS clipboard. In
// the multi-case singleuser run (tests/misc/test-singleuser-copy-
// paste.js) Case 5 PASSED accidentally — Case 3/4's earlier Ctrl+C
// had left valid content on the OS clipboard, so the subsequent
// Ctrl+V pasted *that* instead of the cut content. In an ISOLATED
// run (this regression test, fresh browser per invocation), Ctrl+V
// has nothing useful on the clipboard and the assert fails.
//
// Once the LO fix lands, this test should auto-pass. Until then,
// CI will flag it red — exactly the tripwire intent.
//
// Shape (real puppeteer mouse + keyboard — no sendUnoCommand,
// no app.dispatcher.dispatch, no page.evaluate(()=>el.click())):
//   1. Open new.docx via the viewer (single-user mode).
//   2. Click into doc body, type "cut-test-abc".
//   3. Ctrl+Home, Shift+ArrowRight ×3 to select 3 chars.
//   4. Ctrl+X — assert character count dropped by ≥3.
//   5. Ctrl+V — assert character count restored to pre-cut state.

'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const __cl = require('../../lib/inject-checklist');
const env = require('../../lib/test-env');
const { openViaViewer } = require('../../lib/open-via-viewer');

const VIEWER = env.FILE_STORAGE_URL;
const DOC_NAME = 'ctrl-x-' + Date.now() + '.docx';
const DOC_PATH = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-ctrl-x-cut-restore';

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

async function waitForChars(frame, target, timeoutMs, predicate) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const c = await readCharCount(frame);
        if (predicate(c, target)) return c;
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
    log('=== Regression (TRIPWIRE): Ctrl+X cut → Ctrl+V restores ===');
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

        // Type a deterministic phrase the cut will operate on.
        const iframeEl = await page.$('iframe#editor-frame');
        const ifBox = await iframeEl.boundingBox();
        await page.mouse.click(ifBox.x + ifBox.width / 2,
            ifBox.y + Math.min(ifBox.height * 0.55, 450));
        await sleep(env.scaleTimeout(500));

        const PHRASE = 'cut-test-abc';
        for (const ch of PHRASE) {
            await page.keyboard.type(ch);
            await sleep(30);
        }
        const targetChars = baseChars >= 0 ? baseChars + PHRASE.length : PHRASE.length;
        const afterType = await waitForChars(frame, targetChars,
            env.scaleTimeout(10000), (c, t) => c >= t);
        log('after-type chars=' + afterType);
        check('Typed "' + PHRASE + '"', afterType >= targetChars,
              'expected≥' + targetChars + ' got=' + afterType);
        await snap(page, 'after_type');

        // Ctrl+Home, then Shift+ArrowRight ×3 to select 3 chars.
        await pressCtrl(page, 'Home');
        await sleep(env.scaleTimeout(400));
        for (let i = 0; i < 3; i++) {
            await page.keyboard.down('Shift');
            await page.keyboard.press('ArrowRight');
            await page.keyboard.up('Shift');
            await sleep(50);
        }
        await sleep(env.scaleTimeout(400));
        await snap(page, 'after_select');

        const beforeCut = await readCharCount(frame);
        log('before-cut chars=' + beforeCut);

        // Ctrl+X: cut the selection.
        await pressCtrl(page, 'x');
        const afterCut = await waitForChars(frame, beforeCut - 3,
            env.scaleTimeout(8000), (c, t) => c >= 0 && c <= t);
        log('after-cut chars=' + afterCut);
        await snap(page, 'after_cut');

        check('Ctrl+X shrank the doc by ≥3 chars',
              afterCut >= 0 && afterCut <= beforeCut - 3,
              'before=' + beforeCut + ' after=' + afterCut);

        // Ctrl+V: paste the cut content back. THIS is the tripwire.
        // If the kit's .uno:Cut wrote to the OS clipboard, this restores
        // the char count to beforeCut. If the bug is still present,
        // the OS clipboard is stale and the count won't recover.
        await pressCtrl(page, 'v');
        const afterPaste = await waitForChars(frame, beforeCut,
            env.scaleTimeout(8000), (c, t) => c >= t);
        log('after-paste chars=' + afterPaste);
        await snap(page, 'after_paste');

        check('Ctrl+V restored chars to before-cut count (TRIPWIRE)',
              afterPaste >= beforeCut,
              'expected≥' + beforeCut + ' got=' + afterPaste +
              ' → kit-side .uno:Cut likely not writing to OS clipboard');

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
