// Regression: cache-bust-build.js is idempotent across re-runs on a
// previously-injected cool.html.
//
// Background (iter 26 incident): the script's idempotent re-inject
// path used to ONLY refresh the __assetMap value inside the existing
// shim, leaving the rest of the shim body frozen at whatever the
// FIRST deploy injected. Iter 26 fixed this by bracketing the inject
// with HTML markers and replacing the WHOLE bracketed block on
// every run. This test pins that fix so a future refactor can't
// regress to the partial-update behavior — which silently froze
// out the window.LANG initializer for weeks.
//
// What this test asserts on deployed cool.html:
//   1. EXACTLY ONE `COOL_CACHE_BUST_INJECT_BEGIN` marker.
//   2. EXACTLY ONE `COOL_CACHE_BUST_INJECT_END` marker.
//   3. EXACTLY ONE `<script>` IIFE that starts with `(function(){`
//      and references `window.__assetMap` — duplicate IIFEs would
//      mean a botched re-inject left the old block AND added a new.
//   4. EXACTLY ONE relay-adapter `<script src=...>` tag — the inject
//      ends with this; duplicates indicate a partial strip.
//   5. EXACTLY ONE wasm-loader `<script src=...>` tag.
//
// Counts pin idempotency. A future iteration that runs cache-bust
// twice (e.g. once during build, once during deploy) without proper
// bracket-strip would produce 2x of each. This test fires before
// users see anything broken.
//
// Runtime: <300ms, single GET.

'use strict';

const env = require('./lib/test-env');
const __cl = require('./lib/inject-checklist');

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
    console.log('=== Regression: cache-bust idempotency on deployed cool.html ===');
    const t0 = Date.now();

    let html;
    try {
        const r = await fetch(EDITOR + '/browser/cool.html');
        check('cool.html fetched', r.ok, `HTTP ${r.status}`);
        if (!r.ok) process.exit(1);
        html = await r.text();
    } catch (e) {
        check('cool.html fetched', false, e.message);
        process.exit(1);
    }

    const beginCount = (html.match(/COOL_CACHE_BUST_INJECT_BEGIN/g) || []).length;
    const endCount   = (html.match(/COOL_CACHE_BUST_INJECT_END/g) || []).length;
    check('exactly 1 INJECT_BEGIN marker', beginCount === 1,
          `found ${beginCount}`);
    check('exactly 1 INJECT_END marker', endCount === 1,
          `found ${endCount}`);

    // The locateFile/LANG-init IIFE — count IIFE openings whose
    // first statement is window.__assetMap.
    const assetMapIifes = (html.match(/\(function\s*\(\s*\)\s*\{\s*\n?\s*window\.__assetMap/g) || []).length;
    check('exactly 1 IIFE that initializes window.__assetMap',
          assetMapIifes === 1, `found ${assetMapIifes}`);

    // Sanity: the script tags should each appear once in the inject
    // block (they may also appear as preload <link> entries — those
    // don't have `src=` so they don't match these regexes).
    const wasmLoaderTags = (html.match(/<script[^>]*\bsrc=["'][^"']*\bwasm-loader/g) || []).length;
    check('exactly 1 wasm-loader <script src=...> tag',
          wasmLoaderTags === 1, `found ${wasmLoaderTags}`);

    const relayAdapterTags = (html.match(/<script[^>]*\bsrc=["'][^"']*\brelay-adapter/g) || []).length;
    check('exactly 1 relay-adapter <script src=...> tag',
          relayAdapterTags === 1, `found ${relayAdapterTags}`);

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
