// Regression: cool.html's window.__assetMap has the expected shape.
//
// Background: the cache-bust step (wasm/tools/cache-bust-build.js)
// renames every long-cacheable asset to <base>.<8hex>.<ext> and
// rewrites cool.html with a window.__assetMap mapping logical name
// → hashed name. The runtime locateFile shim and the SW caching
// layer both depend on this map being well-formed and complete.
//
// What this test asserts:
//   1. __assetMap parses out of cool.html exactly once.
//   2. It has the 10 expected logical-name keys: wasm-loader.js,
//      relay-adapter.js, dict-loader.js, bundle.js, bundle.css,
//      global.js, online.js, online.wasm, soffice.data,
//      soffice.data.js.metadata. No more, no fewer.
//   3. Every value matches <basename-prefix>.<8hex>.<ext-suffix>
//      where basename-prefix and ext-suffix are derived from the
//      logical name. Catches a refactor that changes the hash
//      width, format, or filename layout.
//
// Why a regression test rather than a build-time check: the
// cache-bust step is byte-modifying cool.html, which is exactly the
// kind of post-build patch that's easy to break in subtle ways
// (e.g. a JSON.stringify quote-escape change). The build-92
// incident proved that "shipped but malformed" is a real failure
// mode worth detecting downstream.
//
// Runtime: <500ms, single GET of cool.html.

'use strict';

const env = require('./lib/test-env');
const __cl = require('./lib/inject-checklist');

const EDITOR = env.EDITOR_URL;

// Mirrors wasm/tools/cache-bust-build.js's HASHED list. Every entry
// here MUST appear in cool.html's __assetMap, and every key in the
// __assetMap MUST appear here. Keep this list in sync with the
// HASHED set in cache-bust-build.js.
const EXPECTED_KEYS = [
    'wasm-loader.js',
    'relay-adapter.js',
    'dict-loader.js',
    'bundle.js',
    'bundle.css',
    'global.js',
    'online.js',
    'online.wasm',
    'soffice.data',
    'soffice.data.js.metadata',
];

// Per-key hashed-format regex. Hash is exactly 8 lowercase hex chars
// per cache-bust-build.js's sha256(content).slice(0, 8). The base
// and extension parts are computed from the logical name.
function expectedHashedRe(logical) {
    // soffice.data.js.metadata is special — hash is between
    // "soffice.data.js" and ".metadata", not before the final dot.
    if (logical === 'soffice.data.js.metadata') {
        return /^soffice\.data\.js\.[a-f0-9]{8}\.metadata$/;
    }
    // For everything else: split on FIRST dot. Everything left =
    // base, everything right = ext (may itself contain dots, e.g.
    // "data.js.metadata" though that's the special case above).
    const dot = logical.indexOf('.');
    const base = logical.slice(0, dot);
    const ext = logical.slice(dot + 1);
    // Escape regex metachars in base + ext (just dots, in practice).
    const escape = s => s.replace(/[.]/g, '\\.');
    return new RegExp(`^${escape(base)}\\.[a-f0-9]{8}\\.${escape(ext)}$`);
}

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
    console.log('=== Regression: cool.html __assetMap shape ===');
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

    // Match the assetMap exactly once.
    const matches = html.match(/window\.__assetMap\s*=\s*(\{[^}]+\})/g) || [];
    check('__assetMap appears exactly once', matches.length === 1,
          `found ${matches.length}`);
    if (matches.length !== 1) {
        process.exit(1);
    }

    let assetMap;
    try {
        const m = matches[0].match(/window\.__assetMap\s*=\s*(\{[^}]+\})/);
        assetMap = JSON.parse(m[1]);
    } catch (e) {
        check('__assetMap parses as JSON', false, e.message);
        process.exit(1);
    }
    check('__assetMap parses as JSON', true, `${Object.keys(assetMap).length} entries`);

    // Coverage: every expected key present.
    const got = new Set(Object.keys(assetMap));
    const missing = EXPECTED_KEYS.filter(k => !got.has(k));
    const extra = [...got].filter(k => !EXPECTED_KEYS.includes(k));
    check(`all ${EXPECTED_KEYS.length} expected keys present`,
          missing.length === 0,
          missing.length ? 'missing: ' + missing.join(',') : 'ok');
    check('no unexpected keys',
          extra.length === 0,
          extra.length ? 'extra: ' + extra.join(',') : 'ok');

    // Shape: every value matches the per-key hashed format.
    for (const key of EXPECTED_KEYS) {
        if (!got.has(key)) continue; // already flagged above
        const re = expectedHashedRe(key);
        const value = assetMap[key];
        check(`${key} → ${value} matches ${re}`,
              re.test(value),
              re.test(value) ? 'ok' : 'mismatch');
    }

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e);
    process.exit(2);
});
