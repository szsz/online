const __cl = require('../../lib/inject-checklist');
// Regression test: the viewer's loading shield must stay visible until the
// new document's canvas has actually painted.
//
// The bug:
//   wasm-loader's `startDocPoll` fires App_LoadingStatus=Initialized when
//   it observes (runtimeReady && canvases > 0 && loaded && changed). After
//   the xlsx-hotswitch fix added `postSwitchAccept` (changed=true 500 ms
//   after the switchdocument cmd is sent), this signal fires within a
//   second of clicking — well before the new document's canvas has
//   actually been painted by the LO Core. The viewer dropped the shield
//   on App_LoadingStatus, leaving the user looking at the OLD document
//   (or a blank canvas) while the spinner was already gone.
//
// The fix:
//   - Viewer ignores App_LoadingStatus past the first prewarm and only
//     trusts WasmDocReady to drop the shield.
//   - wasm-loader posts WasmDocReady from `startDocPoll` ONLY for
//     cold-reload (no in-flight switchdocument); for hot-switches the
//     `trySendSwitch` docReadyInterval (gated on actual canvas-pixel
//     change) posts WasmDocReady. So whichever firing reaches the parent
//     guarantees the canvas already shows the new doc.
//
// This test:
//   Open A.xlsx, then hot-switch to B.xlsx. Sample the shield's `active`
//   class AND the iframe's canvas-pixel hash every 100 ms. Assert that at
//   the moment the shield drops, the canvas pixels differ from their
//   pre-switch baseline (i.e. the new document is visible).

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');
const { seedRecentFiles, waitForSidebar, clickSidebarFile } = require('../../lib/v2-test-helper');

const VIEWER  = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-shield-timing';
const DATA_DIR = path.join(__dirname, '..', 'test', 'data');
const STAMP   = Date.now();
const A_NAME  = `shield-${STAMP}-A.xlsx`;
const B_NAME  = `shield-${STAMP}-B.xlsx`;

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

async function shieldVisible(page) {
    return page.evaluate(() =>
        document.getElementById('editor-shield')?.classList.contains('active') === true);
}

async function canvasFingerprint(page) {
    const fr = await getFrame(page);
    if (!fr) return '';
    return fr.evaluate(() => {
        const c = document.querySelector('canvas');
        if (!c) return '';
        const u = c.toDataURL('image/png');
        // Slice from past the PNG header into actual pixel data so two
        // similar-sized canvases with different content yield different
        // fingerprints.
        return u.substring(200, 1500);
    }).catch(() => '');
}

async function waitForShieldHide(page, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (!(await shieldVisible(page))) return Date.now() - t0;
        await sleep(50);
    }
    return -1;
}

// Iter 191: shield-drop alone is insufficient — when prewarm has
// already lowered the shield, the cold-load click finds it down at
// 0ms even though the canvas hasn't painted yet. Capture the canvas
// fingerprint by polling until it has actual pixel data, so the
// subsequent hot-switch comparison has a real "before" baseline.
async function waitForCanvasContent(page, timeoutMs) {
    const t0 = Date.now();
    let last = '';
    while (Date.now() - t0 < timeoutMs) {
        last = await canvasFingerprint(page);
        if (last && last.length > 100) return last;
        await sleep(200);
    }
    return last;
}

