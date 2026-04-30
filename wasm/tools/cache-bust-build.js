#!/usr/bin/env node
// cache-bust-build.js — bake content hashes into asset filenames + cool.html
// at build/deploy time, so the served bundle is fully self-versioned and the
// webserver only has to set cache headers.
//
// Each long-cacheable asset is renamed in place to <base>.<hash>.<ext>
// (sha256[:8] of the file contents), its .br sidecar is renamed alongside,
// and cool.html is rewritten to reference the hashed names. cool.html also
// gets a one-shot inject containing the loading overlay, dict-loader /
// wasm-loader / relay-adapter <script> tags, and a Module.locateFile shim
// that remaps online.wasm / soffice.data / soffice.data.js.metadata to
// their hashed names (online.js fetches those by name internally).
//
// Usage:
//   node wasm/tools/cache-bust-build.js --dir <browser-dist>
//
// Idempotent:
//   - Plain assets that have already been renamed (no <base>.<ext> on disk
//     but a matching <base>.<hash>.<ext> exists) are reused — the hashed
//     name flows into cool.html exactly as in a fresh run.
//   - cool.html is only injected once: presence of window.__assetMap marks
//     the file as already processed.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HASHED_ASSETS = [
    // Custom loaders the WASM_LOADER_INJECT splices into cool.html.
    'wasm-loader.js', 'relay-adapter.js', 'dict-loader.js',
    // Heavy immutables referenced directly from cool.html.
    'bundle.js', 'bundle.css', 'global.js', 'online.js',
    // Referenced from inside online.js via Module.locateFile.
    'online.wasm', 'soffice.data', 'soffice.data.js.metadata',
];
const COOL_HTML_RENAMED = new Set([
    'wasm-loader.js', 'relay-adapter.js', 'dict-loader.js',
    'bundle.js', 'bundle.css', 'global.js', 'online.js',
]);
const LOCATE_FILE_RENAMED = new Set([
    'online.wasm', 'soffice.data', 'soffice.data.js.metadata',
]);

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function hashedName(name, hash) {
    const lastDot = name.lastIndexOf('.');
    return name.substring(0, lastDot) + '.' + hash + name.substring(lastDot);
}

function findExistingHashed(dir, name) {
    const lastDot = name.lastIndexOf('.');
    const base = name.substring(0, lastDot);
    const ext = name.substring(lastDot);
    const re = new RegExp('^' + escapeRe(base) + '\\.[0-9a-f]{8}' + escapeRe(ext) + '$');
    try {
        for (const f of fs.readdirSync(dir)) {
            if (re.test(f)) return f;
        }
    } catch (_) {}
    return null;
}

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
  #wasm-progress-bar-fill {
    height: 100%; background: linear-gradient(90deg, #4a90e2, #357abd); width: 0%;
    transition: width 0.3s ease;
  }
  #wasm-progress-detail { font-size: 12px; color: #666; }
</style>
<div id="wasm-loading-overlay">
  <div id="wasm-spinner"></div>
  <div id="wasm-progress-label">Loading editor…</div>
  <div id="wasm-progress-bar"><div id="wasm-progress-bar-fill"></div></div>
  <div id="wasm-progress-detail"></div>
</div>
<script type="text/javascript" src="dict-loader.js"></script>
<script type="text/javascript" src="wasm-loader.js"></script>
<script type="text/javascript" src="relay-adapter.js"></script>
`;

function buildLocateFileShim(map) {
    return `<script>
(function(){
  window.__assetMap = ${JSON.stringify(map)};
  var existing = (typeof window.Module === 'object' && window.Module) ? window.Module : {};
  var prevLocate = existing.locateFile;
  existing.locateFile = function(file, prefix) {
    var mapped = (window.__assetMap && window.__assetMap[file]) || file;
    if (typeof prevLocate === 'function') return prevLocate.call(this, mapped, prefix);
    return (prefix || '') + mapped;
  };
  window.Module = existing;
})();
</script>
`;
}

function hashAssetsInPlace(dir) {
    const map = {};
    for (const name of HASHED_ASSETS) {
        const src = path.join(dir, name);
        if (fs.existsSync(src)) {
            const content = fs.readFileSync(src);
            const hash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 8);
            const hashed = hashedName(name, hash);
            const dest = path.join(dir, hashed);
            // Rename in place (overwrite if a stale prior-build hash collides).
            if (fs.existsSync(dest)) {
                try { fs.unlinkSync(dest); } catch (_) {}
            }
            fs.renameSync(src, dest);
            // Move .br sidecar alongside if present.
            const srcBr = src + '.br';
            const destBr = dest + '.br';
            if (fs.existsSync(srcBr)) {
                if (fs.existsSync(destBr)) {
                    try { fs.unlinkSync(destBr); } catch (_) {}
                }
                fs.renameSync(srcBr, destBr);
            }
            map[name] = hashed;
            console.log(`  ${name} → ${hashed}`);
        } else {
            // Plain file missing — maybe a previous run already renamed it.
            const existing = findExistingHashed(dir, name);
            if (existing) {
                map[name] = existing;
                console.log(`  ${name} → ${existing} (already renamed)`);
            } else {
                console.log(`  ${name}: missing, skipping`);
            }
        }
    }
    return map;
}

function rewriteCoolHtml(dir, assetHashMap) {
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

    // One-shot inject: loading overlay + custom loaders + Module.locateFile
    // shim. The shim must run BEFORE online.js (which appears very early
    // in cool.html) so its first call into Module.locateFile sees the
    // asset map. The init-mobile-app-os-type input is the build-stable
    // anchor we splice in after.
    const alreadyInjected = html.includes('window.__assetMap');
    if (!alreadyInjected) {
        const locMap = {};
        for (const n of LOCATE_FILE_RENAMED) {
            if (assetHashMap[n]) locMap[n] = assetHashMap[n];
        }
        const inject = buildLocateFileShim(locMap) + WASM_LOADER_INJECT_STATIC;
        const anchor = '<input type="hidden" id="init-mobile-app-os-type" value="EMSCRIPTEN" />';
        if (html.includes(anchor)) {
            html = html.replace(anchor, anchor + '\n' + inject);
        } else {
            html = html.replace('</body>', inject + '</body>');
        }
    } else {
        console.log('  cool.html: inject already present, refreshing __assetMap only');
        // Refresh the map literal in case asset hashes have rolled.
        const locMap = {};
        for (const n of LOCATE_FILE_RENAMED) {
            if (assetHashMap[n]) locMap[n] = assetHashMap[n];
        }
        html = html.replace(
            /window\.__assetMap\s*=\s*\{[^}]*\};/,
            'window.__assetMap = ' + JSON.stringify(locMap) + ';');
    }

    // Rewrite plain refs to hashed.
    for (const orig of COOL_HTML_RENAMED) {
        const hashed = assetHashMap[orig];
        if (!hashed) continue;
        const re = new RegExp('(src|href)="' + escapeRe(orig) + '"', 'g');
        html = html.replace(re, '$1="' + hashed + '"');
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
    const map = hashAssetsInPlace(dir);
    rewriteCoolHtml(dir, map);
    console.log('cache-bust-build: done');
}

main();
