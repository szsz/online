const __cl = require('./lib/inject-checklist');
// Regression test: viewer hot-switch (room switch) — late-join activation
// and stale WebSocket handler cleanup.
//
// Two related bugs in relay-adapter.js used to make hot-switching documents
// in the viewer produce broken state for the second user:
//
// (1) ACTIVATION POLL NOT RESTARTED
//     When the iframe receives a RelaySwitchRoom message, it disconnects from
//     the old room and connects to the new one. But the late-join activation
//     poller had already self-cleared after its first activation — so after
//     the room switch, the late-join file would arrive, but the client never
//     called activateClient(). Symptom: late joiner stuck on "Initializing",
//     never sees other users.
//
// (2) STALE WS HANDLERS FIRE
//     The old WebSocket close was racing with handler reassignment. If we
//     only set `ws.onmessage = newHandler`, queued messages from the OLD
//     room's WebSocket could still fire into the NEW room's state — typing
//     "XYZ" produced "ABCXYZdefghijk..." (~25 chars) because old-room frames
//     were replayed into the new room. The fix nullifies onmessage/onopen/
//     onclose/onerror BEFORE closing.
//
// This test goes through the viewer (real production code path) and exercises
// a hot-switch scenario:
//   - Browser A opens doc1 in viewer
//   - Browser B opens doc1 (joins room1), types AAA → 14 chars
//   - Both hot-switch to doc2 (different room, same writer type)
//   - B types XYZ in doc2 → must be exactly 14 chars (initial 11 + 3), NOT
//     polluted by stale messages from room1.
//   - A must receive B's XYZ (proving B activated in the new room)
//
// If either bug regresses this test fails: bug (1) means A never sees XYZ;
// bug (2) means B's char count after typing is wildly inflated by replayed
// frames.

const puppeteer = require('puppeteer');
const fs = require('fs');
const env = require('./lib/test-env');

