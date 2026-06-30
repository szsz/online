// Regression: viewer's cross-type canvas-paint watchdog scales with
// JOBS_SCALE.
//
// Background: viewer-public/index.html has a 180s watchdog (line
// ~1394) that recreates the iframe with ?planc=0 if the kit hasn't
// fired WasmPrewarmReady. Under parallel test runners (JOBS=2+) on
// the self-hosted runner, CPU contention slows kit paint past 180s
// on heavy docs (50-slide pptx) — the watchdog fires, iframe gets
// torn down, puppeteer Frame goes "detached", the test fails. The
// fix is to multiply the watchdog by JOBS_SCALE so on JOBS=2 we get
// 360s headroom.
//
// What this test asserts (source-shape only — the runtime behaviour
// is exercised by every other test that opens through lib/
// open-via-viewer.js):
//   1. wasm/viewer-public/index.html defines window.__JOBS_SCALE
//      from the ?ws= URL param, clamped to [1, 8].
//   2. The cross-type canvas-paint watchdog uses window.__JOBS_SCALE
//      as a multiplier (the 180000 ms timeout is no longer a literal).
//   3. wasm/lib/open-via-viewer.js injects ?ws=$JOBS_SCALE into the
//      viewer URL when process.env.JOBS_SCALE > 1, before the hash.
//
// Pure source-shape — no browser, <50ms.

'use strict';

const fs = require('fs');
const path = require('path');
const __cl = require('../../lib/inject-checklist');

const REPO_WASM_DIR = path.resolve(__dirname, '..', '..');

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) console.log('  ✓ ' + label);
    else {
        console.log('  ✗ FAIL: ' + label + (ev ? ' [' + ev + ']' : ''));
        allPassed = false;
    }
}

(async () => {
    console.log('=== Regression: JOBS_SCALE watchdog wiring ===');
    const t0 = Date.now();

    const viewer = fs.readFileSync(
        path.join(REPO_WASM_DIR, 'viewer-public/index.html'), 'utf8');
    const helper = fs.readFileSync(
        path.join(REPO_WASM_DIR, 'lib/open-via-viewer.js'), 'utf8');

    // 1. Viewer reads ?ws= URL param into window.__JOBS_SCALE.
    check('viewer: window.__JOBS_SCALE defined',
        /window\.__JOBS_SCALE\s*=/.test(viewer));
    check('viewer: __JOBS_SCALE reads ?ws= URL param',
        /URLSearchParams[\s\S]{0,200}?\.get\(['"]ws['"]\)/.test(viewer));
    check('viewer: __JOBS_SCALE clamps to [1, 8]',
        /__JOBS_SCALE[\s\S]{0,400}?(n\s*>\s*8|<\s*1)/.test(viewer));

    // 2. Cross-type watchdog uses __JOBS_SCALE as multiplier.
    check('viewer: cross-type watchdog multiplies by __JOBS_SCALE',
        /180000\s*\*\s*\(?window\.__JOBS_SCALE/.test(viewer));

    // 3. open-via-viewer.js appends ?ws= when JOBS_SCALE > 1.
    check('lib/open-via-viewer.js: reads process.env.JOBS_SCALE',
        /process\.env\.JOBS_SCALE/.test(helper));
    check('lib/open-via-viewer.js: appends ws= URL param',
        /['"]ws=['"]/.test(helper));
    check('lib/open-via-viewer.js: gates on JOBS_SCALE > 1',
        /_jobsScale\s*>\s*1/.test(helper));

    console.log('\nDuration: ' + (Date.now() - t0) + ' ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e);
    process.exit(2);
});
