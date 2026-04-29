const __cl = require('./lib/inject-checklist');
// test-singleuser-copy-paste.js — exercise EVERY copy/paste flow in single-
// user mode (no relay, no co-edit confound). Lets us isolate whether a
// given copy/paste failure is kit-side (this test fails) or co-edit-side
// (this test passes, the multi-browser test fails).
//
// Cases:
//   1. Type "ABC" — baseline.
//   2. Ctrl+A → Ctrl+C → Ctrl+End → Ctrl+V (doubles content).
//   3. Double-click word → Ctrl+C → click-elsewhere → Ctrl+V.
//   4. Mouse-drag selection → Ctrl+C → Ctrl+End → Ctrl+V.
//   5. Ctrl+X on selection → Ctrl+V (cut/restore).
//   6. External text via clipboard → Ctrl+V.
//   7. External 1×1 PNG via clipboard → Ctrl+V (image embed).
//   8. Plaintext-only paste (no HTML branch).
//   9. Save mid-flow + re-open in fresh page, verify char count persists.
//
// Each case is a `check` so partial failures still show what works.

const { launch, sleep } = require('./lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const RELAY_HOST = new URL(env.RELAY_URL).host;

const SHOT_DIR = '/tmp/static-deploy/public/shots-singleuser-copy-paste';
const DOC_NAME = 'singleuser-cp-' + Date.now() + '.docx';
const BLANK_DOCX = path.join(__dirname, 'viewer-public', 'blank.docx');

const T0 = Date.now();
function elapsed() { return ((Date.now() - T0) / 1000).toFixed(1) + 's'; }
function log(m) { console.log(`[${elapsed()}] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch(e) {}
}

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' ['+ev+']' : ''}`); allPassed = false; }
}

async function getCharCount(frame) {
    const t = await frame.evaluate(() =>
        document.querySelector('#StateWordCount')?.textContent || ''
    ).catch(() => '');
    const m = t.match(/([\d,]+)\s*character/);
    return m ? parseInt(m[1].replace(/,/g, '')) : -1;
}

async function focusDocBody(page, editorFrame) {
    // Click the editor canvas well below the notebookbar / rulers.
    const frameEl = await page.$('iframe#editor-frame');
    if (!frameEl) return false;
    const box = await frameEl.boundingBox();
    if (!box) return false;
    await page.mouse.click(box.x + box.width / 2,
                           box.y + Math.min(box.height * 0.55, 450));
    await sleep(200);
    return true;
}

async function pressShortcut(page, key) {
    await page.keyboard.down('Control');
    await page.keyboard.press(key);
    await page.keyboard.up('Control');
    await sleep(200);
}

async function typeText(page, text, perCharDelay = 30) {
    for (const c of text) {
        await page.keyboard.type(c);
        await sleep(perCharDelay);
    }
}

async function ctrlEnd(page) {
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    await sleep(150);
}

async function ctrlHome(page) {
    await page.keyboard.down('Control');
    await page.keyboard.press('Home');
    await page.keyboard.up('Control');
    await sleep(150);
}

async function waitForCharCount(frame, expected, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    let last = -1;
    while (Date.now() < deadline) {
        last = await getCharCount(frame);
        if (last === expected) return true;
        await sleep(150);
    }
    return false;
}

async function waitForCharCountAtLeast(frame, expected, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    let last = -1;
    while (Date.now() < deadline) {
        last = await getCharCount(frame);
        if (last >= expected) return true;
        await sleep(150);
    }
    return false;
}

// 1×1 transparent PNG (smallest valid).
const TINY_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function writeClipboardText(page, text) {
    await page.evaluate(t => navigator.clipboard.writeText(t), text);
    await sleep(120);
}

async function writeClipboardImage(page, b64) {
    await page.evaluate(async (data) => {
        const bin = atob(data);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        const blob = new Blob([buf], { type: 'image/png' });
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    }, b64);
    await sleep(150);
}

async function openSingleUser(browser, secretB64) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    const ctx = browser.defaultBrowserContext();
    try {
        await ctx.overridePermissions(VIEWER, ['clipboard-read', 'clipboard-write']);
    } catch (e) { /* older puppeteer */ }

    const wsUrls = [];
    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketCreated', e => wsUrls.push(e.url));

    page.on('pageerror', e => log(`[pageerror] ${e.message}`));
    page.on('console', m => {
        const t = m.text();
        if (/error|fail|paste|clipboard|relay/i.test(t)) log(`[page] ${t.slice(0, 220)}`);
    });

    await page.goto(VIEWER + '/singleuser.html#file=' + secretB64,
        { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
        () => location.pathname === '/index.html' && location.search.includes('singleuser'),
        { timeout: 15000 }
    ).catch(() => {});

    let editorFrame = null;
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
        await sleep(500);
        editorFrame = page.frames().find(f => f.url().includes('cool.html'));
        if (editorFrame) break;
    }
    if (!editorFrame) throw new Error('editor iframe never attached');

    // Wait for document-loaded signal (StateWordCount populated).
    let loaded = false;
    for (let i = 0; i < 300; i++) {
        await sleep(500);
        const cc = await getCharCount(editorFrame);
        if (cc >= 0) { loaded = true; break; }
    }
    if (!loaded) throw new Error('doc never loaded');
    await sleep(3500); // settle UI handlers
    return { page, editorFrame, wsUrls };
}

