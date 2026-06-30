#!/usr/bin/env node
// cache-bust-build.js — inject the runtime shim into cool.html at build/
// deploy time. Despite the name, this no longer hashes filenames — that
// became redundant once each editor build started deploying into its own
// `${EDITOR_URL}/<APP_BUILD_ID>/` folder (per-deploy folder migration,
// 2026-05-11). The folder path is the version; renaming individual
// files to <base>.<8hex>.<ext> would be belt-and-suspenders that costs
// build-step complexity without adding cache-correctness.
//
// What this script DOES still do:
//   1. Strip the integrator branding refs from cool.html (we don't ship
//      branding.css / branding.js; leaving them in spams the console
//      with 404s on every cold load).
//   2. Inject a single <!-- COOL_CACHE_BUST_INJECT_BEGIN/END --> block
//      containing:
//        - <link rel="preload"> hints for the heavy assets
//        - a `window.__assetMap` of unhashed identity mappings — kept
//          for back-compat with wasm-loader.js + snapshot-inject-
//          locate-file.js + a handful of tests that probe it. The map
//          values are identical to their keys; the consumers all
//          fall through to the natural filename when the value is
//          identity, so the indirection is a no-op runtime-wise.
//        - a Module.locateFile shim — also no-op since the values
//          are identity, but kept for the same back-compat reason.
//        - the loading-overlay <style> + DOM
//        - <script> tags for wasm-loader / relay-adapter / dict-loader
//        - an inline <script> setting window.LANG from the ?lang= URL
//          param BEFORE bundle.js parses (l10n-all.js, prepended into
//          bundle.js, reads window.LANG synchronously at module load)
//   3. Strip any pre-existing hashed asset references in cool.html
//      back to their unhashed form (forward-migration: handles cool.html
//      checked out from before the hashing strip).
//
// What this script USED TO DO (and no longer does):
//   - Rename bundle.js → bundle.<hash>.js (and online.wasm, etc.). The
//     per-deploy folder URL `${EDITOR}/<id>/browser/bundle.js` is
//     already content-addressed by id, so the immutability + cache-bust
//     properties hold without filename hashing.
//
// If you're reading this because you're chasing a stale-cache bug:
// the per-deploy `/<id>/` URL is the cache-busting mechanism now. Each
// new deploy gets a new id, viewer iframe URLs roll, in-flight tabs
// keep working at the previous id until reload.

'use strict';

const fs = require('fs');
const path = require('path');

// Asset names that wasm-loader.js / snapshot-inject-locate-file.js /
// tests expect to look up in window.__assetMap. Post-Phase-3-strip,
// every value is the bare filename (identity map).
const ASSET_NAMES = [
    'wasm-loader.js', 'relay-adapter.js', 'dict-loader.js',
    'bundle.js', 'bundle.css', 'global.js', 'online.js',
    'online.wasm', 'soffice.data', 'soffice.data.js.metadata',
];

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Loading-overlay + spinner + progress UI shown over cool.html while
// the WASM runtime is fetching+instantiating. wasm-loader.js fades it
// out once Module is ready.
const WASM_LOADER_INJECT_STATIC = `
<style id="wasm-loading-style">
  #wasm-loading-overlay {
    position: fixed; inset: 0; background: #f5f5f5; z-index: 999999;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; color: #333;
  }
  #wasm-spinner {
    width: 64px; height: 64px; border: 6px solid #ddd; border-top-color: #4a90e2;
    border-radius: 50%; animation: wasmspin 1s linear infinite;
    margin-bottom: 16px;
  }
  @keyframes wasmspin { to { transform: rotate(360deg); } }
  #wasm-progress-label { font-size: 15px; font-weight: 500; margin-bottom: 8px; }
  #wasm-progress-bar {
    width: 300px; height: 12px; background: #e0e0e0; border-radius: 6px; overflow: hidden; margin-bottom: 6px;
  }
  #wasm-progress-fill {
    height: 100%; background: #4a90e2; transition: width 200ms ease-out; width: 0%;
  }
  #wasm-progress-bytes { font-size: 12px; color: #666; }
</style>
<div id="wasm-loading-overlay">
  <div id="wasm-spinner"></div>
  <div id="wasm-progress-label">Loading editor…</div>
  <div id="wasm-progress-bar"><div id="wasm-progress-fill"></div></div>
  <div id="wasm-progress-bytes"></div>
</div>
<script src="wasm-loader.js"></script>
<script src="dict-loader.js"></script>
<script src="relay-adapter.js"></script>
`;

