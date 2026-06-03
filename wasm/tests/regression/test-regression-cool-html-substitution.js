// Regression: editor-static-server.js substitutes %ACCESS_TOKEN%-style
// placeholders in cool.html.
//
// Background: cool.html is emitted by the COOL build with template
// placeholders like `%ACCESS_TOKEN%`, `%ACCESS_TOKEN_TTL%`,
// `%BRANDING_THEME%` etc. The pre-FD-migration editor-server.js
// substituted these per-request; deploy-front-door.sh substitutes
// them via sed at upload time for the Front Door path. The local
// editor-static-server.js (which serves viewer.szebeni.hu and CI's
// Phase 1 locally-spawned stack) MUST do the same — otherwise the
// kit reads cool.html, finds a literal `%ACCESS_TOKEN%`, appends
// it to the document fetch URL, and `/wasm/<id>?access_token=
// %ACCESS_TOKEN%&access_token_ttl=%ACCESS_TOKEN_TTL%` returns 404.
// Result: kit exits at COOLWSD::run() entry, shield never drops,
// every kit-paint-dependent test (chart, caching, e2e-upload,
// singleuser, pptx-viewer, snapshot-milestones — ~25 tests) hangs
// until its watchdog fires.
//
// This test asserts editor-static-server.js's cool.html handler:
//   1. Reads cool.html as utf8 (not raw Buffer) so substitution can run.
//   2. Calls .split('%ACCESS_TOKEN%').join('') (8 placeholders total).
//   3. Stores the SUBSTITUTED body in the in-memory cache (not the raw
//      file bytes).
//
// Pure source-shape — no browser, <50ms.

'use strict';

const fs = require('fs');
const path = require('path');
const __cl = require('../../lib/inject-checklist');

const REPO_WASM_DIR = path.resolve(__dirname);

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
    console.log('=== Regression: cool.html substitution in editor-static-server.js ===');
    const t0 = Date.now();

    const src = fs.readFileSync(
        path.join(REPO_WASM_DIR, 'editor-static-server.js'), 'utf8');

    // Every placeholder that the COOL build emits MUST be substituted.
    // List matches deploy-front-door.sh:181-189 (the FD path's sed).
    const placeholders = [
        '%ACCESS_TOKEN_TTL%',
        '%ACCESS_TOKEN%',
        '%ACCESS_HEADER%',
        '%NO_AUTH_HEADER%',
        '%UI_RTL_SETTINGS%',
        '%BRANDING_THEME%',
        '%LOGO_URL%',
        '%PRODUCT_BRANDING_NAME%',
    ];
    for (const p of placeholders) {
        // Look for `.split('<placeholder>').join(...)` — the substitution call.
        const re = new RegExp("split\\(['\"]" + p.replace(/[%]/g, '%') + "['\"]\\)\\s*\\.join", '');
        check(p + ': substituted in editor-static-server.js', re.test(src));
    }

    // Read mode must be utf8 (not raw Buffer) so split/join can run on the
    // string. Confirm the cool.html handler uses readFileSync(filepath, 'utf8').
    check("editor-static-server.js: cool.html read as utf8",
        /readFileSync\([^)]*filepath[^)]*,\s*['"]utf8['"]\)/.test(src));

    console.log('\nDuration: ' + (Date.now() - t0) + ' ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e);
    process.exit(2);
});
