const __cl = require('../../lib/inject-checklist');
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

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const RELAY_HOST = new URL(env.RELAY_URL).host;

const SHOT_DIR = '/tmp/static-deploy/public/shots-singleuser-copy-paste';
const DOC_NAME = 'singleuser-cp-' + Date.now() + '.docx';
const BLANK_DOCX = path.join(__dirname, '..', '..', 'viewer-public', 'blank.docx');

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

// Re-resolve the editor frame each call — the viewer recreates the
// iframe when opening the user doc (prewarm blank → user file), so
// caching a Frame ref leaves us with a detached frame that always
// returns -1.
// Read the actual text of the document (NOT just char count). Sends
// .uno:SelectAll then 'gettextselection mimetype=text/plain;charset=utf-8'
// and waits for the textselectioncontent: reply on the FakeWebSocket.
//
// Why: char count alone is fake-pass-prone — if LO's internal clipboard
// happens to hold text of the right length, .uno:Paste from a synthetic
// Ctrl+V will land that text and the count assertion passes even if the
// OS clipboard's external bytes never reach the doc.
async function getDocText(page, timeoutMs = 6000) {
    const fr = page.frames().find(f => f.url().includes('cool.html'));
    if (!fr) return '';
    return await fr.evaluate(async (waitMs) => {
        return await new Promise((resolve) => {
            // Hook FakeWebSocket onmessage / globalThis.onCommandValuesReceived
            // / app.socket._onMessage to capture the textselectioncontent reply.
            // Simpler: read from app.layoutingService or use the app.map's API
            // if available; fall back to socket-level capture.
            let resolved = false;
            const capture = (s) => {
                if (resolved) return;
                if (typeof s !== 'string') return;
                const m = s.match(/textselectioncontent:\s*([\s\S]*)$/);
                if (m) { resolved = true; resolve(m[1]); }
            };
            // Patch app.socket._onMessage briefly.
            try {
                const orig = window.app && window.app.socket
                    && window.app.socket._onMessage;
                if (orig) {
                    window.app.socket._onMessage = function(e) {
                        try {
                            const t = (e && e.data) ? (typeof e.data === 'string'
                                ? e.data : '') : '';
                            capture(t);
                        } catch (er) {}
                        return orig.apply(this, arguments);
                    };
                    setTimeout(() => {
                        if (!resolved) {
                            window.app.socket._onMessage = orig;
                            resolved = true;
                            resolve('');
                        }
                    }, waitMs);
                } else {
                    setTimeout(() => resolve(''), waitMs);
                }
            } catch (e) { resolve(''); }
            // Trigger select-all + query.
            try {
                if (window.app && window.app.socket) {
                    window.app.socket.sendMessage('uno .uno:SelectAll');
                    setTimeout(() => {
                        try { window.app.socket.sendMessage(
                            'gettextselection mimetype=text/plain;charset=utf-8'); }
                        catch (e) {}
                    }, 200);
                }
            } catch (e) {}
        });
    }, timeoutMs).catch(() => '');
}

async function getCharCountFromPage(page) {
    try {
        const fr = page.frames().find(f => f.url().includes('cool.html'));
        if (!fr) return -1;
        const t = await fr.evaluate(() =>
            document.querySelector('#StateWordCount')?.textContent || ''
        ).catch(() => '');
        const m = t.match(/([\d,]+)\s*character/);
        return m ? parseInt(m[1].replace(/,/g, '')) : -1;
    } catch (e) { return -1; }
}
async function getCharCount(frameOrPage) {
    // Accept either a Page or a Frame for backwards compat in helper sites.
    if (frameOrPage && typeof frameOrPage.frames === 'function') {
        return getCharCountFromPage(frameOrPage);
    }
    if (!frameOrPage) return -1;
    try {
        const t = await frameOrPage.evaluate(() =>
            document.querySelector('#StateWordCount')?.textContent || ''
        ).catch(() => '');
        const m = t.match(/([\d,]+)\s*character/);
        return m ? parseInt(m[1].replace(/,/g, '')) : -1;
    } catch (e) { return -1; }
}

async function focusDocBody(page) {
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

async function waitForCharCount(page, expected, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const last = await getCharCount(page);
        if (last === expected) return true;
        await sleep(150);
    }
    return false;
}

