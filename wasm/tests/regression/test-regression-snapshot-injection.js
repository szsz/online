const __cl = require('./lib/inject-checklist');
// Regression: the deployed online.js must contain deploy.sh's HEAPU8-
// restore injection. If it's missing, "warm" visits run FULL_INIT
// (Desktop::Main + module preload) again and save the snapshot a
// SECOND time — every visit pays the cost, visit 2 is slower than
// visit 1, and the 142MB Cache API entry is useless dead weight.
//
// The failure mode is invisible to every other test because each
// test run uses a fresh browser profile (no pre-existing snapshot to
// restore). So this probe is a one-line fetch that asserts the two
// marker strings deploy.sh writes into online.js.
//
// Scope: the probe is intentionally a no-browser HTTP check — it runs
// in < 500ms and is meant to be the FIRST thing the suite does, so a
// broken deploy fails the suite immediately instead of 40 minutes in.

'use strict';

const env = require('./lib/test-env');
const EDITOR = env.EDITOR_URL;

const REQUIRED = [
    // deploy.sh Injection 1: restore HEAPU8 before callMain().
    '__wasmSnapshotData',
    '__snapRestoredBeforeMain',
    // deploy.sh Injection 2: bypass checkStackCookie after restore.
    // Block-comment form so a minifier flattening online.js to a
    // single line doesn't kill the rest of the line (matches the
    // finalize-build.sh splice).
    '/* skip after snapshot */',
];

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
    console.log('=== Regression: snapshot-restore injection present in online.js ===');
    const t0 = Date.now();
    // Iter 207: cache-bust ships online.js as online.<hash>.js. Resolve
    // the hashed name via cool.html's __assetMap; fall back to the
    // un-hashed path for dev trees without a cache-bust step.
    let url;
    try {
        const cool = await fetch(EDITOR + '/browser/cool.html');
        const html = await cool.text();
        const m = html.match(/window\.__assetMap\s*=\s*(\{[^}]+\})/);
        const assetMap = m ? JSON.parse(m[1]) : {};
        const onlineJs = assetMap['online.js'] || 'online.js';
        url = EDITOR + '/browser/' + onlineJs;
    } catch (e) {
        url = EDITOR + '/browser/online.js';
    }
    let body;
    try {
        const resp = await fetch(url);
        if (!resp.ok) {
            console.log('Fetch failed: ' + resp.status + ' (url=' + url + ')');
            process.exit(1);
        }
        body = await resp.text();
    } catch(e) {
        console.log('Fetch error: ' + e.message);
        process.exit(1);
    }
    console.log('Fetched ' + url + ' (' + body.length + ' bytes) in ' +
        (Date.now() - t0) + 'ms');

    for (const marker of REQUIRED) {
        const hits = (body.match(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
        check(
            'online.js contains `' + marker + '` (deploy.sh injection)',
            hits >= 1,
            'hits=' + hits
        );
    }

    if (!allPassed) {
        console.log('');
        console.log('Fix: re-run `sudo bash wasm/deploy.sh` to re-apply the');
        console.log('     snapshot restore injection to online.js.');
        console.log('');
        console.log('Consequence of leaving this unfixed: every browser visit');
        console.log('re-runs the 15-20s Desktop::Main init AND resaves the 142MB');
        console.log('snapshot, even though the snapshot is already in Cache API.');
    }

    console.log(allPassed ? '✓ ALL PASSED' : '✗ FAILED');
    process.exit(allPassed ? 0 : 1);
})();
