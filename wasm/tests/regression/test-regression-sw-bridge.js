// Regression: editor↔viewer comm goes through the SW bridge, not HTTP.
//
// Background: pre-FD-migration the editor exposed POST/GET /wasm/<id>
// (server-side blackboard) and the viewer made cross-origin fetches to
// it. As of the SW-bridge architecture, /wasm/<id>, /api/blobs/<hash>,
// /api/v2/file/<id>, and /api/files/<name> on the editor origin get
// intercepted by /sw-bridge.js (scope /) and routed to the parent
// (viewer) via postMessage — no HTTP between editor and viewer.
//
// This test asserts the deployed shape of the bridge:
//   1. /sw-bridge.js is reachable on the editor origin.
//   2. Its body contains BRIDGE_PREFIXES with /wasm/, /api/blobs/,
//      /api/v2/file/, /api/files/ — the four paths the bridge owns.
//   3. Its body installs `fetch` + `message` listeners.
//   4. cool.html-side wasm-loader.js registers `/sw-bridge.js` with
//      scope `/` and gates Kit on the controller via __swBridgeReady.
//   5. viewer-public/index.html loads `lib/editor-bridge.js` AND calls
//      EditorBridge.stage(...) when handing plaintext to the editor.
//   6. viewer-public/lib/editor-bridge.js has the
//      sw-bridge-request handler.
//
// Runtime: <1s. Hits the deployed editor origin once for /sw-bridge.js,
// then pulls the other files from the local working tree (we're
// checking THIS commit's source, not whatever happens to be deployed).

'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const __cl = require('../../lib/inject-checklist');

const EDITOR = env.EDITOR_URL;
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

function readRepo(rel) {
    return fs.readFileSync(path.join(REPO_WASM_DIR, rel), 'utf8');
}

(async () => {
    console.log('=== Regression: SW bridge architecture is in place ===');
    const t0 = Date.now();

    // 1 + 2 + 3. Deployed /sw-bridge.js.
    const swUrl = EDITOR + '/sw-bridge.js';
    let resp;
    try { resp = await fetch(swUrl); }
    catch (e) { check('GET ' + swUrl, false, e.message); process.exit(1); }
    check('GET /sw-bridge.js → 200', resp.status === 200, 'HTTP ' + resp.status);
    if (resp.status === 200) {
        const body = await resp.text();
        check('sw-bridge.js: BRIDGE_PREFIXES contains /wasm/',
            body.includes("'/wasm/'"));
        check('sw-bridge.js: BRIDGE_PREFIXES contains /api/blobs/',
            body.includes("'/api/blobs/'"));
        check('sw-bridge.js: BRIDGE_PREFIXES contains /api/v2/file/',
            body.includes("'/api/v2/file/'"));
        check('sw-bridge.js: BRIDGE_PREFIXES contains /api/files/',
            body.includes("'/api/files/'"));
        check('sw-bridge.js: BRIDGE_PREFIXES contains /api/keys/',
            body.includes("'/api/keys/'"));
        check("sw-bridge.js: addEventListener('fetch')",
            /addEventListener\(['"]fetch['"]/.test(body));
        check("sw-bridge.js: addEventListener('message')",
            /addEventListener\(['"]message['"]/.test(body));
    }

    // 4. wasm-loader.js registers /sw-bridge.js + gates Kit on it.
    const loader = readRepo('wasm-loader.js');
    check('wasm-loader.js: registers /sw-bridge.js with scope /',
        /serviceWorker\.register\(['"]\/sw-bridge\.js['"]\s*,\s*\{\s*scope:\s*['"]\/['"]\s*\}/.test(loader));
    check('wasm-loader.js: exposes __swBridgeReady promise',
        /window\.__swBridgeReady\s*=\s*new\s+Promise/.test(loader));
    check('wasm-loader.js: relays sw-bridge-request to window.parent',
        loader.includes('sw-bridge-request') && /window\.parent\.postMessage/.test(loader));
    check('wasm-loader.js: relays sw-bridge-response back to SW',
        loader.includes('sw-bridge-response')
        && /navigator\.serviceWorker\.controller\.postMessage/.test(loader));

    // 4b. cache-bust-build.js (the build-time HTML shim) MUST install a
    // Module.preInit that awaits __swBridgeReady. Without this gate,
    // kit's first GET /wasm/<fileId> races SW activation; on a fresh
    // browser context (every test gets one via isolatedContext) the SW
    // typically activates 50-500ms after iframe load while kit's
    // request can fire earlier. The bypassed request hits the editor
    // origin which has no /wasm/ endpoint → 404 → kit can't load →
    // canvas never paints → 180s cross-type watchdog → test fails.
    // ~40 of 60 phase-1 failures share this root cause.
    const shim = readRepo('tools/cache-bust-build.js');
    check('cache-bust-build.js: HTML shim adds Module.preInit',
        /existing\.preInit\s*=\s*existing\.preInit\s*\|\|\s*\[\]/.test(shim));
    check('cache-bust-build.js: preInit awaits __swBridgeReady',
        /preInit\.push[\s\S]{0,200}__swBridgeReady/.test(shim));

    // 5. viewer-public/index.html staged-cache wiring.
    const viewerIdx = readRepo('viewer-public/index.html');
    check('viewer-public/index.html: loads lib/editor-bridge.js',
        /<script\s+src=["']lib\/editor-bridge\.js["']/.test(viewerIdx));
    check('viewer-public/index.html: uses EditorBridge.stage',
        /EditorBridge\.stage\(/.test(viewerIdx));
    check("viewer-public/index.html: no `EDITOR + '/wasm/'` POSTs remain",
        !/EDITOR\s*\+\s*['"]\/wasm\//.test(viewerIdx));

    // 6. editor-bridge.js handler.
    const bridge = readRepo('viewer-public/lib/editor-bridge.js');
    check("editor-bridge.js: handles 'sw-bridge-request'",
        bridge.includes("'sw-bridge-request'"));
    check('editor-bridge.js: replies with sw-bridge-response',
        bridge.includes("'sw-bridge-response'"));
    check('editor-bridge.js: exposes EditorBridge.stage',
        /EditorBridge\s*=\s*\{[\s\S]*?stage:/.test(bridge));

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e);
    process.exit(2);
});
