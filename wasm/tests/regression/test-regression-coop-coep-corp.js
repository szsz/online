// Regression: editor-static serves the COOP/COEP/CORP triple
// required for SharedArrayBuffer cross-origin isolation.
//
// Background: SharedArrayBuffer (which the COOL editor uses
// extensively for inter-thread communication) is gated behind a
// "cross-origin isolated" context. The browser only grants that
// context when ALL THREE headers are present:
//
//   Cross-Origin-Opener-Policy:   same-origin
//   Cross-Origin-Embedder-Policy: require-corp
//   Cross-Origin-Resource-Policy: cross-origin
//
// If any one is missing, SAB is undefined in the iframe and the
// editor fails to instantiate. Tests notice this only by full
// editor-load failure; this targeted check catches a silent header
// regression at the HEAD-request level.
//
// What the test asserts (against EDITOR_URL/browser/cool.html):
//   1. Each of the three headers is present.
//   2. Each has the exact expected value (no looser variants —
//      same-origin-allow-popups would re-isolate but break our
//      embed flow with viewer.atgpartners.info).
//
// Runtime: <300ms, single HEAD request.

'use strict';

const env = require('../../lib/test-env');
const __cl = require('../../lib/inject-checklist');

const EDITOR = env.EDITOR_URL;

const REQUIRED_HEADERS = {
    'cross-origin-opener-policy':   'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-resource-policy': 'cross-origin',
};

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
    console.log('=== Regression: editor-static COOP/COEP/CORP cross-origin-isolation triple ===');
    const t0 = Date.now();

    let resp;
    try {
        resp = await fetch(EDITOR + '/browser/cool.html', { method: 'HEAD' });
    } catch (e) {
        check('cool.html HEAD reachable', false, e.message);
        process.exit(1);
    }
    check('cool.html HEAD reachable', resp.ok, `HTTP ${resp.status}`);

    for (const [name, expected] of Object.entries(REQUIRED_HEADERS)) {
        const got = resp.headers.get(name);
        check(`${name}: ${expected}`,
              got === expected,
              got === expected ? 'ok' : `got=${got || '(missing)'}`);
    }

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e);
    process.exit(2);
});