function buildPreloadHints() {
    const lines = [];
    const heavy = [
        { name: 'online.wasm', as: 'fetch', type: 'application/wasm' },
        { name: 'soffice.data', as: 'fetch' },
        { name: 'soffice.data.js.metadata', as: 'fetch' },
        { name: 'bundle.js', as: 'script' },
        { name: 'bundle.css', as: 'style' },
        { name: 'online.js', as: 'script' },
        { name: 'global.js', as: 'script' },
    ];
    for (const h of heavy) {
        const typeAttr = h.type ? ` type="${h.type}"` : '';
        lines.push(`<link rel="preload" href="${h.name}" as="${h.as}"${typeAttr} crossorigin>`);
    }
    return lines.join('\n') + '\n';
}

function buildShim() {
    // window.__assetMap (identity values, kept for wasm-loader.js +
    // snapshot-inject-locate-file.js + a few tests that probe it).
    // The Module.locateFile shim is also no-op-equivalent — emscripten's
    // default `prefix + file` resolution would do the same thing — but
    // kept so wasm-loader's override hook chain stays intact.
    //
    // window.LANG init — MUST run BEFORE bundle.js (which has
    // l10n-all.js prepended at line 1: `var onlylang = window.LANG;
    // ...`). Without this, l10n-all.js reads `undefined`, falls into
    // the else branch, and LOCALIZATIONS stays empty even when the
    // viewer passed ?lang=<code>.
    //
    // Defined as a non-writable, non-configurable property: empirically
    // a downstream COOL path overwrites `window.LANG = "en-US"` after
    // init; the read-only descriptor makes the assignment a silent
    // no-op so l10n-all.js reads the URL-derived value every time.
    const identityMap = {};
    for (const n of ASSET_NAMES) identityMap[n] = n;
    return `<script>
(function(){
  window.__assetMap = ${JSON.stringify(identityMap)};
  var existing = (typeof window.Module === 'object' && window.Module) ? window.Module : {};
  var prevLocate = existing.locateFile;
  existing.locateFile = function(file, prefix) {
    var mapped = (window.__assetMap && window.__assetMap[file]) || file;
    if (typeof prevLocate === 'function') return prevLocate.call(this, mapped, prefix);
    return (prefix || '') + mapped;
  };
  // Gate Emscripten startup on sw-bridge.js becoming this iframe's
  // controller. Without this, kit fires the first GET /wasm/<fileId>
  // before navigator.serviceWorker.controller is set; the request
  // bypasses the bridge and falls through to the editor origin (Front
  // Door on Azure, editor-static-server.js locally) which has no
  // /wasm/ endpoint → 404 → kit can't load → canvas never paints →
  // 180s cross-type watchdog → test fails with chars=-1 or frame
  // detached. window.__swBridgeReady is exposed by wasm-loader.js
  // (~line 171); preInit returning a Promise blocks _main() until it
  // resolves. .catch(()=>{}) so a non-SW-capable runtime still boots —
  // worst case is the same pre-fix behaviour for that one client.
  existing.preInit = existing.preInit || [];
  existing.preInit.push(function() {
    if (typeof window.__swBridgeReady !== 'undefined' && window.__swBridgeReady) {
      return window.__swBridgeReady.catch(function(){});
    }
  });
  window.Module = existing;
  try {
    var __p = new URLSearchParams(window.location.search);
    var __lang = __p.get('lang') || 'en-US';
    Object.defineProperty(window, 'LANG', {
      value: __lang,
      writable: false,
      configurable: false,
      enumerable: true,
    });
  } catch (_) {
    try { Object.defineProperty(window, 'LANG',
            { value: 'en-US', writable: false, configurable: false }); }
    catch (_) { window.LANG = 'en-US'; }
  }
})();
</script>
`;
}

