const __cl = require('./lib/inject-checklist');
// Regression: cluster C cross-type cold-reload (iter 202).
//
// Three wires must remain in place for cross-type cold-reloads to
// surface the right state to viewers and tests. Lose any one and
// regression-viewer-hot-switch-report / regression-wasm-cache-crosstype
// silently revert to reading the parked previous-doctype iframe and
// flagging a "stuck" load that's actually rendering correctly:
//
//   1. wasm-loader.js docPoll derives expectedDocType from
//      WOPISrc/displayName extension and gates `loaded =` on the
//      matching writerLoaded/calcLoaded/impressLoaded only. Without
//      this, the snapshot's leftover writer status fires
//      WasmPrewarmReady on a calc URL.
//   2. viewer-public/index.html arms a 30s cross-type watchdog when
//      the new iframe is created in the cold-reload path; on expiry
//      it latches __warmRestoreFailedThisSession and recreates with
//      planc=0.
//   3. The watchdog's recovery path must also force planc=0 on
//      subsequent cross-types — once warm-restore has wedged in a
//      session it stays wedged on the same captured snapshot.
//
// Static checks via curl — no browser needed. Fast (<1s).

const env = require('./lib/test-env');
const { fetchUrl } = require('./lib/fetch-url');

const BASE = env.EDITOR_URL;
const VIEWER = env.FILE_STORAGE_URL;

const T0 = Date.now();
function log(m) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); }

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

const httpGet = fetchUrl;

(async () => {
    log('=== Regression: cluster C cross-type cold-reload wires ===');

    // Resolve hashed wasm-loader filename via cool.html __assetMap.
    const cool = await httpGet(`${BASE}/browser/cool.html`);
    check('cool.html reachable', cool.status === 200);
    const m = cool.body.match(/window\.__assetMap\s*=\s*(\{[^}]+\})/);
    const assetMap = m ? JSON.parse(m[1]) : {};
    const loaderName = assetMap['wasm-loader.js'] || 'wasm-loader.js';

    // ── wasm-loader: doctype-strict docPoll ──
    const loader = await httpGet(`${BASE}/browser/${loaderName}`);
    check('wasm-loader.js reachable', loader.status === 200);
    check('wasm-loader has expectedDocType derivation',
          loader.body.includes('expectedDocType') &&
          loader.body.includes("'calc'") &&
          loader.body.includes("'impress'"));
    check('wasm-loader gates loaded= on expectedDocType',
          /if\s*\(\s*expectedDocType\s*===\s*['"]calc['"]\s*\)\s*loaded\s*=\s*calcLoaded/.test(loader.body));
    check('wasm-loader falls back to displayName when WOPISrc lacks ext',
          loader.body.includes('displayName') &&
          loader.body.includes("pollName.includes('.')"));

    // ── viewer: cross-type cold-reload watchdog ──
    const viewer = await httpGet(`${VIEWER}/`);
    check('viewer / reachable', viewer.status === 200);
    check('viewer arms __crossTypeWatchdog',
          viewer.body.includes('__crossTypeWatchdog') &&
          viewer.body.includes('180000'));
    check('viewer latches __warmRestoreFailedThisSession on watchdog fire',
          viewer.body.includes('__warmRestoreFailedThisSession = true'));
    check('viewer applies planc=0 when warm-restore latched',
          /__warmRestoreFailedThisSession\s*&&\s*!__coldPlanC/.test(viewer.body));
    check('viewer tracks __lastPaintedFile from WasmPrewarmReady',
          viewer.body.includes('__lastPaintedFile'));
    check('viewer increments __shieldDropCount in hideShield',
          viewer.body.includes('__shieldDropCount'));

    log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    process.exit(allPassed ? 0 : 1);
})().catch((e) => {
    log('FATAL: ' + (e.stack || e.message));
    process.exit(2);
});
