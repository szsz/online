// ui-lang.js — viewer-side UI-language resolution + persistence.
//
// Why this lives in the viewer (not the editor): the viewer is the
// shell the user lands on; we want the language picked BEFORE the
// editor iframe loads so cool.html receives ?lang=<code> on its first
// fetch and l10n is correct from frame zero. (The editor reads
// window.LANG synchronously at startup — by the time we'd send a
// postMessage to switch, half the menus are already in English.)
//
// Resolution order (first match wins):
//   1. Explicit user override stored in localStorage as "cool-ui-lang"
//      (set by the dropdown). This pin survives across sessions.
//   2. Each entry in navigator.languages, in order, mapped onto the
//      build's available locales.
//   3. Fallback to "en" — which is the editor's empty-LOCALIZATIONS
//      branch, no chunk fetched.
//
// AVAILABLE_LOCALES is the set the build actually ships (matches the
// `simple` + `aliases` branches in browser/util/create-l10n-all-js.py).
// Until the build emits a generated manifest (Tier B / follow-up), we
// hard-code it here so the dropdown population stays correct without
// a runtime fetch.

(function () {
    'use strict';

    // 38 simple + 4 aliased = 42 distinct UI locales the build covers
    // today. Editing this list when create-l10n-all-js.py grows is the
    // ONLY place that needs to change. A generated manifest replacing
    // this hardcode is task 193 follow-up scope.
    const AVAILABLE = [
        // Codes that l10n-all.js matches directly on `onlylang`
        // (the part of LANG before any '-' or '_').
        'ar', 'ca', 'cs', 'cy', 'da', 'de', 'el', 'es', 'eu', 'fi',
        'fr', 'ga', 'gl', 'he', 'hr', 'hu', 'hy', 'id', 'is', 'it',
        'ja', 'kk', 'ko', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl',
        'sq', 'sv', 'tr', 'uk',
        // Region-specific aliases (l10n-all.js's window.LANG checks).
        'en-GB', 'pt-BR', 'zh-CN', 'zh-TW',
    ];

    // Display names — pulled from the most common Unicode CLDR entries
    // for each locale. Shown in the dropdown alongside the code so a
    // user finds their language even if they don't recognize the ISO
    // code. English is the default and lives at the top.
    const NAMES = {
        'en':    'English',
        'ar':    'العربية',
        'ca':    'Català',
        'cs':    'Čeština',
        'cy':    'Cymraeg',
        'da':    'Dansk',
        'de':    'Deutsch',
        'el':    'Ελληνικά',
        'es':    'Español',
        'eu':    'Euskara',
        'fi':    'Suomi',
        'fr':    'Français',
        'ga':    'Gaeilge',
        'gl':    'Galego',
        'he':    'עברית',
        'hr':    'Hrvatski',
        'hu':    'Magyar',
        'hy':    'Հայերեն',
        'id':    'Bahasa Indonesia',
        'is':    'Íslenska',
        'it':    'Italiano',
        'ja':    '日本語',
        'kk':    'Қазақ',
        'ko':    '한국어',
        'nl':    'Nederlands',
        'pl':    'Polski',
        'pt':    'Português',
        'ro':    'Română',
        'ru':    'Русский',
        'sk':    'Slovenčina',
        'sl':    'Slovenščina',
        'sq':    'Shqip',
        'sv':    'Svenska',
        'tr':    'Türkçe',
        'uk':    'Українська',
        'en-GB': 'English (UK)',
        'pt-BR': 'Português (BR)',
        'zh-CN': '中文 (简体)',
        'zh-TW': '中文 (繁體)',
    };

    const STORAGE_KEY = 'cool-ui-lang';

    // Match navigator.languages entries (e.g. "de-AT", "en-US",
    // "zh-Hant-TW") against AVAILABLE. We match in this order:
    //   exact: "en-GB" → "en-GB"
    //   region-loose: "zh-Hant-TW" → "zh-TW"  (matches the alias path
    //                                          in create-l10n-all-js.py)
    //   primary-tag: "de-AT" → "de"           (the simple-list match)
    function resolveBrowserPref(navLanguages) {
        const langs = (navLanguages && navLanguages.length)
            ? navLanguages
            : ['en'];
        for (const raw of langs) {
            if (!raw) continue;
            // Normalize separators (some browsers report "de_DE",
            // most report "de-DE"); l10n-all.js itself accepts both.
            const tag = String(raw).replace(/_/g, '-');
            // Exact (covers "en-GB", "pt-BR", etc.)
            if (AVAILABLE.indexOf(tag) >= 0) return tag;
            // "zh-Hant-TW" → "zh-TW"
            const m = tag.match(/^([a-z]+)(?:-[A-Z][a-z]+)?-([A-Z]+)$/);
            if (m) {
                const compact = m[1] + '-' + m[2];
                if (AVAILABLE.indexOf(compact) >= 0) return compact;
            }
            // Primary tag (covers "de-AT" → "de", "fr-CA" → "fr")
            const primary = tag.split('-')[0];
            if (AVAILABLE.indexOf(primary) >= 0) return primary;
        }
        return 'en';
    }

    function readPin() {
        try {
            const v = window.localStorage.getItem(STORAGE_KEY);
            // Only honour a pin that's still in the available set —
            // a build can drop a locale and we should fall back rather
            // than serve a 404 chunk. "en" pin returns "en" (fallback).
            if (v === 'en' || AVAILABLE.indexOf(v) >= 0) return v;
        } catch (_) { /* private mode etc. */ }
        return null;
    }

    function writePin(code) {
        try { window.localStorage.setItem(STORAGE_KEY, code); }
        catch (_) {}
    }

    function clearPin() {
        try { window.localStorage.removeItem(STORAGE_KEY); }
        catch (_) {}
    }

    // The single resolved code that the iframe URL should carry.
    // Read EXACTLY ONCE per viewer load — changing the dropdown
    // re-evaluates and re-loads the iframe rather than mutating this.
    function getActiveLang() {
        const pinned = readPin();
        if (pinned) return pinned;
        return resolveBrowserPref(navigator.languages || [navigator.language]);
    }

    // Build a <select> with the currently-active option marked. The
    // first entry is always English (the implicit default). Returns
    // the element; caller appends to wherever it wants.
    function buildSwitcher(active, onchange) {
        const sel = document.createElement('select');
        sel.id = 'ui-lang-switcher';
        sel.setAttribute('aria-label', 'UI language');
        // English first, others alphabetical by display name.
        const options = [['en', NAMES.en]].concat(
            AVAILABLE.map(c => [c, NAMES[c] || c])
                     .sort((a, b) => a[1].localeCompare(b[1])));
        for (const [code, label] of options) {
            const opt = document.createElement('option');
            opt.value = code;
            opt.text = label + ' (' + code + ')';
            if (code === active) opt.selected = true;
            sel.appendChild(opt);
        }
        sel.addEventListener('change', function () {
            const v = sel.value;
            if (v === 'en') clearPin();    // English = no pin (use default)
            else writePin(v);
            if (typeof onchange === 'function') onchange(v);
        });
        return sel;
    }

    window.UILang = {
        AVAILABLE: AVAILABLE,
        NAMES: NAMES,
        STORAGE_KEY: STORAGE_KEY,
        resolveBrowserPref: resolveBrowserPref,
        getActiveLang: getActiveLang,
        readPin: readPin,
        writePin: writePin,
        clearPin: clearPin,
        buildSwitcher: buildSwitcher,
    };
})();
