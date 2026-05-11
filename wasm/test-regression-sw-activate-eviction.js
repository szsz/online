// Regression: deployed sw.js's activate handler still has the
// cache-eviction loop that drops every cache whose name isn't the
// current build's CACHE_NAME.
//
// Background: every deploy substitutes a fresh BUILD_FINGERPRINT
// (md5 of online.wasm) into sw.js. CACHE_NAME = 'cool-editor-' +
// fingerprint. The activate handler in sw.js:92 evicts caches whose
// names don't match the new CACHE_NAME — that's how an old build's
// 142MB Cache Storage entries (online.wasm of the previous build,
// soffice.data, etc.) get GC'd when a user reloads the editor.
//
// If the activate handler is dropped — e.g. someone refactors sw.js
// and accidentally removes the keys/filter/delete chain — old build
// caches accumulate forever, eventually exhausting the browser's
// quota (per-origin ~1GB-2GB on Chrome). The user-visible failure
// is "WriteFailed" / quota-exceeded errors only after several
// deploys, with no clear cause to map back to.
//
// What this test asserts on deployed sw.js:
//   1. self.addEventListener('activate', ...) handler is present.
//   2. caches.keys() is invoked inside the activate handler.
//   3. The filter pattern `names.filter(n => n !== CACHE_NAME)` (or
//      equivalent) is present — locked to "filter on inequality
//      with CACHE_NAME"; rephrasing to a different filter is a
//      regression.
//   4. caches.delete(...) is invoked inside the activate handler.
//
// This is a static check on the deployed sw.js source — runs in
// <500ms with one GET.

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
    console.log('=== Regression: deployed sw.js has activate-handler eviction ===');
    const t0 = Date.now();

    let src;
    try {
        const r = await fetch(EDITOR + '/browser/sw.js');
        check('sw.js fetched', r.ok, `HTTP ${r.status}`);
        if (!r.ok) process.exit(1);
        src = await r.text();
    } catch (e) {
        check('sw.js fetched', false, e.message);
        process.exit(1);
    }

    // Locate the activate handler block.
    const activateMatch = src.match(
        /addEventListener\s*\(\s*['"]activate['"]\s*,\s*[\s\S]+?\}\s*\)\s*;/);
    check("activate listener present (addEventListener('activate', ...))",
          !!activateMatch, activateMatch ? `${activateMatch[0].length} bytes` : '(none)');
    if (!activateMatch) process.exit(1);
    const block = activateMatch[0];

    // Subchecks INSIDE the activate handler block.
    check('caches.keys() called in activate handler',
          /caches\.keys\s*\(\s*\)/.test(block),
          /caches\.keys/.test(block) ? 'ok' : 'missing');
    check('filter on CACHE_NAME inequality present',
          /\.filter\s*\(\s*[^)]*?!==?\s*CACHE_NAME[^)]*\)/.test(block),
          'filter(n => n !== CACHE_NAME) shape');
    check('caches.delete(...) called in activate handler',
          /caches\.delete\s*\(/.test(block),
          /caches\.delete/.test(block) ? 'ok' : 'missing');

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
