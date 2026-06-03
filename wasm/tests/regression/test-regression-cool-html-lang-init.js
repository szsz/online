// Regression: deployed cool.html has the window.LANG initializer
// shim that reads ?lang=<code> and locks window.LANG before
// bundle.js executes.
//
// Background: cache-bust-build.js's buildLocateFileShim emits both
// a Module.locateFile shim AND a window.LANG initializer wrapped
// in one IIFE. The LANG init was added in commit 76878b9069 ("ui-
// lang: lock window.LANG from ?lang= URL param so l10n actually
// applies"). But the deploy step runs cache-bust idempotently — and
// the original idempotent path only refreshed the __assetMap value
// inside the existing shim, leaving the rest of the shim body
// frozen at whatever the FIRST deploy injected. Deploys after
// 76878b9069 silently kept the old un-LANG-aware shim, so the
// editor read window.LANG as undefined and l10n-all.js fell into
// the English-fallback branch even when ?lang=de was passed.
//
// The user-visible symptom: the language switcher (viewer-side
// dropdown) writes a localStorage pin, reloads, the iframe URL
// gets the right &lang=<code>, but the editor UI stays English
// because window.LANG was never set inside the iframe.
//
// What this test asserts on deployed /browser/cool.html:
//   1. The cache-bust inject markers are present (means the deploy
//      ran the post-fix cache-bust-build.js).
//   2. The shim source includes a `window.LANG` Object.defineProperty
//      call (legacy un-LANG shims would miss this).
//   3. The shim references URLSearchParams + .get('lang')
//      (the parser that derives LANG from the URL query).
//
// Runtime: <300ms, single GET.

'use strict';

const env = require('../../lib/test-env');
const __cl = require('../../lib/inject-checklist');

const EDITOR = env.EDITOR_URL;

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
    console.log('=== Regression: cool.html has window.LANG init shim ===');
    const t0 = Date.now();

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

    // Cache-bust inject markers — newer cache-bust-build.js (post
    // iter 26) brackets the inject with HTML comments so legacy
    // un-bracketed cool.htmls can be migrated cleanly.
    check('COOL_CACHE_BUST_INJECT_BEGIN marker present',
          html.includes('<!-- COOL_CACHE_BUST_INJECT_BEGIN -->'),
          html.includes('<!-- COOL_CACHE_BUST_INJECT_BEGIN -->') ? 'ok' : 'missing');
    check('COOL_CACHE_BUST_INJECT_END marker present',
          html.includes('<!-- COOL_CACHE_BUST_INJECT_END -->'),
          html.includes('<!-- COOL_CACHE_BUST_INJECT_END -->') ? 'ok' : 'missing');

    // Window.LANG initializer must be inside the inject. Two variants
    // accepted: the strict `defineProperty(window, 'LANG'` form (the
    // current shim writes it as a non-writable, non-configurable
    // property to defeat downstream overwrites), or the older
    // `window.LANG =` assignment fallback (legacy variants).
    const hasDefineProperty = /Object\.defineProperty\s*\(\s*window\s*,\s*['"]LANG['"]/.test(html);
    const hasWindowLangAssign = /\bwindow\.LANG\s*=/.test(html);
    check('window.LANG initializer present in cool.html',
          hasDefineProperty || hasWindowLangAssign,
          hasDefineProperty ? 'defineProperty form'
              : hasWindowLangAssign ? 'assignment form'
              : 'NEITHER — l10n will read undefined');

    // The shim must read ?lang= from URLSearchParams. Without this,
    // ?lang=de in the URL is invisible to window.LANG.
    const readsLangParam = /URLSearchParams[\s\S]{0,300}\.get\s*\(\s*['"]lang['"]\s*\)/.test(html);
    check("shim reads ?lang= via URLSearchParams.get('lang')",
          readsLangParam,
          readsLangParam ? 'ok' : "no 'lang' URLSearchParams.get found near each other");

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e);
    process.exit(2);
});
