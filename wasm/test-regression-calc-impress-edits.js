const __cl = require('./lib/inject-checklist');
// Regression test: Calc and Impress edits must fire `invalidatetiles:`
// AND the relay-adapter must forward those tiles to remote peers.
//
// Bug context (found via test-stress-multidoc.js):
//   The stress test reported "no invalidatetiles event after typing"
//   for many Calc and Impress rounds. Two root causes:
//     (1) Test-side: the observer hook installed BEFORE the relay-adapter
//         finished wrapping ws.onmessage, so the adapter's later wrap
//         clobbered ours and we saw zero invalidatetiles even though
//         they fired correctly.
//     (2) Test-side: the observer's setInterval was fire-and-forget in
//         the iframe's event loop — by the time the parent test typed,
//         the wrap may not have actually been installed yet.
//
//   Both were in the test infrastructure, but they masked the real
//   question: do Calc/Impress edits actually propagate? This test
//   verifies the production behaviour:
//     - Open Calc, click cell, type → invalidatetiles fires locally
//       AND a peer on the same room sees its own invalidatetiles
//       (forwarded by relay-adapter).
//     - Same for Impress (with a double-click into a placeholder).
//
//   If a future change to relay-adapter accidentally stops forwarding
//   `invalidatetiles:` from remote peers, this test fails.

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');

const VIEWER  = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-calc-impress';
const DATA_DIR = path.join(__dirname, '..', 'test', 'data');
const STAMP = Date.now();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const log = m => console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`);

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2,'0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch (e) {}
}

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}${ev?' ['+ev+']':''}`); allPassed = false; }
}

async function getFrame(page) {
    return page.frames().find(f => f.url().includes('cool.html'));
}

// Hook ws.onmessage and count `invalidatetiles:` events. Wait until the
// hook is actually installed before returning (the relay-adapter installs
// its own hook asynchronously, and a fire-and-forget wrap can be clobbered
// before we observe anything).
async function installEditObserver(page) {
    const fr = await getFrame(page);
    if (!fr) return false;
    return fr.evaluate(async () => {
        window.__editTick = window.__editTick || 0;
        function isOurs(fn) { return typeof fn === 'function' && fn.__editTickHook === true; }
        function wrap(ws) {
            if (!ws || !ws.onmessage || isOurs(ws.onmessage)) return false;
            const orig = ws.onmessage;
            const hooked = function(ev) {
                try {
                    const s = typeof ev.data === 'string' ? ev.data : '';
                    if (s.indexOf('invalidatetiles:') === 0) window.__editTick++;
                } catch (e) {}
                return orig.apply(this, arguments);
            };
            hooked.__editTickHook = true;
            ws.onmessage = hooked;
            return true;
        }
        let installed = false;
        for (let i = 0; i < 100; i++) {
            if (wrap(globalThis.TheFakeWebSocket)) { installed = true; break; }
            await new Promise(r => setTimeout(r, 100));
        }
        if (installed && !window.__editTickWatchdog) {
            window.__editTickWatchdog = setInterval(() => {
                const ws = globalThis.TheFakeWebSocket;
                if (ws && ws.onmessage && !isOurs(ws.onmessage)) wrap(ws);
            }, 250);
        }
        return installed;
    });
}

async function getEditTick(page) {
    const fr = await getFrame(page);
    if (!fr) return 0;
    return fr.evaluate(() => window.__editTick || 0).catch(() => 0);
}

async function waitForEditTick(page, baseline, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const t = await getEditTick(page);
        if (t > baseline) return t;
        await sleep(200);
    }
    return -1;
}

async function openViewer(browser) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setCacheEnabled(false);
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(VIEWER + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let i = 0; i < 240; i++) {
        await sleep(500);
        const fr = await getFrame(page);
        if (fr && await fr.evaluate(() => !!window.__wasmPrewarmReady).catch(() => false)) {
            return { ctx, page, prewarmMs: i*500 };
        }
    }
    throw new Error('prewarm timeout');
}

async function clickFile(page, name) {
    await page.waitForFunction(n => !!document.querySelector(`.file[data-name="${n}"]`),
        { timeout: 30000 }, name);
    await page.evaluate(n =>
        document.querySelector(`.file[data-name="${n}"]`).click(), name);
}