function rewriteCoolHtml(dir) {
    const cool = path.join(dir, 'cool.html');
    if (!fs.existsSync(cool)) {
        console.log('  cool.html: not found, skipping');
        return;
    }
    let html = fs.readFileSync(cool, 'utf8');

    // Strip integrator branding refs — we don't ship branding.{css,js}, so
    // the stock LO build's references would 404 + spam the console.
    html = html.replace(/\s*<link rel="stylesheet" href="branding\.css" \/>/g, '');
    html = html.replace(/\s*<script src="branding\.js"><\/script>/g, '');

    // Build the inject block. Markers bracket it so future re-runs replace
    // the whole block atomically (no partial-update drift — that's how
    // iter 76878b9069's window.LANG init silently regressed for weeks).
    const INJECT_BEGIN = '<!-- COOL_CACHE_BUST_INJECT_BEGIN -->';
    const INJECT_END   = '<!-- COOL_CACHE_BUST_INJECT_END -->';
    const inject = INJECT_BEGIN + '\n'
        + buildPreloadHints()
        + buildShim()
        + WASM_LOADER_INJECT_STATIC
        + INJECT_END + '\n';

    const beginIdx = html.indexOf(INJECT_BEGIN);
    const endIdx   = html.indexOf(INJECT_END);
    if (beginIdx >= 0 && endIdx > beginIdx) {
        html = html.slice(0, beginIdx) + inject
             + html.slice(endIdx + INJECT_END.length).replace(/^\s*\n/, '');
        console.log('  cool.html: replaced previous inject block');
    } else if (html.includes('window.__assetMap')) {
        // Legacy un-bracketed inject from an older cache-bust-build.js.
        const startTry = [
            html.indexOf('<link rel="preload"'),
            html.indexOf('<script>\n(function(){\n  window.__assetMap'),
        ].filter(i => i >= 0);
        const stripStart = startTry.length ? Math.min(...startTry) : -1;
        const relayMatch = html.match(/<script[^>]*src="relay-adapter[^"]*"[^>]*>\s*<\/script>/);
        const stripEnd = relayMatch
            ? (html.indexOf(relayMatch[0]) + relayMatch[0].length)
            : -1;
        if (stripStart >= 0 && stripEnd > stripStart) {
            html = html.slice(0, stripStart) + inject
                 + html.slice(stripEnd).replace(/^\s*\n/, '');
            console.log('  cool.html: migrated legacy inject block to bracketed form');
        } else {
            console.log('  cool.html: WARN: __assetMap present but legacy strip markers not found');
        }
    } else {
        // Fresh cool.html — first-time inject.
        const anchor = '<input type="hidden" id="init-mobile-app-os-type" value="EMSCRIPTEN" />';
        if (html.includes(anchor)) {
            html = html.replace(anchor, anchor + '\n' + inject);
        } else {
            html = html.replace('</body>', inject + '</body>');
        }
    }

    // Strip any legacy hashed references back to unhashed (forward
    // migration: handles cool.html that came out of a build before
    // the hashing strip).
    for (const orig of ASSET_NAMES) {
        const lastDot = orig.lastIndexOf('.');
        const base = orig.substring(0, lastDot);
        const ext = orig.substring(lastDot);
        const re = new RegExp(
            '(src|href)="' + escapeRe(base) +
            '\\.[0-9a-f]{8}' +
            escapeRe(ext) + '"', 'g');
        html = html.replace(re, '$1="' + orig + '"');
    }

    fs.writeFileSync(cool, html);
    console.log('  cool.html: rewritten');
}

function main() {
    const args = process.argv.slice(2);
    let dir = null;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--dir') dir = args[++i];
    }
    if (!dir) {
        console.error('usage: cache-bust-build.js --dir <browser-dist>');
        process.exit(1);
    }
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        console.error(`ERROR: ${dir} is not a directory`);
        process.exit(1);
    }
    console.log(`cache-bust-build: ${dir}`);
    rewriteCoolHtml(dir);
    console.log('cache-bust-build: done');
}

main();
