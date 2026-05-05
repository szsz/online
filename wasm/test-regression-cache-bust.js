const __cl = require('./lib/inject-checklist');
// Regression: build-time cache-busting pipeline (iter 27/28).
//
// What we ship:
//   - cache-bust-build.js renames each long-cacheable asset to
//     <base>.<hash>.<ext> and rewrites cool.html refs + injects a
//     Module.locateFile shim with window.__assetMap.
//   - The webserver serves hashed names with Cache-Control: immutable.
//   - cool.html and sw.js are no-cache.
//   - wasm-loader.js's document.write of online.js + emscripten-module.js's
//     locateFile (post-build patched in deploy.sh) both honour __assetMap.
//
// This test asserts the live editor's cool.html is well-formed:
//   1. Valid HTML (200 OK, no-cache).
//   2. Contains the locateFile shim with a non-empty __assetMap.
//   3. Every <script src> / <link href> for a known asset is hashed.
//   4. Each hashed URL is reachable AND served immutable.
//   5. The locateFile shim runs ONCE (not duplicated by a stale runtime
//      injection path).
//
// Doesn't open a browser — just curl. Fast and catches deploy regressions
// before any heavyweight test does.

const env = require('./lib/test-env');
const { fetchUrl, headUrl } = require('./lib/fetch-url');

const BASE = env.EDITOR_URL;
const HASHED_RE = /\.[0-9a-f]{8}\.(?:js|css|wasm|data|metadata)$/;

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  PASS: ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

(async () => {
    log('=== Regression: build-time cache-bust pipeline ===');

    // 1. cool.html serves no-cache + 200
    const coolUrl = `${BASE}/browser/cool.html`;
    const cool = await fetchUrl(coolUrl);
    check('cool.html returns 200', cool.status === 200, 'status=' + cool.status);
    check('cool.html is no-cache',
          /no-cache/.test(cool.headers['cache-control'] || ''),
          'Cache-Control=' + cool.headers['cache-control']);

    // 2. locateFile shim present + __assetMap populated
    const assetMapMatch = cool.body.match(/window\.__assetMap\s*=\s*(\{[^}]+\})/);
    check('cool.html contains __assetMap definition', !!assetMapMatch);
    let assetMap = {};
    if (assetMapMatch) {
        try { assetMap = JSON.parse(assetMapMatch[1]); }
        catch (e) { log('  WARN: __assetMap parse: ' + e.message); }
    }
    const mapKeys = Object.keys(assetMap);
    check('__assetMap covers expected core assets',
          ['online.wasm', 'soffice.data', 'soffice.data.js.metadata',
           'bundle.js', 'online.js', 'wasm-loader.js']
           .every(k => k in assetMap),
          'keys=' + mapKeys.join(','));

    // 3. Single shim — no duplicate runtime injection
    const shimCount = (cool.body.match(/window\.__assetMap\s*=/g) || []).length;
    check('locateFile shim is single (no duplicate injection)',
          shimCount === 1, 'count=' + shimCount);

    // 4. Every <script src> / <link href> for a known asset is hashed.
    const refs = [...cool.body.matchAll(/(?:src|href)="([^"]+\.(?:js|css|wasm|data|metadata))"/g)]
        .map(m => m[1]).filter(p => !p.startsWith('http'));  // ignore CDN
    log(`Found ${refs.length} asset refs in cool.html`);
    const cacheBustable = ['bundle.js', 'bundle.css', 'online.js', 'global.js',
        'wasm-loader.js', 'relay-adapter.js', 'dict-loader.js'];
    for (const ref of refs) {
        const base = ref.split('/').pop();
        const baseStripped = base.replace(/\.[0-9a-f]{8}\./, '.');
        if (cacheBustable.includes(baseStripped)) {
            check(`${baseStripped} ref is hashed`, HASHED_RE.test(base), 'ref=' + base);
        }
    }

    // 5. Each hashed URL serves immutable.
    const hashedRefs = refs.filter(r => HASHED_RE.test(r));
    log(`Sampling cache headers on ${hashedRefs.length} hashed refs`);
    for (const ref of hashedRefs.slice(0, 7)) {  // sample first 7 to keep test fast
        const url = `${BASE}/browser/${ref}`;
        const r = await headUrl(url).catch(e => ({ error: e.message }));
        if (r.error) {
            check(`${ref} reachable`, false, r.error);
            continue;
        }
        check(`${ref} returns 200`, r.status === 200, 'status=' + r.status);
        check(`${ref} is immutable`,
              /immutable/.test(r.headers['cache-control'] || ''),
              'Cache-Control=' + r.headers['cache-control']);
    }

    // 6. __assetMap entries reachable (locateFile-resolved paths)
    for (const key of ['online.wasm', 'soffice.data', 'soffice.data.js.metadata']) {
        const hashed = assetMap[key];
        if (!hashed) {
            check(`__assetMap['${key}'] reachable`, false, 'no map entry');
            continue;
        }
        const r = await headUrl(`${BASE}/browser/${hashed}`).catch(e => ({ error: e.message }));
        check(`__assetMap['${key}'] = ${hashed} reachable`,
              !r.error && r.status === 200,
              r.error || 'status=' + r.status);
    }

    log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e.stack || e.message);
    process.exit(2);
});