async function waitForDocReady(page, fileName, timeoutMs) {
    // For cross-type opens (writer→calc, writer→impress) the viewer
    // REPLACES the iframe. We must wait for the new iframe whose URL
    // contains the requested filename — otherwise we read stale state
    // from the previous iframe and conclude "ready" instantly.
    const enc = encodeURIComponent(fileName);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const fr = await getFrame(page);
        if (fr && fr.url().includes(enc)) {
            const ready = await fr.evaluate(() => !!window.__wasmPrewarmReady).catch(() => false);
            if (ready) {
                for (let j = 0; j < 60; j++) {
                    const ok = await fr.evaluate(() =>
                        !!(globalThis.TheFakeWebSocket && globalThis.TheFakeWebSocket.send)
                        && !!(globalThis.Module && globalThis.Module.calledRun)
                    ).catch(() => false);
                    if (ok) return Date.now() - t0;
                    await sleep(200);
                }
            }
        }
        await sleep(250);
    }
    return -1;
}

async function focusForType(page, docType) {
    const fr = await getFrame(page);
    if (!fr) return;
    let x = 1500, y = 1500, count = 1;
    if (docType === 'impress') { x = 8000; y = 3500; count = 2; }
    await fr.evaluate((cx, cy, cnt) => {
        globalThis.TheFakeWebSocket.send(
            `mouse type=buttondown x=${cx} y=${cy} count=${cnt} buttons=1 modifier=0`);
        globalThis.TheFakeWebSocket.send(
            `mouse type=buttonup x=${cx} y=${cy} count=${cnt} buttons=1 modifier=0`);
    }, x, y, count);
}

async function typeOne(page, ch) {
    const fr = await getFrame(page);
    await fr.evaluate(c =>
        globalThis.TheFakeWebSocket.send('textinput id=0 text=' + c), ch);
}

async function uploadDoc(browser, name, src) {
    const up = await browser.newPage();
    await up.goto(VIEWER + '/');
    const bytes = fs.readFileSync(path.join(DATA_DIR, src));
    await up.evaluate(async (n, a) =>
        fetch('/api/files/' + encodeURIComponent(n), { method: 'POST', body: new Blob([new Uint8Array(a)]) }),
        name, Array.from(bytes));
    await up.close();
    log(`Uploaded ${name} (${bytes.length}B)`);
}

(async () => {
    log('=== Regression: Calc & Impress edits propagate via invalidatetiles ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-features=SharedArrayBuffer'],
    });

    try {
        const CALC_NAME = `regr-ci-${STAMP}.xlsx`;
        const PPTX_NAME = `regr-ci-${STAMP}.pptx`;
        await uploadDoc(browser, CALC_NAME, 'testdoc.xlsx');
        await uploadDoc(browser, PPTX_NAME, 'testdoc.pptx');

        for (const [docType, fileName] of [['calc', CALC_NAME], ['impress', PPTX_NAME]]) {
            log(`\n--- ${docType.toUpperCase()}: ${fileName} ---`);

            // Two browsers — A is the editor, B is the peer.
            const A = await openViewer(browser);
            const B = await openViewer(browser);

            for (const [b, label] of [[A, 'A'], [B, 'B']]) {
                await clickFile(b.page, fileName);
                const took = await waitForDocReady(b.page, fileName, 60000);
                check(`${label} loaded ${docType}`, took >= 0, took >= 0 ? `${took}ms` : 'timeout');
                if (took < 0) throw new Error(`${label} did not load`);
                const installed = await installEditObserver(b.page);
                check(`${label} edit observer installed`, installed === true);
            }
            await snap(A.page, `${docType}_loaded`);

            // Settle so peers see each other.
            await sleep(8000);

            // A clicks to focus then types 3 chars.
            await focusForType(A.page, docType);
            await sleep(docType === 'impress' ? 1500 : 250);
            const aPre = await getEditTick(A.page);
            const bPre = await getEditTick(B.page);
            log(`  pre-type: A.tick=${aPre} B.tick=${bPre}`);

            for (const ch of 'ABC') {
                await typeOne(A.page, ch);
                await sleep(150);
            }
            // Wait for both A's local and B's remote-forwarded invalidatetiles.
            const aAfter = await waitForEditTick(A.page, aPre, 15000);
            const bAfter = await waitForEditTick(B.page, bPre, 15000);
            log(`  post-type: A.tick=${aAfter} B.tick=${bAfter}`);
            check(`${docType} A sees own invalidatetiles after typing`,
                  aAfter > aPre, `aPre=${aPre} aAfter=${aAfter}`);
            check(`${docType} B sees A's edit (invalidatetiles forwarded by relay-adapter)`,
                  bAfter > bPre, `bPre=${bPre} bAfter=${bAfter}`);

            await snap(A.page, `${docType}_after_edit_A`);
            await snap(B.page, `${docType}_after_edit_B`);

            await A.ctx.close();
            await B.ctx.close();
        }

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
