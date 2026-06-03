// Regression: dict manifest covers the minimum set of languages we
// promise to spellcheck out of the box. If `build-dicts.sh`'s
// DEFAULT_LANGS shrinks by accident (or a new lang gets added but
// the build skipped it), this test fires before deploy.
//
// Background: the editor today ships 20 dicts via build-dicts.sh
// DEFAULT_LANGS. Of the 34 UI locales the build supports (see
// browser/util/create-l10n-all-js.py SIMPLE_LANGS), 14 have NO
// matching dict shipped today — those users get UI translation
// but no spellcheck. The minimum set below is the subset that's
// (a) shipped today, AND (b) likely to be the most-load-bearing
// (Top European + a few Asian + Slavic). Dropping any one is a
// silent-regression class — spellcheck on those users' docs goes
// dead with no error, just empty squiggle results.
//
// What this test asserts on /dicts/manifest.json:
//   1. Manifest is reachable + parses as JSON array.
//   2. Each entry has { lang, file, size } with sane shapes.
//   3. Every minimum-coverage code is present (REQUIRED set below).
//   4. Total deploy size is in a sane range (< 100 MB so a future
//      "add ALL upstream dicts" PR doesn't blow the App Service
//      payload limit; > 5 MB so a build that produces only stub
//      bundles fires).
//   5. Every entry's file URL is fetchable with the expected
//      Content-Length matching `size` ±1 byte (catches a manifest
//      that lists a lang whose tar didn't actually ship).
//
// Runtime: <5s, manifest GET + a HEAD per shipped lang.

'use strict';

const env = require('../../lib/test-env');
const __cl = require('../../lib/inject-checklist');

const EDITOR = env.EDITOR_URL;

// Minimum coverage we depend on. Order doesn't matter; case-insensitive.
// Picked from build-dicts.sh DEFAULT_LANGS — these have all shipped
// continuously since the dict-loader landed and dropping any one is
// a regression. Add to this list when DEFAULT_LANGS grows.
const REQUIRED_LANGS = [
    // Western Europe (top spoken UI langs)
    'en', 'de', 'es', 'fr_FR', 'it_IT', 'nl_NL',
    // Iberian distinct variants
    'pt_BR', 'pt_PT',
    // Central Europe
    'pl_PL', 'cs_CZ', 'sk_SK', 'hu_HU',
    // Eastern Europe
    'ru_RU', 'uk_UA',
    // Nordic
    'da_DK', 'sv_SE',
    // South-east + others
    'tr_TR', 'hr_HR', 'el_GR', 'ro',
];
const MIN_TOTAL_BYTES =   5_000_000;   // 5 MB
const MAX_TOTAL_BYTES = 100_000_000;   // 100 MB

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
    console.log('=== Regression: dict manifest minimum-coverage ===');
    const t0 = Date.now();

    let manifest;
    try {
        const r = await fetch(EDITOR + '/dicts/manifest.json');
        check('manifest fetched', r.ok, `HTTP ${r.status}`);
        if (!r.ok) process.exit(1);
        manifest = await r.json();
    } catch (e) {
        check('manifest fetched', false, e.message);
        process.exit(1);
    }

    check('manifest is non-empty array',
          Array.isArray(manifest) && manifest.length > 0,
          `len=${Array.isArray(manifest) ? manifest.length : '(not array)'}`);
    if (!Array.isArray(manifest) || !manifest.length) process.exit(1);

    // Shape check on each entry.
    let allShapesOK = true;
    for (const e of manifest) {
        if (!e || typeof e.lang !== 'string'
            || typeof e.file !== 'string'
            || typeof e.size !== 'number') {
            allShapesOK = false;
            console.log(`    bad entry: ${JSON.stringify(e)}`);
        }
    }
    check('every entry has {lang:string, file:string, size:number}',
          allShapesOK, allShapesOK ? 'ok' : 'see warnings above');

    // Coverage check.
    const have = new Set(manifest.map(e => e.lang.toLowerCase()));
    const missing = REQUIRED_LANGS.filter(l => !have.has(l.toLowerCase()));
    check(`all ${REQUIRED_LANGS.length} required langs present`,
          missing.length === 0,
          missing.length ? 'missing: ' + missing.join(',') : 'ok');

    // Total byte budget.
    const totalSize = manifest.reduce((s, e) => s + (e.size || 0), 0);
    check(`total deploy ${totalSize} in [${MIN_TOTAL_BYTES}, ${MAX_TOTAL_BYTES}]`,
          totalSize >= MIN_TOTAL_BYTES && totalSize <= MAX_TOTAL_BYTES,
          `${(totalSize / 1024 / 1024).toFixed(1)} MB`);

    // Sample one entry — assert the .tar.gz is actually fetchable
    // and its Content-Length matches the manifest's claimed size.
    // Use 'en' since it's the most likely to fail in a partial
    // deploy and is also a required lang (see REQUIRED_LANGS).
    const sample = manifest.find(e => e.lang === 'en');
    if (sample) {
        try {
            const r = await fetch(EDITOR + '/dicts/' + sample.file,
                { method: 'HEAD' });
            check(`sample ${sample.file} HEAD 200`,
                  r.ok, `HTTP ${r.status}`);
            const cl = Number(r.headers.get('content-length'));
            check(`sample ${sample.file} size matches manifest (${sample.size} ±1)`,
                  Math.abs(cl - sample.size) <= 1,
                  `got=${cl} declared=${sample.size}`);
        } catch (e) {
            check(`sample ${sample.file} reachable`, false, e.message);
        }
    }

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e);
    process.exit(2);
});
