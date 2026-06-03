const __cl = require('../../lib/inject-checklist');
// test-regression-cross-tab-paste.js — verifies COOL→COOL paste works
// when source and destination are SEPARATE tabs (different kit
// processes).
//
// Bug history: until 2026-06-02, the wasm-loader paste handler routed
// to `uno .uno:Paste` whenever the clipboard HTML contained the
// `data-coolorigin` / `meta-origin` marker that COOL's oncopy puts
// there. That uno-paste reads LO's per-kit-process internal clipboard;
// in a different tab's kit, that clipboard is empty, so paste no-ops
// silently. Word→COOL paste worked because Word's HTML has no COOL
// marker → handler took the regular html branch and forwarded the
// bytes to the kit.
//
// Fix: distinguish same-tab (fingerprint match — kit IS the source)
// from cross-tab (COOL marker without fingerprint). Cross-tab routes
// through the html-bytes branch like Word does.
//
// Headless-chromium constraint: two separate chromium instances don't
// share a clipboard, and two pages in one browser hit a viewer
// prewarm race that hangs B's editor frame. So we simulate the
// SOURCE side programmatically: plant exactly the HTML+plain that
// COOL's oncopy would write (including the meta-origin marker),
// then drive real Ctrl+V into the destination. This exercises the
// fixed loader branch faithfully — the synthetic-source pattern is
// also how test-singleuser-copy-paste.js Case 6 (external clipboard
// paste) verifies the OS clipboard path.

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-cross-tab-paste';

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch (_) {}
}

async function openTab(browser, secret) {
    const page = await browser.newPage();
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.grantPermissions', {
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
    await page.setViewport({ width: 1280, height: 900 });
    page.on('console', m => {
        const t = m.text();
        if (/wasm-loader.*[Pp]aste|External paste|Internal paste|paste mimetype|empty clipboard/i.test(t)) {
            log(`  PAGE: ${t}`);
        }
    });
    await page.goto(`${VIEWER}/?singleuser#file=${secret}`,
        { waitUntil: 'domcontentloaded', timeout: env.scaleTimeout(120000) });
    let frame = null;
    for (let i = 0; i < 90 && !frame; i++) {
        frame = page.frames().find(f => f.url().includes('cool.html'));
        if (frame && !(await frame.$('#document-canvas').catch(() => null))) frame = null;
        if (!frame) await sleep(1000);
    }
    if (!frame) throw new Error('editor frame never loaded');
    await frame.waitForFunction(() => window.__wasmInitialDocLoaded === true,
        { timeout: env.scaleTimeout(60000) });
    await frame.waitForFunction(() =>
        /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''),
        { timeout: env.scaleTimeout(30000) });
    await sleep(2500);
    return { page, frame };
}

const charCount = async (page) => {
    const fr = page.frames().find(f => f.url().includes('cool.html'));
    if (!fr) return -1;
    return fr.evaluate(() => {
        const t = document.querySelector('#StateWordCount')?.textContent || '';
        const m = t.match(/(\d+)\s+character/i);
        return m ? parseInt(m[1], 10) : -1;
    });
};

async function focusBody(page) {
    const frameEl = await page.$('iframe#editor-frame');
    const box = await frameEl.boundingBox();
    await page.mouse.click(box.x + box.width / 2,
                           box.y + Math.min(box.height * 0.55, 450));
    await sleep(300);
}

async function ctrl(page, key) {
    await page.keyboard.down('Control');
    await page.keyboard.press(key);
    await page.keyboard.up('Control');
    await sleep(300);
}

// Plant the exact HTML+plain that COOL's oncopy handler would
// produce in a source tab, so the destination's paste handler sees
// the same payload it would in a real two-tab scenario. The
// meta-origin marker is what wasm-loader.js:1519 detects.
async function plantCoolClipboard(page, sentinel) {
    const html = '<meta http-equiv="content-type" content="text/html; charset=utf-8"/>' +
                 '<meta name="generator" content="LibreOffice"/>' +
                 '<meta name="meta-origin" content="cool"/>' +
                 '<div>' + sentinel + '</div>';
    const plain = sentinel;
    await page.evaluate(async (h, p) => {
        await navigator.clipboard.write([new ClipboardItem({
            'text/html':  new Blob([h], { type: 'text/html' }),
            'text/plain': new Blob([p], { type: 'text/plain' }),
        })]);
    }, html, plain);
    await sleep(300);
}

(async () => {
    log('=== Cross-tab COOL→COOL paste regression ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const fixture = fs.readFileSync(path.join(__dirname, '..', 'test', 'data', 'new.docx'));
    const up = await uploadV2(VIEWER, 'crosspaste-' + Date.now() + '.docx', fixture);

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });
    try {
        const dst = await openTab(browser, up.b64urlSecret);
        log('Destination tab loaded.');

        // Plant exactly what a source COOL tab's oncopy would have
        // written. Note: globalThis._lastCopiedPlain in this page is
        // unset (this page never copied), so fingerprintMatch will
        // be FALSE — matching the real cross-tab scenario where
        // destination's local JS state has no record of the source.
        const SENTINEL = 'CROSSTAB-PASTE-SENTINEL-' + Date.now();
        await plantCoolClipboard(dst.page, SENTINEL);
        log('Clipboard planted with COOL meta-origin marker.');

        // Focus body, end-of-doc, paste.
        await focusBody(dst.page);
        const before = await charCount(dst.page);
        log(`charCount before paste = ${before}`);
        await ctrl(dst.page, 'End');
        await ctrl(dst.page, 'v');

        const deadline = Date.now() + 12000;
        let after = before;
        while (Date.now() < deadline) {
            after = await charCount(dst.page);
            if (after > before) break;
            await sleep(200);
        }
        log(`charCount after paste = ${after}`);
        await snap(dst.page, 'after-paste');

        check('Cross-tab paste grew destination doc',
              after > before,
              `before=${before} after=${after} delta=${after - before}`);
        check('Loader took cross-tab branch (not uno-paste no-op)',
              after - before >= SENTINEL.length,
              `sentinel.len=${SENTINEL.length} delta=${after - before}`);

        log('=== Done ===');
    } finally {
        try { await browser.close(); } catch (_) {}
    }
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e.stack || e.message);
    process.exit(2);
});
