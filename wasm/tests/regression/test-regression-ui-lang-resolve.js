// Regression: viewer-public/lib/ui-lang.js's resolveBrowserPref
// returns the user's PRIMARY navigator.languages preference rather
// than skipping over English to the secondary preference.
//
// Background bug (caught in iter 26 review): English doesn't have a
// code in the AVAILABLE list (the empty-LOCALIZATIONS path IS the
// English UI). When a user's navigator.languages is e.g.
// ["en-US", "de"] (English speaker, German fallback), the original
// resolveBrowserPref:
//   1. tried "en-US" exact → not in AVAILABLE
//   2. tried region-loose "en-US" → not in AVAILABLE
//   3. tried primary "en" → not in AVAILABLE
//   4. continued to next entry "de" → MATCHED → returned "de"
// User asked for English; got German.
//
// Fix: when primary tag is "en" (any English flavor), short-circuit
// to "en" rather than continuing.
//
// What this test asserts (pure picker — no browser):
//   resolveBrowserPref(["en-US", "de"]) === "en"   ← bug repro
//   resolveBrowserPref(["en", "de"])    === "en"
//   resolveBrowserPref(["en-CA", "fr"]) === "en"
//   resolveBrowserPref(["de", "en"])    === "de"   ← German still wins when first
//   resolveBrowserPref(["fr-CA"])       === "fr"   ← primary-tag still works
//   resolveBrowserPref(["en-GB", "de"]) === "en-GB" ← exact alias still works
//   resolveBrowserPref(["zh-Hant-TW"])  === "zh-TW" ← region-loose still works
//   resolveBrowserPref([])              === "en"
//   resolveBrowserPref(["xx", "yy"])    === "en"   ← unsupported → English fallback
//
// Loads ui-lang.js into a synthetic JSDOM-like global and calls
// window.UILang.resolveBrowserPref directly. <50ms.

'use strict';

const fs = require('fs');
const path = require('path');
const __cl = require('../../lib/inject-checklist');

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) console.log('  ✓ ' + label);
    else {
        console.log('  ✗ FAIL: ' + label + (ev ? ' [' + ev + ']' : ''));
        allPassed = false;
    }
}

(() => {
    console.log('=== Regression: resolveBrowserPref respects English-primary ===');

    // Load ui-lang.js in a fake-window context. The IIFE attaches
    // window.UILang. We don't need a DOM — just a plain object
    // with localStorage stubs (readPin / writePin won't be called).
    const SCRIPT = path.join(__dirname, 'viewer-public', 'lib', 'ui-lang.js');
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const fakeWindow = {
        localStorage: {
            getItem: () => null, setItem: () => {}, removeItem: () => {},
        },
    };
    // ui-lang.js uses `window.UILang = { ... }` and `navigator.languages`
    // — provide both via vm sandbox-style globals.
    const fn = new Function('window', 'document', 'navigator', src);
    fn(fakeWindow,
       { createElement: () => ({}) },
       { languages: [], language: '' });

    if (!fakeWindow.UILang || !fakeWindow.UILang.resolveBrowserPref) {
        check('UILang.resolveBrowserPref is exported',
              false, 'not on fake window');
        process.exit(1);
    }
    check('UILang.resolveBrowserPref is exported', true, 'ok');
    const r = fakeWindow.UILang.resolveBrowserPref;

    const cases = [
        // [input, expected, label]
        [['en-US', 'de'], 'en', 'EN-primary skips DE-secondary'],
        [['en', 'de'],    'en', 'plain "en" primary'],
        [['en-CA', 'fr'], 'en', 'en-CA primary'],
        [['de', 'en'],    'de', 'DE-primary still wins'],
        [['fr-CA'],       'fr', 'primary-tag fr-CA → fr'],
        [['de-AT'],       'de', 'primary-tag de-AT → de'],
        [['en-GB', 'de'], 'en-GB', 'en-GB exact alias still wins'],
        [['pt-BR'],       'pt-BR', 'pt-BR exact alias'],
        [['zh-Hant-TW'],  'zh-TW', 'region-loose zh-Hant-TW → zh-TW'],
        [['zh-Hans-CN'],  'zh-CN', 'region-loose zh-Hans-CN → zh-CN'],
        [[],              'en', 'empty navigator.languages → en'],
        [['xx', 'yy'],    'en', 'unsupported langs → en fallback'],
        [['de_DE'],       'de', 'underscore separator de_DE → de'],
    ];
    for (const [input, expected, label] of cases) {
        const got = r(input);
        check(`${label}: ${JSON.stringify(input)} → ${expected}`,
              got === expected,
              `got "${got}"`);
    }

    process.exit(allPassed ? 0 : 1);
})();
