const __cl = require('./lib/inject-checklist');
// Regression test: xlsx → xlsx hot-switch must complete.
//
// The bug: wasm-loader's docPoll required the status-bar text to have
// CHANGED from its pre-switch value before declaring the new doc "loaded".
// Two similar .xlsx files can render the same status text (e.g. both show
// "Sheet 1 of 1"), so `changed` stayed false forever, `__wasmPrewarmReady`
// was never set, and the viewer's loading shield never dropped. Same bug
// applied to two similar .pptx files ("Slide 1 of 1").
//
// Fix: once wasm-loader has dispatched a switchdocument cmd AND a small
// grace window has elapsed, the Kit is authoritative for "new doc
// loaded" — we no longer require the displayed status text to literally
// differ.
//
// This test:
//   1. Opens xlsx A via the viewer (cold reload from writer prewarm).
//   2. Hot-switches to xlsx B.
//   3. Asserts B became ready (App_LoadingStatus OR __wasmPrewarmReady)
//      within a strict budget. Before the fix this timed out at 60s.

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-xlsx-hotswitch';
const DATA_DIR = path.join(__dirname, '..', 'test', 'data');
const STAMP = Date.now();
const A_NAME = `xlsx-hotswitch-${STAMP}-A.xlsx`;
const B_NAME = `xlsx-hotswitch-${STAMP}-B.xlsx`;

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

async function getIframeState(page) {
    const fr = await getFrame(page);
    if (!fr) return null;
    try {
        return await fr.evaluate(() => ({
            prewarmReady: !!window.__wasmPrewarmReady,
            initialDocLoaded: !!window.__wasmInitialDocLoaded,
            dp: document.querySelector('#StatusDocPos')?.textContent || '',
            wc: document.querySelector('#StateWordCount')?.textContent || '',
            url: window.location.href,
            switchSendT: window.__switchSendT || 0,
        }));
    } catch (e) { return null; }
}

async function waitForNewDocReady(page, timeoutMs) {
    // Wait for either:
    //  a) App_LoadingStatus=Initialized posted by the iframe (which fires
    //     only when __wasmPrewarmReady transitions to true), or
    //  b) __wasmPrewarmReady observed true via a direct frame read.
    // We use (b) as the primary signal because (a) depends on listening
    // before the event fires.
    const t0 = Date.now();
    // First, wait for __wasmPrewarmReady to be RESET to false (which
    // happens synchronously inside the iframe's hashchange handler).
    // That proves we actually caught the switch in flight and aren't
    // reading stale state.
    let sawFalse = false;
    while (Date.now() - t0 < 3000) {
        const s = await getIframeState(page);
        if (s && s.prewarmReady === false) { sawFalse = true; break; }
        await sleep(100);
    }
    if (!sawFalse) log('  (hashchange flag reset not observed — possibly already past)');

    // Now wait for __wasmPrewarmReady to come back to true.
    while (Date.now() - t0 < timeoutMs) {
        const s = await getIframeState(page);
        if (s && s.prewarmReady === true) {
            return { ok: true, ms: Date.now() - t0, state: s };
        }
        await sleep(250);
    }
    return { ok: false, ms: timeoutMs, state: await getIframeState(page) };
}

