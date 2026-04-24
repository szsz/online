const __cl = require('./lib/inject-checklist');
// Viewer single-user mode test — complement to test-pptx-viewer.js and
// test-singleuser.js. Verifies the /singleuser.html entry point opens a
// document end-to-end (file upload → viewer file list → iframe cold
// reload → type → Ctrl+S → persisted to /api/files) with NO relay.
//
// Why this isn't already covered:
//   - test-singleuser.js drives the editor directly (cool.html?…), not
//     the viewer. It catches relay-adapter.js' single-user branch, but
//     not the viewer flow (prewarm, click-to-open, shield drop, etc.).
//   - test-pptx-viewer.js covers the viewer flow but only in co-edit
//     mode (with the relay attached).
//
// Asserts:
//   1. /singleuser.html redirects to /index.html?singleuser.
//   2. The editor iframe attaches and its URL contains NO `relay=` param
//      (= relay-adapter runs in single-user mode).
//   3. The document opens — statusbar reports a character count.
//   4. Typing changes the character count locally.
//   5. Ctrl+S triggers an upload to /api/files/<name> and the file size
//      grows (a non-empty save actually landed).
//   6. No WebSocket is opened to the relay host.

const { launch, sleep } = require('./lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const RELAY_HOST = new URL(env.RELAY_URL).host; // e.g. szebeni-wasm-relay.azurewebsites.net

const SHOT_DIR = '/tmp/static-deploy/public/shots-singleuser-viewer';
const DOC_NAME = 'singleuser-viewer-' + Date.now() + '.docx';
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

async function getFileMeta(name) {
    const r = await fetch(VIEWER + '/api/files').catch(() => null);
    if (!r || !r.ok) return null;
    const arr = await r.json();
    return arr.find(f => f.name === name) || null;
}

(async () => {
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    // ── Setup: upload a blank docx via v2 (encrypted) so the viewer has
    //    a file to open. The editor's save-back still writes to /api/files/
    //    (Phase 6 encryption not yet implemented) — the save-back check
    //    below intentionally still queries the legacy endpoint.
    log(`[setup] Uploading ${DOC_NAME} via v2`);
    const blankBytes = fs.readFileSync(BLANK_DOCX);
    const upV2 = await uploadV2(VIEWER, DOC_NAME, blankBytes);
    check('Upload accepted', !!upV2.fileId, 'fileId=' + (upV2.fileId || 'missing').substring(0,8));
    const initialMeta = await getFileMeta(DOC_NAME);
    const initialSize = initialMeta ? initialMeta.size : -1;
    log(`[setup] stored size=${initialSize} hash=${(initialMeta?.hash || '').slice(0, 16)} fileId=${upV2.fileId.substring(0,8)}…`);

    // ── Open /singleuser.html ──
    const { browser, cleanup } = await launch();
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });

        // Track WebSocket connections — we want to assert NO ws opens
        // to the relay host in single-user mode.
        const wsUrls = [];
        const client = await page.target().createCDPSession();
        await client.send('Network.enable');
        client.on('Network.webSocketCreated', e => wsUrls.push(e.url));

        page.on('pageerror', e => log(`[pageerror] ${e.message}`));
        page.on('console', m => {
            const t = m.text();
            if (/singleuser|relay|error/i.test(t)) log(`[page] ${t.slice(0, 200)}`);
        });

        log(`Navigating to ${VIEWER}/singleuser.html#file=${upV2.b64urlSecret}`);
        await page.goto(VIEWER + '/singleuser.html#file=' + upV2.b64urlSecret,
            { waitUntil: 'domcontentloaded' });

        // 1. /singleuser.html must redirect to /index.html?singleuser.
        await page.waitForFunction(
            () => location.pathname === '/index.html' && location.search.includes('singleuser'),
            { timeout: 10000 }
        ).catch(() => {});
        const url = page.url();
        check('Redirected to /index.html?singleuser',
              /\/index\.html\?singleuser/.test(url), url);

        // 2. Editor iframe attaches AND has no `relay=` param.
        let editorFrame = null;
        const deadline = Date.now() + 240000;
        while (Date.now() < deadline) {
            await sleep(500);
            editorFrame = page.frames().find(f => f.url().includes('cool.html'));
            if (editorFrame) break;
        }
        check('Editor iframe attached', !!editorFrame, editorFrame ? editorFrame.url().slice(0, 120) : 'missing');
        if (!editorFrame) throw new Error('no editor frame');
        const iframeUrl = editorFrame.url();
        const iframeUrlDecoded = decodeURIComponent(iframeUrl);
        check('Iframe URL has no relay= param',
              !/(^|&|\?)relay=[^&]/.test(iframeUrlDecoded),
              iframeUrlDecoded.length > 200 ? iframeUrlDecoded.slice(0, 180) + '…' : iframeUrlDecoded);
        await snap(page, 'after_open');

        // 3. Wait for Writer to load (statusbar character count present).
        let loaded = false;
        for (let i = 0; i < 300; i++) {
            await sleep(500);
            const cc = await getCharCount(editorFrame);
            if (cc >= 0) { loaded = true; break; }
        }
        check('Document loaded', loaded);
        // LO can report a char count before it is actually input-ready;
        // give it a few extra seconds to finish UI wiring + idle handlers.
        await sleep(4000);
        const charsBefore = await getCharCount(editorFrame);
        log(`[state] chars before typing = ${charsBefore}`);

        // 4. Type "HELLO" via real keyboard — must change char count
        //    entirely locally (no relay round-trip). Click inside the
        //    iframe well below the notebookbar to hit the document body
        //    (a center click lands on toolbars / rulers on small screens).
        const frameEl = await page.$('iframe#editor-frame');
        if (frameEl) {
            const box = await frameEl.boundingBox();
            if (box) {
                // Two clicks — focus + place cursor in text body.
                await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.5, 400));
                await sleep(300);
                await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.5, 400));
            }
        }
        await sleep(800);
        const typed = 'HELLO';
        for (const ch of typed) { await page.keyboard.type(ch, { delay: 60 }); await sleep(350); }
        await sleep(3000);
        const charsAfter = await getCharCount(editorFrame);
        await snap(page, 'after_type');
        log(`[state] chars after typing   = ${charsAfter}`);
        check(`Typing landed locally (+${typed.length} chars)`,
              charsAfter === charsBefore + typed.length,
              `${charsBefore} → ${charsAfter}`);

        // 5. Ctrl+S triggers save + upload back to /api/files.
        log('[save] pressing Ctrl+S');
        await page.keyboard.down('Control');
        await page.keyboard.press('s');
        await page.keyboard.up('Control');
        // Give relay-adapter's save pipeline time to run (download from
        // /wasm/, encrypt if enabled, POST to /api/files, get response).
        // 10s is generous for a blank doc.
        await sleep(12000);
        const afterMeta = await getFileMeta(DOC_NAME);
        const afterSize = afterMeta ? afterMeta.size : -1;
        log(`[save] stored size after save = ${afterSize} hash=${(afterMeta?.hash || '').slice(0, 16)}`);
        // We expect the hash to change (typed 5 chars) AND size > 0.
        // Some deploys have E2E encryption enabled, so size changes are
        // nonlinear — we just assert "different from initial" + "not zero".
        check('Save produced an updated stored file',
              afterMeta && afterSize > 0 && afterMeta.hash !== (initialMeta?.hash || ''),
              `initialHash=${(initialMeta?.hash || '').slice(0, 8)} afterHash=${(afterMeta?.hash || '').slice(0, 8)}`);

        // 6. No relay WebSocket was opened during the whole session.
        const relayWs = wsUrls.filter(u => u.includes(RELAY_HOST));
        check(`No WebSocket opened to relay (${RELAY_HOST})`,
              relayWs.length === 0,
              relayWs.length ? relayWs.join(' | ') : '0 ws');

        log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    } catch (e) {
        log('Error: ' + e.message);
        allPassed = false;
    } finally {
        await cleanup();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
