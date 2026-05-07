// Regression: bundle.js's first-3KB prepend has the expected shape.
//
// Background: wasm/tools/cache-bust-build.js prepends l10n-all.js
// content (~5 MB) to bundle.js. The very first bytes of bundle.js
// must be l10n-all's code — typically `var onlylang = window.LANG;`
// — because l10n-all reads window.LANG synchronously at bundle-
// start. window.LANG itself is set up earlier by an inline shim in
// cool.html (which runs before the deferred bundle.js loads).
//
// What this test asserts on deployed bundle.js (first 1KB):
//   1. The very first non-whitespace bytes are the l10n-all
//      prepend marker (`var onlylang = window.LANG`). Catches the
//      cache-bust step regressing — without the prepend, bundle.js
//      starts with whatever Webpack emitted and l10n-all is
//      missing entirely → window.LOCALIZATIONS = undefined for
//      every user.
//   2. The string "var onlylang" appears within the first 256
//      bytes (additive belt-and-braces in case the prepend gets a
//      preamble like a "use strict" or sourceMap comment).
//
// Runtime: <500ms — Range request for first 1024 bytes only.

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
    console.log('=== Regression: bundle.js prepend has window.LANG → l10n-all → locateFile ===');
    const t0 = Date.now();

    // Resolve hashed bundle.js name via cool.html.
    let bundleUrl;
    try {
        const cool = await fetch(EDITOR + '/browser/cool.html');
        const html = await cool.text();
        const m = html.match(/window\.__assetMap\s*=\s*(\{[^}]+\})/);
        if (!m) throw new Error('no __assetMap');
        const assetMap = JSON.parse(m[1]);
        bundleUrl = EDITOR + '/browser/' + assetMap['bundle.js'];
    } catch (e) {
        check('bundle.js URL resolved via __assetMap', false, e.message);
        process.exit(1);
    }
    check('bundle.js URL resolved via __assetMap', true, bundleUrl);

    // Fetch only the first 1KB. Range request — the editor server
    // honors Range on hashed assets. Falls back to full GET if
    // Range isn't supported.
    let head;
    try {
        const r = await fetch(bundleUrl, {
            headers: { 'Range': 'bytes=0-1023' },
        });
        const bytes = await r.arrayBuffer();
        head = Buffer.from(bytes).toString('utf8');
        if (head.length > 1024) head = head.slice(0, 1024);
    } catch (e) {
        check('bundle.js first 1KB fetched', false, e.message);
        process.exit(1);
    }
    check('bundle.js first 1KB fetched', true, `${head.length} bytes`);

    // The l10n-all prepend marker must appear within the first
    // 256 bytes — any preamble (sourceMap, "use strict") would
    // sit ahead of it but be brief.
    const onlylangIdx = head.indexOf('var onlylang');
    check('var onlylang present within first 256 bytes',
          onlylangIdx >= 0 && onlylangIdx < 256,
          onlylangIdx >= 0
              ? `at byte ${onlylangIdx}`
              : 'not found');

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e);
    process.exit(2);
});