(async () => {
    log('=== Regression: xlsx → xlsx hot-switch must not hang ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-features=SharedArrayBuffer'],
    });

    try {
        // Upload two xlsx files. testdoc.xlsx and convert-to.xlsx both have
        // 1 sheet → both render "Sheet 1 of 1" in the status bar, which is
        // the exact condition that triggered the bug.
        const up = await browser.newPage();
        await up.goto(VIEWER + '/');
        for (const [name, src] of [[A_NAME, 'testdoc.xlsx'], [B_NAME, 'convert-to.xlsx']]) {
            const bytes = fs.readFileSync(path.join(DATA_DIR, src));
            await up.evaluate(async (n, a) => {
                await fetch('/api/files/' + encodeURIComponent(n), {
                    method: 'POST', body: new Blob([new Uint8Array(a)]) });
            }, name, Array.from(bytes));
            log(`Uploaded ${name} (${src}, ${bytes.length}B)`);
        }
        await up.close();

        const page = await browser.newPage();
        await page.setCacheEnabled(false);  // force fresh wasm-loader.js etc.
        await page.setViewport({ width: 1280, height: 800 });
        // Forward iframe console for debugging
        page.on('console', m => {
            const t = m.text();
            if (/docPoll-DBG|switch|prewarm|SWITCHDOC/i.test(t))
                console.log(`  [iframe] ${t.substring(0, 240)}`);
        });
        await page.goto(VIEWER + '/', { waitUntil: 'domcontentloaded' });

        // Wait for prewarm
        let prewarmOk = false;
        for (let i = 0; i < 240; i++) {
            await sleep(500);
            const fr = await getFrame(page);
            if (fr) {
                const ready = await fr.evaluate(() => !!window.__wasmPrewarmReady).catch(() => false);
                if (ready) { prewarmOk = true; log(`Prewarm ready (${(i*0.5).toFixed(1)}s)`); break; }
            }
        }
        check('Prewarm completes', prewarmOk);
        if (!prewarmOk) throw new Error('prewarm failed');

        // Open A (cold reload because prewarm=writer, A=calc)
        log(`\n--- Opening ${A_NAME} (first xlsx) ---`);
        await page.waitForFunction(n => !!document.querySelector(`.file[data-name="${n}"]`),
            { timeout: 15000 }, A_NAME);
        await page.evaluate(n =>
            document.querySelector(`.file[data-name="${n}"]`).click(), A_NAME);

        const resA = await waitForNewDocReady(page, 60000);
        check(`${A_NAME} ready after cold reload`, resA.ok, resA.ok ? `${resA.ms}ms` : 'timeout');
        await snap(page, 'A_loaded');
        if (!resA.ok) throw new Error('A did not load');
        log(`  A state: dp="${resA.state.dp}" wc="${resA.state.wc}"`);

        // Let doc settle briefly so subsequent hot-switch is clean
        await sleep(2000);

        // Hot-switch to B (calc → calc). Both xlsx have 1 sheet → both
        // produce "Sheet 1 of 1" status → the bug condition.
        log(`\n--- Hot-switching to ${B_NAME} (xlsx → xlsx) ---`);
        const tSwitch = Date.now();
        await page.evaluate(n =>
            document.querySelector(`.file[data-name="${n}"]`).click(), B_NAME);

        // This is the core regression assertion. With the bug, this
        // resolves at ~60s (timeout). With the fix, it completes in a
        // few seconds. 15s is a comfortable ceiling that cleanly
        // separates broken from fixed.
        const resB = await waitForNewDocReady(page, 30000);
        const switchMs = Date.now() - tSwitch;
        check(`${B_NAME} ready after xlsx → xlsx hot-switch`,
              resB.ok, resB.ok ? `${resB.ms}ms, wall=${switchMs}ms` : `timeout (wall=${switchMs}ms)`);
        check(`xlsx → xlsx hot-switch under 15s`,
              resB.ok && switchMs < 15000, `wall=${switchMs}ms`);
        await snap(page, 'B_loaded');

        if (resB.ok) {
            log(`  B state: dp="${resB.state.dp}" wc="${resB.state.wc}"`);
            // Both xlsx likely have same status text — prove the bug
            // condition was actually present (not incidentally avoided):
            if (resA.state.dp === resB.state.dp) {
                log(`  ✓ Note: dp("${resA.state.dp}") identical for A and B — exactly the bug scenario`);
            } else {
                log(`  Note: dp differs between A and B (${resA.state.dp} vs ${resB.state.dp}) — bug condition not fully exercised`);
            }
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
