const __cl = require('./lib/inject-checklist');
// Regression: hot-switch watchdog (iter 195).
//
// After 3+ consecutive in-iframe `#switchdoc` operations the kit can wedge:
// the switchdocument cmd lands but the new doc never repaints. Without a
// watchdog the visiblePollInterval polls forever and the viewer's shield
// floor finally drops at 90 s, leaving the user staring at a stuck spinner.
//
// wasm-loader.js installs a 25 s setTimeout after each switchdoc that
// posts `HotSwitchFailed` to the parent + clears the visible poll. The
// viewer drops cached state and re-opens the file via the cross-type
// cold-reload path so the user actually sees their doc.
//
// This test asserts:
//   1. The literal mark name `bridge:hot_switch_watchdog` is present in
//      the deployed wasm-loader.js (would catch a refactor that drops it).
//   2. The HotSwitchFailed handler exists in the deployed viewer
//      index.html (without it the watchdog firing is a no-op).
//
// Static-only — no browser launch needed. Fast (<1 s).

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
    log('=== Regression: hot-switch watchdog wired end-to-end ===');

    // Discover the hashed wasm-loader filename via cool.html's __assetMap.
    const cool = await httpGet(`${BASE}/browser/cool.html`);
    check('cool.html reachable', cool.status === 200, 'status=' + cool.status);
    const m = cool.body.match(/window\.__assetMap\s*=\s*(\{[^}]+\})/);
    check('__assetMap present in cool.html', !!m);
    const assetMap = m ? JSON.parse(m[1]) : {};
    const loaderName = assetMap['wasm-loader.js'] || 'wasm-loader.js';
    log(`  wasm-loader resolves to ${loaderName}`);

    // Pull deployed wasm-loader.js and look for the watchdog wiring.
    const loader = await httpGet(`${BASE}/browser/${loaderName}`);
    check('wasm-loader.js reachable', loader.status === 200,
          'status=' + loader.status);
    check('wasm-loader.js emits bridge:hot_switch_watchdog mark',
          loader.body.includes('bridge:hot_switch_watchdog'));
    check('wasm-loader.js posts HotSwitchFailed to parent',
          /MessageId\s*:\s*['"]HotSwitchFailed['"]/.test(loader.body));

    // Pull viewer index.html and confirm the receiver is wired.
    const viewerHtml = await httpGet(`${VIEWER}/`);
    check('viewer / reachable', viewerHtml.status === 200,
          'status=' + viewerHtml.status);
    check('viewer handles HotSwitchFailed',
          /MessageId\s*===\s*['"]HotSwitchFailed['"]/.test(viewerHtml.body));

    log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    process.exit(allPassed ? 0 : 1);
})().catch((e) => {
    log('FATAL: ' + (e.stack || e.message));
    process.exit(2);
});
