// Regression: cool.html contains the mandatory script tags for
// global.js, templates/templates.js, and bundle.js (or the hashed
// equivalents).
//
// Background: cool.html is generated from browser/html/cool.html.m4
// by m4 macro expansion. The m4 file's logic for inserting script
// tags has multiple branches (MOBILEAPP vs not, BUNDLE vs not,
// EMSCRIPTENAPP vs not). Manual edits to cool.html.m4 — the kind
// that happen during a feature add — are easy to break in subtle
// ways: a missing close-tag, a misplaced m4_ifelse, an accidental
// m4_dnl that swallows a script line. The result is silent: the
// editor loads, but global.js or templates.js never executes, so
// `window.app.host` or template-instantiation calls return
// undefined and the editor 500s on the first interactive action.
//
// What this test asserts on deployed cool.html:
//   1. <script ... src="..."> for global.js (or global.<hash>.js)
//   2. <script ... src="..."> for templates/templates.js
//   3. <script ... src="..."> for bundle.js (or bundle.<hash>.js)
//
// Doesn't enforce attribute order or quoting style — just that the
// hash-aware src is present in some <script> tag.
//
// Runtime: <300ms, single GET.

'use strict';

const env = require('./lib/test-env');
const __cl = require('./lib/inject-checklist');

const EDITOR = env.EDITOR_URL;

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
    console.log('=== Regression: cool.html mandatory script tags ===');
    const t0 = Date.now();

    let html;
    try {
        const resp = await fetch(EDITOR + '/browser/cool.html');
        check('cool.html fetched', resp.ok, `HTTP ${resp.status}`);
        if (!resp.ok) process.exit(1);
        html = await resp.text();
    } catch (e) {
        check('cool.html fetched', false, e.message);
        process.exit(1);
    }

    // Each entry: human label + regex matching the script-tag form.
    // The `(\.[a-f0-9]{8})?` slot makes the test work both for
    // hashed (cache-bust) and un-hashed (dev-tree) deployments.
    const REQUIRED = [
        ['global.js script tag',
         /<script[^>]*\bsrc=["'][^"']*\bglobal(\.[a-f0-9]{8})?\.js[^"']*["'][^>]*>/i],
        ['templates/templates.js script tag',
         /<script[^>]*\bsrc=["'][^"']*\btemplates\/templates\.js[^"']*["'][^>]*>/i],
        ['bundle.js script tag',
         /<script[^>]*\bsrc=["'][^"']*\bbundle(\.[a-f0-9]{8})?\.js[^"']*["'][^>]*>/i],
    ];

    for (const [label, re] of REQUIRED) {
        const m = html.match(re);
        check(label, !!m, m ? m[0].slice(0, 100) : '(missing)');
    }

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e);
    process.exit(2);
});
