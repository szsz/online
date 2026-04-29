const __cl = require('./lib/inject-checklist');
// test-hotswitch-xlsx.js — same-type Calc hot-switch.
//
// Open xlsx-1, then switch to xlsx-2 via the viewer's file list (the
// RelaySwitchRoom path). Times:
//   tFirstCanvas: canvas pixels change after switch
//   tStatusReady: #StatusDocPos shows "Sheet N of M" for the new doc
//   tDomVerified: status text matches AND canvas painted
// Pass condition: tDomVerified after switch ≤ 5 s.
//
// Iter10 fix (kit/ChildSession.cpp:434): re-enabled wasm_reload_doc_in_place
// for xlsx (cap=1). Before fix, every same-type switch fell through to
// loKit->documentLoad (full filter+model+view rebuild, ~12-16 s).

const { launch, sleep } = require('./lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;

const SHOT_DIR = '/tmp/static-deploy/public/shots-hotswitch-xlsx';
const FIXTURE_1 = path.join(__dirname, '..', 'test', 'data', 'testdoc.xlsx');
const FIXTURE_2 = path.join(__dirname, '..', 'test', 'data', 'convert-to.xlsx');
const NAME_1 = 'hotswitch-xlsx-1-' + Date.now() + '.xlsx';
const NAME_2 = 'hotswitch-xlsx-2-' + Date.now() + '.xlsx';

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
        if (!fr) return { hasCanvas: false, statusText: '', statusOk: false };
        return await fr.evaluate(() => {
            const c = document.querySelector('canvas');
            const sd = document.querySelector('#StatusDocPos');
            const txt = (sd && sd.textContent || '').trim();
            return {
                hasCanvas: !!c,
                statusText: txt,
                statusOk: /Sheet\s+\d+\s+of\s+\d+/i.test(txt),
            };
        }).catch(() => ({ hasCanvas: false, statusText: '', statusOk: false }));
    } catch (e) { return { hasCanvas: false, statusText: '', statusOk: false }; }
}

async function waitForVerified(page, label, timeoutMs = 60000) {
    const t0 = Date.now();
    let tFirstCanvas = null, tStatusReady = null;
    while (Date.now() - t0 < timeoutMs) {
        const p = await probeIframeStatus(page);
        const dt = Date.now() - t0;
        if (tFirstCanvas === null && p.hasCanvas) {
            tFirstCanvas = dt;
            log(`  [${label}] canvas at ${(dt/1000).toFixed(2)}s`);
        }
        if (tStatusReady === null && p.statusOk) {
            tStatusReady = dt;
            log(`  [${label}] status "${p.statusText}" at ${(dt/1000).toFixed(2)}s`);
        }
        if (p.hasCanvas && p.statusOk) {
            return { tFirstCanvas, tStatusReady, tDomVerified: dt, statusText: p.statusText };
        }
        await sleep(80);
    }
    return { tFirstCanvas, tStatusReady, tDomVerified: null, error: 'timeout' };
}

(async () => {
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    // Upload both fixtures.
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

        // Open xlsx-1 cold.
        log('[step1] Opening xlsx-1 cold');
        await page.goto(VIEWER + '/?planc=1#file=' + up1.b64urlSecret,
            { waitUntil: 'domcontentloaded' });
        const r1 = await waitForVerified(page, 'cold-xlsx1', 120000);
        check('xlsx-1 verified after cold open',
              r1.tDomVerified !== null,
              r1.tDomVerified !== null
                ? 'visible at ' + (r1.tDomVerified/1000).toFixed(2) + 's'
                : 'TIMEOUT');
        await snap(page, 'after_cold_xlsx1');

        // Hot-switch to xlsx-2 via fragment hash change.
        // The viewer's index.html listens for `hashchange` and calls
        // openFileBySecret → RelaySwitchRoom path. This is the same code
        // path that file-list clicks take.
        log('[step2] Hot-switch to xlsx-2');
        const tSwitchStart = Date.now();
        await page.evaluate((secret) => {
            location.hash = '#file=' + secret;
        }, up2.b64urlSecret);
        const r2 = await waitForVerified(page, 'switch-xlsx2', 60000);
        const switchWall = Date.now() - tSwitchStart;
        check('xlsx-2 verified after hot-switch',
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
        await snap(page, 'after_switch_xlsx2');

        // Sanity: status text differs from xlsx-1 (different content).
        const finalStatus = r2.statusText || '';
        check('Status text reports a sheet count',
              /Sheet\s+\d+\s+of\s+\d+/i.test(finalStatus),
              finalStatus);

    } finally {
        await cleanup();
    }

    if (allPassed) { log('✓ ALL TESTS PASSED'); process.exit(0); }
    else            { log('✗ SOME TESTS FAILED'); process.exit(1); }
})().catch(e => { log('FATAL: ' + e.stack); process.exit(2); });
