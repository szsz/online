// Regression: viewer's hardcoded AVAILABLE locale list in
// `wasm/viewer-public/lib/ui-lang.js` stays in sync with the
// deployed `/browser/l10n-chunks/l10n-manifest.json` emitted by
// `browser/util/create-l10n-all-js.py`.
//
// Background: the viewer's UI-language switcher uses a hardcoded
// AVAILABLE array (34 simple + 4 aliased = 38 locales) to populate
// its dropdown and to drive browser-detect resolution. This list is
// a manual mirror of `SIMPLE_LANGS` + `ALIASES` in
// create-l10n-all-js.py — the file that emits the per-locale chunks
// + the manifest. If create-l10n-all-js.py grows or drops a locale
// but ui-lang.js isn't updated in lock-step, the dropdown silently
// lags reality:
//   • new locale ships but isn't selectable in the dropdown
//   • dropped locale stays in dropdown → user picks it → 404
//     on the chunk → no localization for that user
//
// This test catches that drift class. It's a static check on the
// deployed manifest + the local ui-lang.js source. It MUST run
// against a build's deploy because the manifest is build-emitted;
// the test cannot just compare two source files.
//
// What this test asserts:
//   1. The deployed manifest is reachable and parses as JSON.
//   2. Every code in `manifest.locales[].code` (normalized
//      underscore→hyphen so `en_GB` → `en-GB`) appears in
//      ui-lang.js's AVAILABLE array.
//   3. Every code in ui-lang.js's AVAILABLE appears in the
//      manifest. The two sets must be exactly equal — no drift
//      in either direction.
//   4. Every code present in AVAILABLE also has a NAMES entry
//      (so the dropdown shows a display name, not just the code).
//
// Why this test rather than fetching the manifest at runtime:
//   • The viewer reads UI language BEFORE the iframe loads, which
//     determines `?lang=<code>` on the first cool.html fetch. A
//     synchronous manifest fetch at that stage would block iframe
//     load on a network round-trip; an async fetch can't influence
//     the FIRST language pick (only a subsequent reload). So the
//     hardcoded list IS the right choice — but it must not drift.
//     This test is the drift detector.
//
// Runtime: <1s, 1 GET + 1 local file read.

'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const __cl = require('../../lib/inject-checklist');

const EDITOR = env.EDITOR_URL;
const UI_LANG_SRC = path.join(__dirname, 'viewer-public', 'lib', 'ui-lang.js');

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) console.log('  ✓ ' + label);
    else {
        console.log('  ✗ FAIL: ' + label + (ev ? ' [' + ev + ']' : ''));
        allPassed = false;
    }
}

// Normalize a locale code to ui-lang.js's hyphen form. Manifest uses
// underscores in alias codes (en_GB, pt_BR, zh_CN, zh_TW); ui-lang
// uses hyphens (en-GB, pt-BR, zh-CN, zh-TW).
function normalize(code) { return code.replace(/_/g, '-'); }

(async () => {
    console.log('=== Regression: l10n manifest ↔ ui-lang.js AVAILABLE sync ===');
    const t0 = Date.now();

    // 1. Deployed manifest.
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
        check('manifest reachable', false, e.message);
        process.exit(1);
    }
    const manifestCodes = (manifest.locales || []).map(l => normalize(l.code)).sort();
    check('manifest has at least 30 locales',
          manifestCodes.length >= 30,
          `${manifestCodes.length} codes`);

    // 2. ui-lang.js source — extract AVAILABLE and NAMES.
    let src;
    try { src = fs.readFileSync(UI_LANG_SRC, 'utf8'); }
    catch (e) {
        check('ui-lang.js source readable', false, e.message);
        process.exit(1);
    }
    check('ui-lang.js source readable', src.length > 1000,
          `${src.length} bytes`);

    // Extract the AVAILABLE = [...] block. Tolerant of comments
    // between entries — strip line comments first, then pull every
    // `'<code>'`-shaped string within the AVAILABLE block. Without
    // the comment strip, quoted examples in comments (like `'-'` in
    // the section header) get matched as locale codes.
    const availBlock = src.match(/const\s+AVAILABLE\s*=\s*\[([\s\S]*?)\]\s*;/);
    check('AVAILABLE array present in ui-lang.js', !!availBlock,
          availBlock ? `${availBlock[1].length} bytes` : '(missing)');
    if (!availBlock) process.exit(1);
    const availBody = availBlock[1].replace(/\/\/[^\n]*/g, '');
    const availCodes = [...availBody.matchAll(/'([a-zA-Z][a-zA-Z-]*)'/g)]
        .map(m => m[1])
        .sort();
    check('AVAILABLE has at least 30 entries',
          availCodes.length >= 30,
          `${availCodes.length} entries`);

    // 3. Set-equality check — both directions.
    const inManifestNotInAvailable = manifestCodes.filter(c => !availCodes.includes(c));
    const inAvailableNotInManifest = availCodes.filter(c => !manifestCodes.includes(c));
    check('every manifest locale is in ui-lang.js AVAILABLE',
          inManifestNotInAvailable.length === 0,
          inManifestNotInAvailable.length ? inManifestNotInAvailable.join(',') : 'ok');
    check('every ui-lang.js AVAILABLE locale is in manifest',
          inAvailableNotInManifest.length === 0,
          inAvailableNotInManifest.length ? inAvailableNotInManifest.join(',') : 'ok');

    // 4. NAMES coverage — every AVAILABLE code should have a display name.
    // Extract NAMES = { ... } and pull keys.
    const namesBlock = src.match(/const\s+NAMES\s*=\s*\{([\s\S]*?)\}\s*;/);
    check('NAMES object present in ui-lang.js', !!namesBlock,
          namesBlock ? `${namesBlock[1].length} bytes` : '(missing)');
    if (namesBlock) {
        const namesBody = namesBlock[1].replace(/\/\/[^\n]*/g, '');
        const nameKeys = [...namesBody.matchAll(/['"]([a-zA-Z][a-zA-Z-]*)['"]\s*:/g)].map(m => m[1]);
        const missingNames = availCodes.filter(c => !nameKeys.includes(c));
        check('every AVAILABLE code has a NAMES entry',
              missingNames.length === 0,
              missingNames.length ? missingNames.join(',') : 'ok');
        // English isn't in AVAILABLE but MUST have a NAMES entry
        // (it's the dropdown's default option).
        check("NAMES['en'] present (English default)",
              nameKeys.includes('en'),
              nameKeys.includes('en') ? 'ok' : 'missing');
    }

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