async function waitForCharCountAtLeast(page, expected, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const last = await getCharCount(page);
        if (last >= expected) return true;
        await sleep(150);
    }
    return false;
}

// 1×1 transparent PNG (smallest valid).
const TINY_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function writeClipboardText(page, text) {
    // The clipboard is shared across origins, so writing from the parent
    // page makes it visible to the iframe's paste handler.
    try {
        await page.evaluate(t => navigator.clipboard.writeText(t), text);
    } catch (e) {
        // Fallback: write via the iframe (which already has the permission
        // grant for editor origin).
        const fr = page.frames().find(f => f.url().includes('cool.html'));
        if (fr) {
            await fr.evaluate(t => navigator.clipboard.writeText(t), text).catch(() => {});
        }
    }
    await sleep(150);
}

async function writeClipboardImage(page, b64) {
    const writeViaFrame = async (target) => {
        return target.evaluate(async (data) => {
            const bin = atob(data);
            const buf = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
            const blob = new Blob([buf], { type: 'image/png' });
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        }, b64);
    };
    try {
        await writeViaFrame(page);
    } catch (e) {
        const fr = page.frames().find(f => f.url().includes('cool.html'));
        if (fr) await writeViaFrame(fr).catch(() => {});
    }
    await sleep(200);
}

async function openSingleUser(browser, secretB64) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    // Capture console for product-signal assertions (e.g. case 7: did
    // insertfile reach the local Kit?).
    page.__capturedLogs = [];

    // Grant clipboard permissions browser-wide via CDP (matches what
    // test-e2e-copypaste.js does — overridePermissions is per-origin
    // and doesn't reach the cross-origin iframe). Without this every
    // Ctrl+V hits "Paste: empty clipboard — ignored" because the
    // iframe's navigator.clipboard.read returns [].
    const cdpRoot = await page.target().createCDPSession();
    try {
        await cdpRoot.send('Browser.grantPermissions', {
            permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
        });
    } catch (e) { /* older Chrome */ }

    const wsUrls = [];
    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketCreated', e => wsUrls.push(e.url));

    page.on('pageerror', e => log(`[pageerror] ${e.message}`));
    page.on('console', m => {
        const t = m.text();
        page.__capturedLogs.push(t);
        if (/error|fail|paste|clipboard|relay/i.test(t)) log(`[page] ${t.slice(0, 220)}`);
    });

    await page.goto(VIEWER + '/singleuser.html#file=' + secretB64,
        { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
        () => location.pathname === '/index.html' && location.search.includes('singleuser'),
        { timeout: 15000 }
    ).catch(() => {});

    // Wait for any cool.html iframe to appear (prewarm or user-doc).
    let attached = false;
    const attachDeadline = Date.now() + 240000;
    while (Date.now() < attachDeadline) {
        await sleep(500);
        if (page.frames().some(f => f.url().includes('cool.html'))) {
            attached = true; break;
        }
    }
    if (!attached) throw new Error('editor iframe never attached');

    // Wait for the user-doc StateWordCount to populate. Re-resolve the
    // frame each tick because the viewer reuses #editor-frame: it loads
    // cool.html for the prewarm blank first, then changes the iframe src
    // to the user doc — the original Frame ref becomes detached.
    let loaded = false;
    for (let i = 0; i < 360; i++) {            // 180 s wall (cold can be 60-90 s)
        await sleep(500);
        const cc = await getCharCount(page);
        if (cc >= 0) { loaded = true; break; }
    }
    if (!loaded) throw new Error('doc never loaded');
    await sleep(3500); // settle UI handlers
    return { page, wsUrls };
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
        const { page, wsUrls } = await openSingleUser(browser, upV2.b64urlSecret);
        await snap(page, 'after_open');

        const baseChars = await getCharCount(page);
        log(`[state] base chars = ${baseChars}`);

        // ─── Case 1: type "ABC" ──────────────────────────────────────
        await focusDocBody(page);
        await typeText(page, 'ABC');
        const after1 = await waitForCharCount(page, baseChars + 3);
        check('Case 1: typed ABC (+3)', after1,
              'expected=' + (baseChars + 3) + ' got=' + await getCharCount(page));
        await snap(page, 'case1_typed');

        // ─── Case 2: select-all → copy → ctrl+end → paste (double) ───
        await pressShortcut(page, 'a');
        await pressShortcut(page, 'c');
        await ctrlEnd(page);
        await pressShortcut(page, 'v');
        const expected2 = (baseChars + 3) * 2;
        const after2ok = await waitForCharCountAtLeast(page, expected2 - 1);
        check('Case 2: select-all/copy/ctrl-end/paste doubled', after2ok,
              'expected≈' + expected2 + ' got=' + await getCharCount(page));
        await snap(page, 'case2_doubled');

        // ─── Case 3: double-click word → Ctrl+C → ctrl-end → Ctrl+V
        await ctrlHome(page);
        await sleep(150);
        const frameEl = await page.$('iframe#editor-frame');
        const box = await frameEl.boundingBox();
        await page.mouse.click(box.x + box.width / 2,
                               box.y + Math.min(box.height * 0.55, 450),
                               { clickCount: 2 });
        await sleep(300);
        await pressShortcut(page, 'c');
        await ctrlEnd(page);
        const before3 = await getCharCount(page);
        await pressShortcut(page, 'v');
        const grew3 = await waitForCharCountAtLeast(page, before3 + 1);
        check('Case 3: word double-click → copy → ctrl-end → paste added chars',
              grew3, 'before=' + before3 + ' after=' + await getCharCount(page));
        await snap(page, 'case3_word_paste');

        // ─── Case 4: mouse-drag → Ctrl+C → ctrl-end → Ctrl+V ──────────
        await ctrlHome(page);
        await sleep(150);
        const dragStartX = box.x + box.width / 2 - 30;
        const dragY = box.y + Math.min(box.height * 0.55, 450);
        await page.mouse.move(dragStartX, dragY);
        await page.mouse.down();
        await page.mouse.move(dragStartX + 60, dragY, { steps: 8 });
        await page.mouse.up();
        await sleep(200);
        await pressShortcut(page, 'c');
        await ctrlEnd(page);
        const before4 = await getCharCount(page);
        await pressShortcut(page, 'v');
        const grew4 = await waitForCharCountAtLeast(page, before4 + 1);
        check('Case 4: mouse-drag → copy → ctrl-end → paste added chars',
              grew4, 'before=' + before4 + ' after=' + await getCharCount(page));
        await snap(page, 'case4_drag_paste');

        // ─── Case 5: Ctrl+X on selection → Ctrl+V (cut/restore) ──────
        await ctrlHome(page);
        await sleep(150);
        for (let i = 0; i < 3; i++) {
            await page.keyboard.down('Shift');
            await page.keyboard.press('ArrowRight');
            await page.keyboard.up('Shift');
        }
        await sleep(150);
        const before5 = await getCharCount(page);
        await pressShortcut(page, 'x');
        await waitForCharCountAtLeast(page, 0);
        const after5cutN = await getCharCount(page);
        check('Case 5a: Ctrl+X shrank doc',
              after5cutN < before5,
              'before=' + before5 + ' after=' + after5cutN);
        await pressShortcut(page, 'v');
        const restored = await waitForCharCount(page, before5);
        check('Case 5b: Ctrl+V restored cut content',
              restored, 'expected=' + before5 + ' got=' + await getCharCount(page));
        await snap(page, 'case5_cut_paste');

        // ─── Case 6: external text via clipboard → Ctrl+V ────────────
        // Unique sentinel — if char count happens to grow but the bytes
        // aren't actually the OS clipboard's, the substring check fails.
        // This catches the prior "fake pass" mode where LO's internal
        // clipboard had old content of matching length and Map.Keyboard's
        // synchronous .uno:Paste landed THAT instead of the OS clipboard.
        await ctrlEnd(page);
        const SENTINEL_EXT = 'PASTED-EXTERNAL-12345';
        const before6 = await getCharCount(page);
        await writeClipboardText(page, SENTINEL_EXT);
        await focusDocBody(page);
        await pressShortcut(page, 'v');
        await waitForCharCountAtLeast(page, before6 + SENTINEL_EXT.length, 10000);
        await sleep(800); // settle
        const docText6 = await getDocText(page);
        check('Case 6: external clipboard text appears in doc (sentinel match)',
              docText6.includes(SENTINEL_EXT),
              docText6.length > 200
                ? 'docText[0..200]=' + docText6.slice(0, 200) + '…'
                : 'docText=' + JSON.stringify(docText6));
        await snap(page, 'case6_external_text');

        // ─── Case 7: external image via clipboard → Ctrl+V ───────────
        // LO doesn't render images as overlay <img>/leaflet elements — they
        // get rasterized into canvas tiles. The product-correctness signal
        // we care about: did the insertfile message route to the local Kit
        // (single-user mode)? In iter9 this was the actual bug — the
        // insertfile was relayed through a non-existent WS and lost.
        const logsBeforeImgPaste = page.__capturedLogs.length;
        await ctrlEnd(page);
        await writeClipboardImage(page, TINY_PNG_B64);
        await focusDocBody(page);
        await pressShortcut(page, 'v');
        await sleep(2500);
        const newLogs = page.__capturedLogs.slice(logsBeforeImgPaste);
        const sawLocalKitInsert = newLogs.some(l =>
            /\[relay\] insertfile → local Kit/.test(l));
        check('Case 7a: image insertfile dispatched to local Kit (single-user)',
              sawLocalKitInsert,
              sawLocalKitInsert ? 'present' : 'no "[relay] insertfile → local Kit" log');
        // Visible outcome: a freshly inserted image is auto-selected,
        // flipping the notebookbar to the Picture context tab. (Was a
        // 'KitWS handleMessage' log-grep — that line is not emitted by
        // the single-user direct dispatch, so the check failed even
        // when the image landed; 2026-06-12. Same fix as the isolated
        // test-regression-external-image-paste.js.)
        let pictureTab7 = false;
        try {
            const fr7 = page.frames().find(f => f.url().includes('cool.html'));
            await fr7.waitForFunction(() => {
                const el = document.querySelector('#Picture-tab-label');
                return !!el && el.offsetParent !== null;
            }, { timeout: 10000 });
            pictureTab7 = true;
        } catch (_) {}
        check('Case 7b: Picture context tab appeared (image inserted + selected)',
              pictureTab7,
              pictureTab7 ? 'visible' : '#Picture-tab-label not visible');
        await snap(page, 'case7_external_image');
        // Deselect the image so case 8 types into the text body again.
        await page.keyboard.press('Escape');
        await sleep(400);

        // ─── Case 8: plaintext-only paste (unique sentinel) ──────────
        // Use plain Ctrl+V — the clipboard is plaintext-only, so this
        // exercises the text/plain branch without involving the
        // Paste-Special dialog (which Ctrl+Shift+V can open).
        await ctrlEnd(page);
        const SENTINEL_PLAIN = 'PASTED-PLAIN-67890';
        const logsBeforePlainPaste = page.__capturedLogs.length;
        await writeClipboardText(page, SENTINEL_PLAIN);
        await focusDocBody(page);
        const before8 = await getCharCount(page);
        await pressShortcut(page, 'v');
        await waitForCharCountAtLeast(page, before8 + SENTINEL_PLAIN.length, 10000);
        await sleep(600);
        const after8 = await getCharCount(page);
        check('Case 8a: plaintext paste did not crash editor',
              after8 >= 0, 'after=' + after8);
        // Visible outcome: the sentinel's characters landed in the doc.
        // (Was a 'KitWS handleMessage' log-grep — not emitted by the
        // single-user direct dispatch path, so the check failed even
        // when the paste landed; 2026-06-12.)
        check('Case 8b: plaintext sentinel grew the char count',
              after8 >= before8 + SENTINEL_PLAIN.length,
              'before=' + before8 + ' after=' + after8 +
              ' need +' + SENTINEL_PLAIN.length);
        await snap(page, 'case8_plaintext');

        // ─── Case 9: save round-trip ─────────────────────────────────
        log('[case9] Save mid-flow');
        await pressShortcut(page, 's');
        await sleep(8000);
        const meta = await fetch(VIEWER + '/api/v2/file/' + upV2.fileId)
            .then(r => r.ok ? r.json() : null).catch(() => null);
        const savedSize = meta && (meta.ciphertextSize || meta.size) || -1;
        check('Case 9a: saved file present in /api/v2/file',
              savedSize > 0, 'size=' + savedSize);

        const beforeReopen = await getCharCount(page);
        const fresh = await openSingleUser(browser, upV2.b64urlSecret);
        await sleep(5000);
        const afterReopen = await getCharCount(fresh.page);
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