(async () => {
    log('=== Regression: shield must stay up until new doc canvas paints ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-features=SharedArrayBuffer'],
    });

    try {
        // Two xlsx files via v2 (encrypted). Both 1-sheet → both render
        // "Sheet 1 of 1" — exactly the bug scenario where postSwitchAccept
        // makes App_LoadingStatus fire premature.
        const uploads = {};
        for (const [name, src] of [[A_NAME, 'testdoc.xlsx'], [B_NAME, 'convert-to.xlsx']]) {
            const bytes = fs.readFileSync(path.join(DATA_DIR, src));
            const up = await uploadV2(VIEWER, name, bytes);
            uploads[name] = up;
            log(`Uploaded ${name} (${bytes.length}B) → ${up.fileId.substring(0,8)}…`);
        }
        const recentList = [A_NAME, B_NAME].map(n => ({
            b64urlSecret: uploads[n].b64urlSecret, fileId: uploads[n].fileId, cachedName: n,
        }));

        const page = await browser.newPage();
        await page.setCacheEnabled(false);
        await page.setViewport({ width: 1280, height: 800 });
        await seedRecentFiles(page, recentList);
        await page.goto(VIEWER + '/', { waitUntil: 'domcontentloaded' });

        // Wait for prewarm. Iter 208: bare 240×500ms (=120s) was too
        // tight under JOBS=4 contention — relay broker + viewer-server
        // saturate and prewarm slips past 120s, dropping the test
        // before WasmPrewarmReady fires. Scale the bound.
        const prewarmDeadline = Date.now() + env.scaleTimeout(120000);
        let prewarmFired = false;
        while (Date.now() < prewarmDeadline) {
            await sleep(500);
            const fr = await getFrame(page);
            if (fr && await fr.evaluate(() => !!window.__wasmPrewarmReady).catch(() => false)) {
                log(`Prewarm ready (${((Date.now() - (prewarmDeadline - env.scaleTimeout(120000)))/1000).toFixed(1)}s)`);
                prewarmFired = true;
                break;
            }
        }
        if (!prewarmFired) log('Prewarm TIMEOUT after ' + env.scaleTimeout(120000) + 'ms');
        // After prewarm, shield should be down.
        check('Shield down after prewarm', !(await shieldVisible(page)));

        // Open A (cold reload writer→calc)
        log(`\n--- Opening ${A_NAME} (cold reload) ---`);
        await waitForSidebar(page, uploads[A_NAME].fileId, 30000);
        await clickSidebarFile(page, uploads[A_NAME].fileId);
        // 120s: Azure viewer shield stays up until the new doc's canvas
        // paints; cross-type reloads on Azure need 35–60s.
        const aHide = await waitForShieldHide(page, 120000);
        check(`A: shield drops within 120s`, aHide >= 0, aHide >= 0 ? `${aHide}ms` : 'timeout');
        await snap(page, 'A_loaded');

        // Settle so docPoll fully marks A as ready and __switchSendT is OLD
        await sleep(2000);

        // Capture A's canvas pixels as the "before-switch" baseline.
        // Poll until the canvas actually has pixel content — when prewarm
        // already lowered the shield, A may still be loading.
        const preCanvas = await waitForCanvasContent(page, env.scaleTimeout(60000));
        check('A: canvas fingerprint captured', preCanvas.length > 100, `len=${preCanvas.length}`);

        // Open B (hot-switch xlsx → xlsx)
        log(`\n--- Hot-switching to ${B_NAME} ---`);
        const tSwitch = Date.now();
        await clickSidebarFile(page, uploads[B_NAME].fileId);

        // Sample shield state + canvas every 100ms. Record the moment
        // the shield first goes hidden, and the canvas at that moment.
        let shieldDownAt = -1, canvasChangedAt = -1;
        let shieldDownCanvas = null;
        const samples = [];
        // 1800 iters * 100ms = 180s. On Azure, shield-drop after
        // hot-switch can take ~40–60s (waits on canvas paint + relay
        // activation). 600 iters = 60s was tight.
        for (let i = 0; i < 1800; i++) {
            await sleep(100);
            const t = Date.now() - tSwitch;
            const sh = await shieldVisible(page);
            const cv = await canvasFingerprint(page);
            const cvChanged = cv && cv !== preCanvas;
            if (cvChanged && canvasChangedAt < 0) {
                canvasChangedAt = t;
                log(`  t=+${t}ms canvas changed`);
            }
            if (!sh && shieldDownAt < 0) {
                shieldDownAt = t;
                shieldDownCanvas = cv;
                log(`  t=+${t}ms shield dropped (canvasChanged=${cvChanged})`);
            }
            // Sample every ~500ms for log
            if (i % 5 === 0) samples.push({ t, sh, cvChanged });
            if (shieldDownAt > 0 && canvasChangedAt > 0) break;
        }
        await snap(page, 'B_after_switch');

        check('B: shield eventually dropped',
              shieldDownAt > 0, `shieldDownAt=${shieldDownAt}ms`);
        check('B: canvas eventually showed new doc',
              canvasChangedAt > 0, `canvasChangedAt=${canvasChangedAt}ms`);

        // The core regression assertion: at the moment the shield was
        // dropped, the canvas already showed B's pixels (different
        // from A's baseline).
        if (shieldDownAt > 0 && canvasChangedAt > 0) {
            const canvasFirst = canvasChangedAt <= shieldDownAt;
            check('B: canvas changed BEFORE or WITH shield drop (no premature drop)',
                  canvasFirst,
                  `canvasChanged@${canvasChangedAt}ms, shieldDown@${shieldDownAt}ms, ` +
                  `gap=${shieldDownAt - canvasChangedAt}ms`);
            // Also assert shield drops within a reasonable window after
            // canvas paint (so we're not pointlessly delaying it).
            // 45s: on Azure the post-hot-switch status-bar update
            // (which gates the shield drop) races WAN round-trips and
            // can land ~32s after the canvas paint (observed). Local is
            // <1s. The ordering check above (canvas-before-shield-drop)
            // is the real regression signal; this is an upper-bound SLO.
            check('B: shield drops within 45s of canvas paint',
                  canvasFirst && (shieldDownAt - canvasChangedAt) < 45000,
                  `gap=${shieldDownAt - canvasChangedAt}ms`);
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