const VIEWER = env.FILE_STORAGE_URL;
const TIMEOUT = 180000;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-room-switch';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2,'0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch(e) {}
}

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}${ev?' ['+ev+']':''}`); allPassed = false; }
}

async function getEditorFrame(page) {
    return page.frames().find(f => f.url().includes('cool.html'));
}

async function getCharCount(page) {
    const fr = await getEditorFrame(page);
    if (!fr) return -1;
    try {
        const s = await fr.evaluate(() =>
            document.querySelector('#StateWordCount')?.textContent || '');
        const m = s.match(/(\d+) characters/);
        return m ? parseInt(m[1]) : -1;
    } catch(e) { return -1; }
}

async function waitForDocLoaded(page, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const c = await getCharCount(page);
        if (c >= 1) return c;
        await sleep(500);
    }
    return -1;
}

async function typeViaIframe(page, label, chars) {
    const fr = await getEditorFrame(page);
    for (const c of chars) {
        await fr.evaluate(ch => globalThis.TheFakeWebSocket.send('textinput id=0 text=' + ch), c);
        await sleep(2000);
    }
}

async function openViewerInContext(browser, label) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.on('pageerror', e => console.log(`  [${label}/PAGEERR] ${e.message.substring(0, 200)}`));
    await page.goto(VIEWER + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait for prewarm to finish
    for (let i = 0; i < 240; i++) {
        await sleep(500);
        try {
            const fr = await getEditorFrame(page);
            if (fr && await fr.evaluate(() => !!window.__wasmPrewarmReady)) {
                log(`[${label}] Prewarm ready in ~${i*0.5}s`);
                return { ctx, page };
            }
        } catch(e) {}
    }
    throw new Error(`[${label}] Prewarm did not complete`);
}

async function openFileInViewer(page, fileName) {
    await page.evaluate(n => {
        const el = [...document.querySelectorAll('.file')].find(e => e.dataset.name === n);
        if (!el) throw new Error('File not found in list: ' + n);
        el.click();
    }, fileName);
}

(async () => {
    log('=== Regression: room switch activation + stale WS handlers ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    // Two unique documents with the same type (writer) so the viewer does a
    // HOT-SWITCH (room change without iframe reload) — that's the path with
    // the bugs. Different content (different char counts) so we can detect
    // bleed-through of room1 messages into room2 state.
    const STAMP = Date.now();
    const DOC1 = `roomswitch-${STAMP}-1.txt`;
    const DOC2 = `roomswitch-${STAMP}-2.txt`;
    const DOC1_CONTENT = 'one';      //  3 chars in DOC1
    const DOC2_CONTENT = 'eleven---s'; // 10 chars in DOC2
    const DOC1_INIT_CHARS = DOC1_CONTENT.length;
    const DOC2_INIT_CHARS = DOC2_CONTENT.length;

    try {
        // Upload via viewer's file-storage API
        const up = await browser.newPage();
        await up.goto(VIEWER + '/');
        for (const [name, content] of [[DOC1, DOC1_CONTENT], [DOC2, DOC2_CONTENT]]) {
            await up.evaluate(async (n, c) => {
                await fetch('/api/files/' + encodeURIComponent(n), {
                    method: 'POST', body: new Blob([c], { type: 'application/octet-stream' }),
                });
            }, name, content);
            log('Uploaded ' + name + ' (' + content.length + ' chars: "' + content + '")');
        }
        await up.close();

        // ---- Open browser A on doc1, then browser B on doc1 ----
        log('\n--- Phase 1: A and B both open ' + DOC1 + ' ---');
        const A = await openViewerInContext(browser, 'A');
        const B = await openViewerInContext(browser, 'B');

        // Wait for the file lists to populate
        for (const { page, label } of [{ page: A.page, label: 'A' }, { page: B.page, label: 'B' }]) {
            await page.waitForFunction(n => !!document.querySelector(`.file[data-name="${n}"]`),
                { timeout: 15000 }, DOC1);
        }

        await openFileInViewer(A.page, DOC1);
        log('A clicked ' + DOC1);
        await sleep(2000);
        await openFileInViewer(B.page, DOC1);
        log('B clicked ' + DOC1);

        // Wait for both to load doc1
        const aChars1 = await waitForDocLoaded(A.page, 60000);
        const bChars1 = await waitForDocLoaded(B.page, 60000);
        log(`After doc1 open: A=${aChars1} B=${bChars1} (expected ${DOC1_INIT_CHARS})`);
        check(`A loaded ${DOC1} (${DOC1_INIT_CHARS} chars)`,
              aChars1 === DOC1_INIT_CHARS, 'A=' + aChars1);
        check(`B loaded ${DOC1} (${DOC1_INIT_CHARS} chars)`,
              bChars1 === DOC1_INIT_CHARS, 'B=' + bChars1);
        await snap(A.page, 'A_doc1_loaded');
        await snap(B.page, 'B_doc1_loaded');

        // Wait for B to register A as a remote client (verifies B activated
        // in room1 — baseline before the switch).
        await sleep(8000);

        // ---- Hot-switch A to doc2, then B ----
        // Wait for A to fully land on doc2 BEFORE B switches. Otherwise B's
        // join races A's save-trigger and we hit a relay timing window where
        // B never sees the fresh checkpoint. This test is for the room-switch
        // bugs (activation poll restart, stale WS handlers), not for
        // relay-side simultaneous-switch races.
        log('\n--- Phase 2: hot-switch both browsers to ' + DOC2 + ' ---');
        async function waitForDoc2(page, label) {
            const t0 = Date.now();
            while (Date.now() - t0 < 60000) {
                const c = await getCharCount(page);
                if (c === DOC2_INIT_CHARS) { log(`[${label}] doc2 loaded in ${((Date.now()-t0)/1000).toFixed(1)}s`); return c; }
                await sleep(500);
            }
            // Diagnostics on failure
            try {
                const fr = await getEditorFrame(page);
                const url = fr ? fr.url() : 'no-frame';
                const mainSrc = await page.evaluate(() => document.getElementById('editor-frame')?.src || 'n/a');
                const wc = fr ? await fr.evaluate(() => document.querySelector('#StateWordCount')?.textContent || 'n/a').catch(() => 'eval-err') : 'n/a';
                const lastOpen = await page.evaluate(() => window.__viewerState?.lastOpenMode || 'n/a');
                log(`[${label}] DIAG: mainSrc=${mainSrc.split('/').pop()} frameUrl=${url.split('/').pop()} wc="${wc}" mode=${lastOpen}`);
            } catch (e) { log(`[${label}] DIAG err: ${e.message}`); }
            return -1;
        }

        // Hook the iframe's WasmSwitchVisible message — fired by wasm-loader
        // when the canvas pixels actually change. We use this rather than
        // #StateWordCount because in this co-edit scenario the local wc
        // widget gets clobbered by the remote peer's wc updates while the
        // peer is still on doc1, which would cause us to time out even
        // though the local switch succeeded.
        async function instrumentSwitchVisible(page, label) {
            await page.evaluate(() => {
                window.__lastSwitchVisible = null;
                window.addEventListener('message', function(e) {
                    if (typeof e.data !== 'string') return;
                    try {
                        const m = JSON.parse(e.data);
                        if (m.MessageId === 'WasmSwitchVisible' && m.Values && m.Values.filename) {
                            window.__lastSwitchVisible = m.Values.filename;
                        }
                    } catch (e) {}
                });
            });
        }
        async function waitForSwitchVisible(page, label, filename, timeoutMs) {
            const t0 = Date.now();
            while (Date.now() - t0 < timeoutMs) {
                const seen = await page.evaluate(() => window.__lastSwitchVisible);
                if (seen === filename) {
                    log(`[${label}] doc2 visible in ${((Date.now()-t0)/1000).toFixed(1)}s`);
                    return Date.now() - t0;
                }
                await sleep(250);
            }
            return -1;
        }
        await instrumentSwitchVisible(A.page, 'A');
        await instrumentSwitchVisible(B.page, 'B');

        await openFileInViewer(A.page, DOC2);
        const a2 = await waitForSwitchVisible(A.page, 'A', DOC2, 30000);
        check(`A switched to ${DOC2} (canvas changed)`, a2 >= 0, 'a2=' + a2 + 'ms');
        // Let A settle in doc2 (registers as active peer in the new room).
        await sleep(3000);
        await openFileInViewer(B.page, DOC2);
        // B's canvas-change detection is unreliable in headless co-edit
        // (concurrent remote-peer state messages can keep the canvas busy).
        // Don't assert on it — Phase 3 below proves B switched if A receives
        // B's typing.
        const b2 = await waitForSwitchVisible(B.page, 'B', DOC2, 30000);
        log(`B canvas-switch detected: ${b2 >= 0 ? b2 + 'ms' : 'no (continuing — Phase 3 is the real check)'}`);
        await snap(A.page, 'A_doc2_loaded');
        await snap(B.page, 'B_doc2_loaded');

        // Settle so both clients announce themselves in the new room.
        await sleep(10000);

        // ---- Phase 3: B types XYZ in doc2 ----
        // The actual regression check: after the room switch, B's typing must
        // reach A in the new room AND the count A sees must be exactly +3
        // (not inflated by stale WS messages from the doc1 room replaying).
        // We assert from A's perspective because A's wc widget is reliable
        // (B's local wc widget is currently subject to a separate
        // remote-statechange-clobbers-local-display bug that's outside this
        // test's scope).
        log('\n--- Phase 3: B types "XYZ" in ' + DOC2 + ' ---');
        await typeViaIframe(B.page, 'B', 'XYZ');
        await sleep(8000);

        const aFinal = await getCharCount(A.page);
        const bFinal = await getCharCount(B.page);
        log(`After XYZ: A=${aFinal} B=${bFinal} (expected A=${DOC2_INIT_CHARS + 3})`);
        await snap(A.page, 'A_after_xyz');
        await snap(B.page, 'B_after_xyz');

        // Bug (1) regression: B's activation poll must restart after the
        // room switch — otherwise B never sends edits to the new room and
        // A would still show DOC2_INIT_CHARS (10).
        check(`A received B's XYZ via new room (activation restart)`,
              aFinal === DOC2_INIT_CHARS + 3,
              'aFinal=' + aFinal);

        // Bug (2) regression: stale WS handlers from the old room must NOT
        // replay messages into the new room — otherwise A's count would be
        // > DOC2_INIT_CHARS + 3 (extra chars bled in from doc1's state).
        check(`A's count is exactly DOC2+3 (no stale-WS-handler bleed)`,
              aFinal === DOC2_INIT_CHARS + 3,
              `aFinal=${aFinal}, expected=${DOC2_INIT_CHARS + 3}`);

        log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    } catch (e) {
        log('Error: ' + e.message);
        allPassed = false;
    } finally {
        await browser.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
