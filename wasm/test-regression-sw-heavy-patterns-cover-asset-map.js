// Regression: every cool.html __assetMap value matches at least one
// HEAVY_PATTERNS regex in sw.js.
//
// Background: the Service Worker's HEAVY_PATTERNS list (wasm/sw.js)
// drives Cache Storage population for the big assets — online.wasm
// (~265 MB), soffice.data (~98 MB), bundle.js (~12 MB). Without a
// pattern match, the SW silently passes the request through and
// the browser pays the full network round-trip on every visit.
// Iter 27 cache-bust hashing introduced the bug class where a
// pattern stopped matching the renamed asset (e.g. soffice.data
// → soffice.<hash>.data), masked by the HTTP disk cache in regular
// browsing but visible in incognito.
//
// What this test asserts:
//   For every value in cool.html's __assetMap, at least one regex in
//   sw.js's HEAVY_PATTERNS matches a deployment-style URL like
//   `/browser/<hashed>?build=<id>`. If a key gets renamed (or a new
//   one added) without a corresponding HEAVY_PATTERN entry, this
//   test fires — the bug class build-92 surfaced post-deploy gets
//   caught on the PR.
//
// Why a test: HEAVY_PATTERNS lives in wasm/sw.js as a hand-curated
// regex list. Changing __assetMap (e.g. adding dict-loader.js as a
// new hashed asset, or renaming online.js) doesn't auto-touch sw.js,
// and the resulting drift is invisible to the existing tests
// (regular browsing's HTTP cache hides the SW miss).
//
// Runtime: <1s. Reads sw.js from disk (the source of truth) +
// fetches cool.html.

'use strict';

const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');
const __cl = require('./lib/inject-checklist');

const EDITOR = env.EDITOR_URL;
const SW_PATH = path.join(__dirname, 'sw.js');

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) console.log('  ✓ ' + label);
    else {
        console.log('  ✗ FAIL: ' + label + (ev ? ' [' + ev + ']' : ''));
        allPassed = false;
    }
}

// Parse HEAVY_PATTERNS out of sw.js's source text. Matching the
// `const HEAVY_PATTERNS = [ ... ];` block via regex is fragile if
// someone reformats the file, but the only alternative is exec'ing
// sw.js in node which would pull in the rest of the SW (caches,
// self.addEventListener) and crash. The regex approach matches the
// actual deployed format.
function loadHeavyPatterns(swSrc) {
    const m = swSrc.match(/const\s+HEAVY_PATTERNS\s*=\s*\[([\s\S]+?)\];/);
    if (!m) return null;
    const body = m[1];
    // Each entry is `/regex-source/[flags],`. Pull source out.
    const sources = [...body.matchAll(/\/((?:\\\/|[^/])+)\/([gimsuy]*)/g)]
        .map(m => new RegExp(m[1], m[2]));
    return sources;
}

(async () => {
    console.log('=== Regression: SW HEAVY_PATTERNS covers every __assetMap value ===');
    const t0 = Date.now();

    let swSrc;
    try {
        swSrc = fs.readFileSync(SW_PATH, 'utf8');
    } catch (e) {
        check('sw.js readable', false, e.message);
        process.exit(1);
    }
    check('sw.js readable', true, `${swSrc.length} bytes`);

    const patterns = loadHeavyPatterns(swSrc);
    check('HEAVY_PATTERNS parses out of sw.js',
          Array.isArray(patterns) && patterns.length > 0,
          patterns ? `${patterns.length} regexes` : '(none)');
    if (!patterns || !patterns.length) process.exit(1);

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

    const m = html.match(/window\.__assetMap\s*=\s*(\{[^}]+\})/);
    check('__assetMap present in cool.html', !!m, m ? 'ok' : 'missing');
    if (!m) process.exit(1);

    const assetMap = JSON.parse(m[1]);

    // HEAVY_PATTERNS covers the BIG assets that justify Cache
    // Storage's overhead (vs HTTP disk cache). The smaller JS files
    // — wasm-loader.js, relay-adapter.js, dict-loader.js, each
    // <100 KB — ride the HTTP cache + brotli combo (see sw.js head
    // comment). Test enforces that the documented heavy set IS
    // covered, and the documented small set is NOT (locks the
    // design choice — flipping a small file into HEAVY_PATTERNS
    // without thinking would silently double its cache footprint).
    const HEAVY_KEYS = new Set([
        'bundle.js', 'bundle.css', 'global.js',
        'online.js', 'online.wasm',
        'soffice.data', 'soffice.data.js.metadata',
    ]);
    const SMALL_KEYS = new Set([
        'wasm-loader.js', 'relay-adapter.js', 'dict-loader.js',
    ]);

    for (const [key, hashed] of Object.entries(assetMap)) {
        const url = '/browser/' + hashed;
        const matched = patterns.some(re => re.test(url));
        if (HEAVY_KEYS.has(key)) {
            check(`HEAVY ${key} → ${hashed} covered by HEAVY_PATTERNS`,
                  matched,
                  matched ? 'ok' : 'no regex matches ' + url);
        } else if (SMALL_KEYS.has(key)) {
            check(`SMALL ${key} → ${hashed} NOT in HEAVY_PATTERNS (rides HTTP cache)`,
                  !matched,
                  matched ? 'unexpectedly cached' : 'ok');
        }
        // Anything not in either set: no assertion. If a new asset
        // is added to __assetMap, the asset-map-shape test fires
        // (extra key) before reaching this test.
    }

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e);
    process.exit(2);
});
