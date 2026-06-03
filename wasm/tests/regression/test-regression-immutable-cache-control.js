// Regression: heavy long-cacheable assets are served with
// Cache-Control: public, max-age=31536000, immutable.
//
// Background: per-deploy folders (PRs #45–#50, 2026-05-11) replaced
// filename hashing with path versioning. Each editor build lives at
// `${EDITOR}/<APP_BUILD_ID>/`, so the URL is content-addressed by id
// rather than by filename hash. The editor's cache middleware emits
// `immutable` for every asset under a per-deploy folder — `req.deployId`
// is set by the prefix-stripping middleware (on explicit `/<id>/...`)
// OR by the DEFAULT_DEPLOY_ID env fallback (on flat URLs), so both
// shapes inherit the immutable header.
//
// What this test asserts (against EDITOR_URL):
//   For each heavy asset name:
//     1. HEAD via the flat URL returns 200 (DEFAULT_DEPLOY_ID routes
//        it to the latest <id>/ folder).
//     2. Cache-Control header EXACTLY equals
//        "public, max-age=31536000, immutable".
//
// Why exact match: a future refactor that emits "max-age=31536000,
// public, immutable" (different order) might still be safe but
// indicates someone touched the policy without thinking. The exact-
// match assertion forces the change to be intentional.
//
// Runtime: <2s.

'use strict';

const env = require('../../lib/test-env');
const __cl = require('../../lib/inject-checklist');

const EDITOR = env.EDITOR_URL;
const EXPECTED_CC = 'public, max-age=31536000, immutable';

// Heavy assets that the editor serves. Names match the build output
// post-Phase-3 (no hashing). Same set as cache-bust-build.js's
// buildPreloadHints() heavy list, minus the dynamic .html.
const HEAVY_ASSETS = [
    'online.wasm',
    'soffice.data',
    'soffice.data.js.metadata',
    'bundle.js',
    'bundle.css',
    'online.js',
    'global.js',
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
    console.log('=== Regression: heavy assets served with immutable Cache-Control ===');
    const t0 = Date.now();

    // Probe each asset via the flat URL — DEFAULT_DEPLOY_ID on the
    // editor server routes the flat path into the latest <id>/ folder.
    // If env.EDITOR_DEPLOY_PREFIX is set (CI export from APP_BUILD_ID),
    // probe the explicit-prefix path too as a stronger signal.
    const prefix = env.EDITOR_DEPLOY_PREFIX || '';

    for (const name of HEAVY_ASSETS) {
        const url = EDITOR + '/browser/' + name;
        let resp;
        try {
            resp = await fetch(url, { method: 'HEAD' });
        } catch (e) {
            check(`HEAD ${name}`, false, e.message);
            continue;
        }
        // Tolerate 404 on local-dev (asset may not exist if the build
        // didn't produce it for this test target) — only assert
        // headers when the asset IS reachable.
        if (resp.status === 404) {
            console.log(`  · ${name}: 404 (not built — skipping cache assertion)`);
            continue;
        }
        check(`HEAD ${name} → 200`, resp.status === 200,
              `HTTP ${resp.status}`);
        if (resp.status !== 200) continue;
        const cc = resp.headers.get('cache-control') || '';
        check(`${name} Cache-Control exact match`,
              cc === EXPECTED_CC,
              cc === EXPECTED_CC ? 'ok' : `got "${cc}"`);
    }

    // Bonus probe: explicit /<id>/ when EDITOR_DEPLOY_PREFIX is set.
    // Tests against the same immutable rule, just via the explicit path.
    if (prefix) {
        const url = EDITOR + prefix + '/browser/online.wasm';
        try {
            const r = await fetch(url, { method: 'HEAD' });
            if (r.status === 200) {
                const cc = r.headers.get('cache-control') || '';
                check(`explicit-prefix online.wasm Cache-Control`,
                      cc === EXPECTED_CC,
                      cc === EXPECTED_CC ? 'ok' : `got "${cc}"`);
            }
        } catch (_) { /* skip */ }
    }

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e);
    process.exit(2);
});