(async () => {
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    log(`[setup] Uploading ${DOC_NAME} via v2`);
    const blankBytes = fs.readFileSync(BLANK_DOCX);
    const upV2 = await uploadV2(VIEWER, DOC_NAME, blankBytes);
    check('Upload accepted', !!upV2.fileId,
          'fileId=' + (upV2.fileId || 'missing').substring(0, 8));

    const { browser, cleanup } = await launch();
    try {
        const { page, editorFrame, wsUrls } = await openSingleUser(browser, upV2.b64urlSecret);
        await snap(page, 'after_open');

        const baseChars = await getCharCount(editorFrame);
        log(`[state] base chars = ${baseChars}`);

        // ─── Case 1: type "ABC" ──────────────────────────────────────
        await focusDocBody(page, editorFrame);
        await typeText(page, 'ABC');
        const after1 = await waitForCharCount(editorFrame, baseChars + 3);
        check('Case 1: typed ABC (+3)', after1,
              'expected=' + (baseChars + 3) + ' got=' + await getCharCount(editorFrame));
        await snap(page, 'case1_typed');

        // ─── Case 2: select-all → copy → ctrl+end → paste (double) ───
        await pressShortcut(page, 'a');                  // Ctrl+A
        await pressShortcut(page, 'c');                  // Ctrl+C
        await ctrlEnd(page);
        await pressShortcut(page, 'v');                  // Ctrl+V
        const expected2 = (baseChars + 3) * 2;
        const after2ok = await waitForCharCountAtLeast(editorFrame, expected2 - 1);
        check('Case 2: select-all/copy/ctrl-end/paste doubled', after2ok,
              'expected≈' + expected2 + ' got=' + await getCharCount(editorFrame));
        await snap(page, 'case2_doubled');
        const after2 = await getCharCount(editorFrame);

        // ─── Case 3: double-click word → Ctrl+C → click-elsewhere → Ctrl+V
        // Heuristic: doc is "ABCABC" + maybe baseChars. Double-click somewhere
        // central to grab a word, then Ctrl+End and paste.
        await ctrlHome(page);
        await sleep(150);
        const frameEl = await page.$('iframe#editor-frame');
        const box = await frameEl.boundingBox();
        await page.mouse.click(box.x + box.width / 2,
                               box.y + Math.min(box.height * 0.55, 450),
                               { clickCount: 2 });
        await sleep(300);
        await pressShortcut(page, 'c');                  // Ctrl+C
        await ctrlEnd(page);
        const before3 = await getCharCount(editorFrame);
        await pressShortcut(page, 'v');                  // Ctrl+V
        const grew3 = await waitForCharCountAtLeast(editorFrame, before3 + 1);
        check('Case 3: word double-click → copy → ctrl-end → paste added chars',
              grew3, 'before=' + before3 + ' after=' + await getCharCount(editorFrame));
        await snap(page, 'case3_word_paste');

        // ─── Case 4: mouse-drag selection → Ctrl+C → Ctrl+End → Ctrl+V
        await ctrlHome(page);
        await sleep(150);
        // Drag from start to about 4 chars over.
        const dragStartX = box.x + box.width / 2 - 30;
        const dragY = box.y + Math.min(box.height * 0.55, 450);
        await page.mouse.move(dragStartX, dragY);
        await page.mouse.down();
        await page.mouse.move(dragStartX + 60, dragY, { steps: 8 });
        await page.mouse.up();
        await sleep(200);
        await pressShortcut(page, 'c');
        await ctrlEnd(page);
        const before4 = await getCharCount(editorFrame);
        await pressShortcut(page, 'v');
        const grew4 = await waitForCharCountAtLeast(editorFrame, before4 + 1);
        check('Case 4: mouse-drag → copy → ctrl-end → paste added chars',
              grew4, 'before=' + before4 + ' after=' + await getCharCount(editorFrame));
        await snap(page, 'case4_drag_paste');

        // ─── Case 5: Ctrl+X on selection → Ctrl+V (cut/restore) ──────
        await ctrlHome(page);
        await sleep(150);
        // Select a few chars at start with Shift+Right ×3.
        for (let i = 0; i < 3; i++) {
            await page.keyboard.down('Shift');
            await page.keyboard.press('ArrowRight');
            await page.keyboard.up('Shift');
        }
        await sleep(150);
        const before5 = await getCharCount(editorFrame);
        await pressShortcut(page, 'x');
        const after5cut = await waitForCharCountAtLeast(editorFrame, 0);
        const after5cutN = await getCharCount(editorFrame);
        check('Case 5a: Ctrl+X shrank doc',
              after5cutN < before5,
              'before=' + before5 + ' after=' + after5cutN);
        await pressShortcut(page, 'v');
        const restored = await waitForCharCount(editorFrame, before5);
        check('Case 5b: Ctrl+V restored cut content',
              restored, 'expected=' + before5 + ' got=' + await getCharCount(editorFrame));
        await snap(page, 'case5_cut_paste');

        // ─── Case 6: external text via clipboard → Ctrl+V ────────────
        await ctrlEnd(page);
        const before6 = await getCharCount(editorFrame);
        await writeClipboardText(page, 'EXTERNAL');
        await focusDocBody(page, editorFrame);
        await pressShortcut(page, 'v');
        const grew6 = await waitForCharCountAtLeast(editorFrame, before6 + 8);
        check('Case 6: external clipboard text pasted (+8)',
              grew6, 'before=' + before6 + ' after=' + await getCharCount(editorFrame));
        await snap(page, 'case6_external_text');

        // ─── Case 7: external image via clipboard → Ctrl+V ───────────
        await ctrlEnd(page);
        await writeClipboardImage(page, TINY_PNG_B64);
        await focusDocBody(page, editorFrame);
        await pressShortcut(page, 'v');
        await sleep(2500);
        // Detect image embedded — look for a graphic select marker or
        // tile invalidation pattern. Minimal probe: any svg.leaflet-image-layer
        // or similar overlay element in the iframe DOM.
        const hasImage = await editorFrame.evaluate(() => {
            return !!(document.querySelector('.leaflet-graphic-select, .leaflet-image-layer, image[href]'));
        }).catch(() => false);
        check('Case 7: external image paste produced an image marker in DOM',
              hasImage, hasImage ? 'present' : 'no image marker found');
        await snap(page, 'case7_external_image');

        // ─── Case 8: plaintext-only paste ─────────────────────────────
        // Skipped if not supported; relies on the same external-text handler.
        await ctrlEnd(page);
        const before8 = await getCharCount(editorFrame);
        await writeClipboardText(page, 'PLAIN');
        await focusDocBody(page, editorFrame);
        // Send Ctrl+Shift+V for paste-special / plaintext (LO maps this).
        await page.keyboard.down('Control');
        await page.keyboard.down('Shift');
        await page.keyboard.press('v');
        await page.keyboard.up('Shift');
        await page.keyboard.up('Control');
        await sleep(800);
        // Dialog may appear; press Escape if so.
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(400);
        // Whether dialog handled or not, the content may have grown; we treat
        // this as informational only — the assertion is "didn't crash".
        const after8 = await getCharCount(editorFrame);
        check('Case 8: plaintext paste keypress did not crash editor',
              after8 >= 0, 'after=' + after8);
        await snap(page, 'case8_plaintext');

        // ─── Case 9: save round-trip ─────────────────────────────────
        log('[case9] Save mid-flow');
        await pressShortcut(page, 's');
        await sleep(8000);
        // Verify file was uploaded by checking the v2 file size grew.
        const meta = await fetch(VIEWER + '/api/v2/file/' + upV2.fileId)
            .then(r => r.ok ? r.json() : null).catch(() => null);
        const savedSize = meta && (meta.ciphertextSize || meta.size) || -1;
        check('Case 9a: saved file present in /api/v2/file',
              savedSize > 0, 'size=' + savedSize);

        // Re-open in fresh page; chars should match.
        const beforeReopen = await getCharCount(editorFrame);
        const fresh = await openSingleUser(browser, upV2.b64urlSecret);
        await sleep(5000);
        const afterReopen = await getCharCount(fresh.editorFrame);
        check('Case 9b: re-open shows persisted char count',
              afterReopen === beforeReopen,
              'beforeSave=' + beforeReopen + ' reopened=' + afterReopen);
        await snap(fresh.page, 'case9_reopen');

        // No relay WS in either session.
        const allWs = wsUrls.concat(fresh.wsUrls);
        const relayWs = allWs.filter(u => u.includes(RELAY_HOST));
        check('No WebSocket opened to relay (single-user)',
              relayWs.length === 0, 'relayWs=' + relayWs.length);

    } finally {
        await cleanup();
    }

    if (allPassed) { log('✓ ALL TESTS PASSED'); process.exit(0); }
    else            { log('✗ SOME TESTS FAILED'); process.exit(1); }
})().catch(e => { log('FATAL: ' + e.stack); process.exit(2); });
