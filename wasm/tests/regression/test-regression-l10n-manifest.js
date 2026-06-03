// Regression: l10n-chunks/l10n-manifest.json shipped by the build is
// well-formed and complete.
//
// Background: iter 8 added a per-locale chunk emit step to
// browser/Makefile.am — create-l10n-all-js.py --chunks-dir produces
// 38 self-contained l10n-<code>.js files (one per locale the build
// supports) plus a manifest enumerating them with size + alias
// metadata. This is the bandwidth-saving substrate for the lazy-load
// path (iter 9 added the loader; eventual iter strips l10n-all.js
// from bundle.js and wires the loader into cool.html.m4).
//
// What this test asserts on the deployed manifest:
//   1. /browser/l10n-chunks/l10n-manifest.json exists and is valid JSON.
//   2. It contains every locale we expect (34 simple + 4 aliased = 38).
//   3. total_bytes is in a sane range (5–15 MB — anything outside is
//      either a degenerate build with empty/missing chunks or a bloat
//      regression worth investigating).
//   4. Every locale entry declares size > 30 KB (the smallest locale
//      we ship today is ~50 KB; below 30 KB means the chunk's
//      LOCALIZATIONS payload was truncated or empty).
//   5. The corresponding chunk file is fetchable and has size matching
//      the manifest declaration ±1 byte (catches a partial deploy
//      where the manifest shipped but the chunks didn't).
//
// Why a regression test rather than build-time check: the manifest
// could be perfect at build time but the deploy step (rsync EXCLUDES
// in browser/Makefile.am, prune logic in deploy-azure.sh) might drop
// it. This catches "deployed editor is missing the manifest" — the
// build-92-style bug class but for the l10n chunks tree.
//
// Runtime: < 5s (HEAD requests for chunks, GET for manifest).

'use strict';

const env = require('./lib/test-env');
const __cl = require('./lib/inject-checklist');

const EDITOR = env.EDITOR_URL;

// Mirrors browser/util/create-l10n-all-js.py SIMPLE_LANGS + ALIASES.
const EXPECTED_LOCALES = [
    'ar', 'ca', 'cs', 'cy', 'da', 'de', 'el', 'es', 'eu', 'fi',
    'fr', 'ga', 'gl', 'he', 'hr', 'hu', 'hy', 'id', 'is', 'it',
    'ja', 'kk', 'ko', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl',
    'sq', 'sv', 'tr', 'uk',
    'en_GB', 'pt_BR', 'zh_CN', 'zh_TW',
];
const MIN_LOCALE_SIZE = 30_000;       // bytes; smallest shipped today ~50 KB
const MIN_TOTAL_BYTES = 5_000_000;    // 5 MB
const MAX_TOTAL_BYTES = 15_000_000;   // 15 MB

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
    console.log('=== Regression: l10n-chunks manifest is well-formed ===');
    const t0 = Date.now();

    let manifest;
    try {
        const resp = await fetch(EDITOR + '/browser/l10n-chunks/l10n-manifest.json');
        check('manifest reachable', resp.ok, `HTTP ${resp.status}`);
        if (!resp.ok) {
            console.log('\nDuration:', Date.now() - t0, 'ms');
            process.exit(1);
        }
        manifest = await resp.json();
    } catch (e) {
        check('manifest parses as JSON', false, e.message);
        process.exit(1);
    }

    check('manifest.locales is an array', Array.isArray(manifest.locales),
          typeof manifest.locales);
    check('manifest.total_bytes is a number',
          typeof manifest.total_bytes === 'number',
          typeof manifest.total_bytes);

    // Enumerate codes and assert coverage matches what create-l10n-all-js.py
    // ships today. A code that appears in EXPECTED but not in the manifest
    // means the build dropped it (or the script's lang list shrank).
    const got = new Set((manifest.locales || []).map(l => l.code));
    const missing = EXPECTED_LOCALES.filter(c => !got.has(c));
    const extra = [...got].filter(c => !EXPECTED_LOCALES.includes(c));
    check(`all ${EXPECTED_LOCALES.length} expected locales present`,
          missing.length === 0,
          missing.length ? 'missing: ' + missing.join(',') : 'ok');
    check('no unexpected locales',
          extra.length === 0,
          extra.length ? 'extra: ' + extra.join(',') : 'ok');

    check(`total_bytes between ${MIN_TOTAL_BYTES} and ${MAX_TOTAL_BYTES}`,
          manifest.total_bytes >= MIN_TOTAL_BYTES &&
          manifest.total_bytes <= MAX_TOTAL_BYTES,
          `${manifest.total_bytes}`);

    let allLocalesBigEnough = true;
    let smallest = { code: '?', size: Infinity };
    for (const loc of manifest.locales || []) {
        if (loc.size < MIN_LOCALE_SIZE) {
            allLocalesBigEnough = false;
            console.log(`    too small: ${loc.code} = ${loc.size} bytes`);
        }
        if (loc.size < smallest.size) smallest = { code: loc.code, size: loc.size };
    }
    check(`every locale > ${MIN_LOCALE_SIZE} bytes`,
          allLocalesBigEnough,
          `smallest=${smallest.code} ${smallest.size}b`);

    // Sample one chunk: assert it's actually fetchable + size matches.
    // 'de' is always present; if it isn't, missing-locale check above
    // will already have flagged it.
    const de = (manifest.locales || []).find(l => l.code === 'de');
    if (de) {
        try {
            const r = await fetch(
                EDITOR + '/browser/l10n-chunks/' + de.file,
                { method: 'HEAD' });
            const cl = Number(r.headers.get('content-length'));
            check(`chunk ${de.file} reachable`, r.ok, `HTTP ${r.status}`);
            check(`chunk ${de.file} size matches manifest (${de.size}±1)`,
                  Math.abs(cl - de.size) <= 1,
                  `got=${cl} expected=${de.size}`);
        } catch (e) {
            check(`chunk ${de.file} reachable`, false, e.message);
        }
    }

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e);
    process.exit(2);
});
