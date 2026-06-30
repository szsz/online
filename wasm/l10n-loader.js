// l10n-loader.js — picks a single locale chunk based on window.LANG
// and either injects it via document.write (synchronous, before
// bundle.js parses) or — when used purely as a precondition check —
// returns the chunk URL for caller-controlled loading.
//
// Why this file exists:
//   browser/dist/l10n-all.js bundles ALL ~38 locales into one ~5 MB
//   blob that lands inline at the top of bundle.js. Every cold page
//   load pays for every locale, and only one is shown. With the
//   per-locale chunks emitted by create-l10n-all-js.py --chunks-dir
//   (see browser/Makefile.am, target $(L10N_CHUNKS_DIR)), the loader
//   below picks ONE and ships ~50–150 kB instead.
//
// Wiring (deferred to a follow-up iter — keep this file dormant until
// l10n-all.js is also stripped out of bundle.js, otherwise both paths
// run and the second one wins):
//
//   1. Add to cool.html.m4 BEFORE bundle.js, NOT deferred:
//        <script>
//          (function () {
//            // Inline shim so document.write runs during parse and the
//            // chunk script is injected ahead of bundle.js in the
//            // parser queue.
//            var lang = (window.LANG || 'en').replace(/-/g, '_');
//            var url = '%SERVICE_ROOT%/browser/%VERSION%/l10n-chunks/'
//                    + 'l10n-' + lang + '.js';
//            document.write('<script src="' + url
//                         + '"><\/script>');
//          })();
//        </script>
//        <script src="...bundle.js" defer></script>
//
//   2. Remove l10n-all.js from cache-bust-build.js's bundle prepend
//      list (wasm/tools/cache-bust-build.js).
//
//   3. Update browser/Makefile.am to *also* exclude l10n-all.js from
//      the wasm install rsync (currently only excluded for
//      ENABLE_MOBILEAPP).
//
// What this file currently does:
//   Exposes window.L10nLoader with a pickChunkUrl(lang) helper. Tests
//   and follow-up wiring code call it; nothing in production loads
//   this file yet.
//
// Locale → chunk filename mapping mirrors create-l10n-all-js.py:
//   simple langs (ar, de, fr, …) → l10n-<code>.js
//   aliases ("en-GB", "zh-CN", …) → l10n-<code-with-underscores>.js
//   anything else → null (caller falls back to no chunk == English)

(function () {
    'use strict';

    var SIMPLE = [
        'ar', 'ca', 'cs', 'cy', 'da', 'de', 'el', 'es', 'eu', 'fi',
        'fr', 'ga', 'gl', 'he', 'hr', 'hu', 'hy', 'id', 'is', 'it',
        'ja', 'kk', 'ko', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl',
        'sq', 'sv', 'tr', 'uk',
    ];

    var ALIASES = {
        'en-GB': 'en_GB', 'en_GB': 'en_GB',
        'pt-BR': 'pt_BR', 'pt_BR': 'pt_BR',
        'zh-CN': 'zh_CN', 'zh_CN': 'zh_CN',
        'zh-Hans-CN': 'zh_CN', 'zh_Hans_CN': 'zh_CN',
        'zh-TW': 'zh_TW', 'zh_TW': 'zh_TW',
        'zh-Hant-TW': 'zh_TW', 'zh_Hant_TW': 'zh_TW',
    };

    function pickChunkCode(lang) {
        if (!lang || typeof lang !== 'string') return null;
        if (Object.prototype.hasOwnProperty.call(ALIASES, lang)) {
            return ALIASES[lang];
        }
        var onlylang = lang;
        var hyphen = onlylang.indexOf('-');
        if (hyphen > 0) onlylang = onlylang.substring(0, hyphen);
        var underscore = onlylang.indexOf('_');
        if (underscore > 0) onlylang = onlylang.substring(0, underscore);
        if (SIMPLE.indexOf(onlylang) >= 0) return onlylang;
        return null;
    }

    function pickChunkUrl(lang, baseDir) {
        var code = pickChunkCode(lang);
        if (!code) return null;
        var prefix = (baseDir || 'l10n-chunks').replace(/\/$/, '');
        return prefix + '/l10n-' + code + '.js';
    }

    window.L10nLoader = {
        SIMPLE: SIMPLE,
        ALIASES: ALIASES,
        pickChunkCode: pickChunkCode,
        pickChunkUrl: pickChunkUrl,
    };
})();
