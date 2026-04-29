const __cl = require('./lib/inject-checklist');
// test-hotswitch-pptx.js — same-type Impress hot-switch.
//
// Open pptx-1, then switch to pptx-2 via location.hash change. Times:
//   tFirstCanvas: canvas pixels change after switch
//   tStatusReady: #StatusDocPos shows "Slide N of M" for the new doc
//   tDomVerified: status text matches AND canvas painted
// Pass condition: tDomVerified after switch ≤ 5 s.
//
// Iter11: per-doctype kInPlaceCap (kit/ChildSession.cpp:434) — pptx cap=1
// re-enables wasm_reload_doc_in_place, avoiding the full
// loKit->documentLoad fall-through (~12-16 s).

const { launch, sleep } = require('./lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;

const SHOT_DIR = '/tmp/static-deploy/public/shots-hotswitch-pptx';
const FIXTURE_1 = path.join(__dirname, '..', 'test', 'data', 'testdoc.pptx');
const FIXTURE_2 = path.join(__dirname, '..', 'test', 'data', 'rare-fonts.pptx');
const NAME_1 = 'hotswitch-pptx-1-' + Date.now() + '.pptx';
const NAME_2 = 'hotswitch-pptx-2-' + Date.now() + '.pptx';

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

async function probeIframeStatus(page) {
    try {
        const fr = page.frames().find(f => f.url().includes('cool.html'));
        if (!fr) return { hasCanvas: false, statusText: '', statusOk: false, canvasHash: null };
        return await fr.evaluate(() => {
            const c = document.querySelector('canvas');
            // Impress puts slide count in #SlideStatus, NOT #StatusDocPos.
            const ss = document.querySelector('#SlideStatus');
            const sd = document.querySelector('#StatusDocPos');
            const txt = ((ss && ss.textContent || '') + ' ' + (sd && sd.textContent || '')).trim();
            let canvasHash = null;
            if (c) {
                try {
                    const ctx = c.getContext('2d', { willReadFrequently: true });
                    const w = Math.min(400, c.width), h = Math.min(300, c.height);
                    if (w > 0 && h > 0) {
                        const data = ctx.getImageData(0, 0, w, h).data;
                        let h1 = 5381, h2 = 52711;
                        for (let i = 0; i < data.length; i += 7) {
                            h1 = ((h1 * 33) ^ data[i]) >>> 0;
                            h2 = ((h2 * 31) ^ data[i]) >>> 0;
                        }
                        canvasHash = (h1.toString(16) + h2.toString(16));
                    }
                } catch (_) { canvasHash = 'denied'; }
            }
            return {
                hasCanvas: !!c,
                statusText: txt,
                statusOk: /Slide\s+\d+\s+of\s+\d+/i.test(txt),
                canvasHash,
            };
        }).catch(() => ({ hasCanvas: false, statusText: '', statusOk: false, canvasHash: null }));
    } catch (e) { return { hasCanvas: false, statusText: '', statusOk: false, canvasHash: null }; }
}

async function waitForVerified(page, label, opts) {
    opts = opts || {};
    const timeoutMs = opts.timeoutMs || 60000;
    const baselineHash = opts.baselineHash || null;
    const t0 = Date.now();
    let tFirstCanvas = null, tStatusReady = null, tHashChanged = null;
    let lastHash = null;
    while (Date.now() - t0 < timeoutMs) {
        const p = await probeIframeStatus(page);
        const dt = Date.now() - t0;
        lastHash = p.canvasHash;
        if (tFirstCanvas === null && p.hasCanvas) {
            tFirstCanvas = dt;
            log(`  [${label}] canvas at ${(dt/1000).toFixed(2)}s hash=${p.canvasHash || 'null'}`);
        }
        if (tStatusReady === null && p.statusOk) {
            tStatusReady = dt;
            log(`  [${label}] status "${p.statusText}" at ${(dt/1000).toFixed(2)}s`);
        }
        const hashOk = !baselineHash || (p.canvasHash && p.canvasHash !== baselineHash);
        if (tHashChanged === null && baselineHash && hashOk) {
            tHashChanged = dt;
            log(`  [${label}] canvas-hash changed at ${(dt/1000).toFixed(2)}s (was=${baselineHash} now=${p.canvasHash})`);
        }
        if (p.hasCanvas && p.statusOk && hashOk) {
            return { tFirstCanvas, tStatusReady, tHashChanged, tDomVerified: dt, statusText: p.statusText, canvasHash: p.canvasHash };
        }
        await sleep(80);
    }
    return { tFirstCanvas, tStatusReady, tHashChanged, tDomVerified: null, canvasHash: lastHash, error: 'timeout' };
}

(async () => {
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    log(`[setup] Uploading ${NAME_1}`);
    const up1 = await uploadV2(VIEWER, NAME_1, fs.readFileSync(FIXTURE_1));
    log(`[setup] Uploading ${NAME_2}`);
    const up2 = await uploadV2(VIEWER, NAME_2, fs.readFileSync(FIXTURE_2));
    check('Fixtures uploaded',
          !!(up1.fileId && up2.fileId),
          'fileId1=' + up1.fileId.slice(0, 8) + ' fileId2=' + up2.fileId.slice(0, 8));

    const { browser, cleanup } = await launch();
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });

        page.on('pageerror', e => log(`[pageerror] ${e.message}`));
        page.on('console', m => {
            const t = m.text();
            if (/SWITCHDOC|inPlace|documentLoad|TIMING|error|fail/i.test(t))
                log(`[page] ${t.slice(0, 240)}`);
        });

        log('[step1] Opening pptx-1 cold');
        await page.goto(VIEWER + '/?planc=1#file=' + up1.b64urlSecret,
            { waitUntil: 'domcontentloaded' });
        const r1 = await waitForVerified(page, 'cold-pptx1', { timeoutMs: 180000 });
        check('pptx-1 verified after cold open',
              r1.tDomVerified !== null,
              r1.tDomVerified !== null
                ? 'visible at ' + (r1.tDomVerified/1000).toFixed(2) + 's'
                : 'TIMEOUT');
        await snap(page, 'after_cold_pptx1');

        log('[step2] Hot-switch to pptx-2');
        const baselineHash = r1.canvasHash;
        log('[step2] baseline canvas hash = ' + baselineHash);
        const tSwitchStart = Date.now();
        await page.evaluate((secret) => {
            location.hash = '#file=' + secret;
        }, up2.b64urlSecret);
        const r2 = await waitForVerified(page, 'switch-pptx2', { timeoutMs: 60000, baselineHash });
        const switchWall = Date.now() - tSwitchStart;
        check('pptx-2 verified after hot-switch',
              r2.tDomVerified !== null,
              r2.tDomVerified !== null
                ? 'visible at ' + (r2.tDomVerified/1000).toFixed(2)
                  + 's (wall ' + (switchWall/1000).toFixed(2) + 's)'
                : 'TIMEOUT');
        check('Hot-switch wall ≤ 5 s',
              r2.tDomVerified !== null && r2.tDomVerified <= 5000,
              r2.tDomVerified !== null
                ? (r2.tDomVerified/1000).toFixed(2) + 's'
                : 'no measurement');
        await snap(page, 'after_switch_pptx2');

        const finalStatus = r2.statusText || '';
        check('Status text reports a slide count',
              /Slide\s+\d+\s+of\s+\d+/i.test(finalStatus),
              finalStatus);

    } finally {
        await cleanup();
    }

    if (allPassed) { log('✓ ALL TESTS PASSED'); process.exit(0); }
    else            { log('✗ SOME TESTS FAILED'); process.exit(1); }
})().catch(e => { log('FATAL: ' + e.stack); process.exit(2); });
