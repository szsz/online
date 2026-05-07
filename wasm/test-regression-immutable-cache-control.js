// Regression: every cache-bust hashed asset is served with
// Cache-Control: public, max-age=31536000, immutable.
//
// Background: the cache-bust step renames each long-cacheable asset
// to <base>.<8hex>.<ext> precisely so the editor-static server can
// serve them with a 1-year immutable cache directive — the "immutable"
// keyword is what tells modern browsers and CDNs to skip every
// revalidation request, even on user-triggered reloads. Losing it
// (e.g. via a header refactor that drops the keyword, or downgrading
// to max-age=3600) silently doubles request count from active users
// and undoes most of the cache-bust win.
//
// What this test asserts (against EDITOR_URL):
//   For each value in cool.html's __assetMap:
//     1. HEAD returns 200.
//     2. Cache-Control header EXACTLY equals
//        "public, max-age=31536000, immutable".
//
// Why exact match: a future refactor that emits "max-age=31536000,
// public, immutable" (different order) might still be safe but
// indicates someone touched the policy without thinking. The exact-
// match assertion forces the change to be intentional.
//
// Runtime: <2s (10 HEAD requests).

'use strict';

const env = require('./lib/test-env');
const __cl = require('./lib/inject-checklist');

const EDITOR = env.EDITOR_URL;
const EXPECTED_CC = 'public, max-age=31536000, immutable';

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
    console.log('=== Regression: hashed assets served with immutable Cache-Control ===');
    const t0 = Date.now();

    // Pull __assetMap out of cool.html — it's the source of truth
    // for which assets are hashed (and thus must be immutable).
    let assetMap;
    try {
        const resp = await fetch(EDITOR + '/browser/cool.html');
        const html = await resp.text();
        const m = html.match(/window\.__assetMap\s*=\s*(\{[^}]+\})/);
        if (!m) throw new Error('no __assetMap in cool.html');
        assetMap = JSON.parse(m[1]);
    } catch (e) {
        check('__assetMap parsed', false, e.message);
        process.exit(1);
    }
    check('__assetMap parsed',
          true, `${Object.keys(assetMap).length} entries`);

    for (const [logical, hashed] of Object.entries(assetMap)) {
        let resp;
        try {
            resp = await fetch(EDITOR + '/browser/' + hashed,
                              { method: 'HEAD' });
        } catch (e) {
            check(`HEAD ${logical}`, false, e.message);
            continue;
        }
        check(`HEAD ${logical} → 200`, resp.status === 200,
              `HTTP ${resp.status}`);
        if (resp.status !== 200) continue;

        const cc = resp.headers.get('cache-control') || '';
        check(`${logical} Cache-Control exact match`,
              cc === EXPECTED_CC,
              cc === EXPECTED_CC ? 'ok' : `got "${cc}"`);
    }

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e);
    process.exit(2);
});
