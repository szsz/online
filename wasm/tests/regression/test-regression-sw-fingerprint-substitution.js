// Regression: deployed sw.js has a real fingerprint substituted in,
// not the literal __WASM_BUILD_FINGERPRINT__ placeholder.
//
// Background: each deploy patches the SW source so its CACHE_NAME
// embeds an md5 of online.wasm — this is what causes the SW
// activate handler to evict caches from previous builds. The
// substitution is done by deploy-azure.sh / deploy-local.sh via
// `sed -i "s|__WASM_BUILD_FINGERPRINT__|$FINGERPRINT|g"`. If that
// step is dropped or the placeholder is renamed, the deployed sw.js
// keeps the literal placeholder. CACHE_NAME falls back to
// 'cool-editor-dev' (per the literal-detection branch in sw.js
// line 36-38), so every deploy reuses the same cache namespace and
// stale assets never get evicted.
//
// What the test asserts on the deployed /browser/sw.js:
//   1. The literal "__WASM_BUILD_FINGERPRINT__" string does NOT
//      appear in the source. (Comments referencing the placeholder
//      verbatim would be flagged — but this is acceptable because
//      sw.js only mentions it in comments using "__WASM_BUILD" +
//      "_FINGERPRINT__" string concat to dodge exactly this check.
//      We check for the un-concatenated form.)
//   2. CACHE_NAME = 'cool-editor-' + 16-hex string. The substitution
//      yields a fresh md5 hash, so the cache namespace is unique to
//      this build.
//
// Runtime: <500ms, single GET.

'use strict';

const env = require('../../lib/test-env');
const __cl = require('../../lib/inject-checklist');

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
    console.log('=== Regression: deployed sw.js has fingerprint substituted ===');
    const t0 = Date.now();

    let src;
    try {
        const resp = await fetch(EDITOR + '/browser/sw.js');
        check('sw.js fetched', resp.ok, `HTTP ${resp.status}`);
        if (!resp.ok) process.exit(1);
        src = await resp.text();
    } catch (e) {
        check('sw.js fetched', false, e.message);
        process.exit(1);
    }

    // The literal placeholder must not appear in the deployed source
    // EXCEPT inside the string-concat dodge that sw.js uses to test
    // for itself. Strip the concat form before checking.
    const stripped = src.replace(/__WASM_BUILD'\s*\+\s*'_FINGERPRINT__/g, '<<dodge>>');
    const literalCount = (stripped.match(/__WASM_BUILD_FINGERPRINT__/g) || []).length;
    check('no un-substituted __WASM_BUILD_FINGERPRINT__ placeholders',
          literalCount === 0,
          literalCount === 0 ? 'ok' : `${literalCount} found`);

    // CACHE_NAME assignment — must look like 'cool-editor-' + 16-hex.
    // sw.js writes:
    //   const BUILD_FINGERPRINT = '<16hex>';
    //   const CACHE_NAME = ... ? 'cool-editor-dev' : 'cool-editor-' + BUILD_FINGERPRINT;
    const m = src.match(/const\s+BUILD_FINGERPRINT\s*=\s*'([^']+)'/);
    check('BUILD_FINGERPRINT assignment present', !!m,
          m ? `'${m[1]}'` : '(missing)');
    if (m) {
        const fp = m[1];
        check('BUILD_FINGERPRINT is 16 lowercase hex chars',
              /^[a-f0-9]{16}$/.test(fp),
              `got '${fp}' (length ${fp.length})`);
    }

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e);
    process.exit(2);
});
