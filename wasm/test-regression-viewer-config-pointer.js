// Regression: viewer's /config.js endpoint exposes EDITOR_DEPLOY_ID,
// which the viewer-side iframe URL builder consumes to construct the
// per-deploy editor path: `${EDITOR}/<EDITOR_DEPLOY_ID>/browser/cool.html`.
//
// Background: each editor build deploys to its own
// `${EDITOR_URL}/<APP_BUILD_ID>/` folder; the viewer reads which folder
// to point at from a host-side JSON file (VIEWER_CONFIG_FILE, NOT in
// git) that an operator updates via `bash wasm/promote-editor.sh <id>`.
// viewer-server.js exposes that pointer to viewer-public via
// /config.js → `window.__CONFIG.EDITOR_DEPLOY_ID`.
//
// What this test asserts on the deployed viewer:
//   1. GET /config.js returns 200 with JS content-type.
//   2. The body parses as the standard `window.__CONFIG = {...};`
//      assignment and the assigned object has the EDITOR_DEPLOY_ID
//      key (value MAY be empty string in flat-editor / unset mode —
//      we just lock down that the key is present so downstream
//      code paths that read it never get `undefined`).
//   3. GET /config (JSON variant for editor.html) also exposes
//      `editorDeployId` with the same value.
//   4. EDITOR_DEPLOY_ID, when non-empty, matches the format
//      YYYY-MM-DD-HHMMSS (a typo'd id would break the iframe URL).
//
// When this test fails: either viewer-server.js's /config.js rebuild
// dropped the EDITOR_DEPLOY_ID key, or the deployed viewer is running
// pre-substrate code that doesn't know about it. Either case is a
// regression the viewer's iframe builder needs to know about — the
// downstream EDITOR_BASE constant falls through to EDITOR (legacy
// flat) when the key is undefined, masking the bug as "stale viewer
// pointing at flat root".
//
// Runtime: <500ms, two GETs.

'use strict';

const env = require('./lib/test-env');
const __cl = require('./lib/inject-checklist');

const VIEWER = env.FILE_STORAGE_URL;

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
    console.log('=== Regression: viewer /config.js exposes EDITOR_DEPLOY_ID ===');
    const t0 = Date.now();

    // 1. /config.js — script form consumed by viewer-public/index.html
    let configJs;
    try {
        const r = await fetch(VIEWER + '/config.js');
        check('/config.js reachable', r.ok, `HTTP ${r.status}`);
        if (!r.ok) process.exit(1);
        const ct = r.headers.get('content-type') || '';
        check('/config.js content-type is JS',
              /javascript/i.test(ct), ct);
        configJs = await r.text();
    } catch (e) {
        check('/config.js reachable', false, e.message);
        process.exit(1);
    }

    // Extract the object literal assigned to window.__CONFIG. The payload
    // is small + uniform (no embedded function bodies); pulling the JSON
    // out via regex is good enough — no need to eval() untrusted text.
    const m = configJs.match(/window\.__CONFIG\s*=\s*(\{[\s\S]*?\})\s*;/);
    check('/config.js body assigns window.__CONFIG', !!m,
          m ? 'matched' : configJs.slice(0, 100));
    if (!m) process.exit(1);

    let cfg;
    try { cfg = JSON.parse(m[1]); }
    catch (e) { check('window.__CONFIG body parses as JSON', false, e.message); process.exit(1); }
    check('window.__CONFIG body parses as JSON', true, Object.keys(cfg).join(','));

    check('window.__CONFIG has EDITOR_DEPLOY_ID key',
          Object.prototype.hasOwnProperty.call(cfg, 'EDITOR_DEPLOY_ID'),
          `keys=${Object.keys(cfg).join(',')}`);

    const id = cfg.EDITOR_DEPLOY_ID;
    check('EDITOR_DEPLOY_ID is a string (possibly empty)',
          typeof id === 'string',
          `typeof=${typeof id} value=${JSON.stringify(id)}`);

    if (id) {
        check('EDITOR_DEPLOY_ID matches YYYY-MM-DD-HHMMSS format',
              /^\d{4}-\d{2}-\d{2}-\d{6}$/.test(id),
              id);
    } else {
        console.log('  · EDITOR_DEPLOY_ID is empty (flat-editor mode)');
    }

    // 2. /config (JSON variant) — same data, different shape (used by
    // editor.html, not the sidebar). Must surface the same id under
    // the camelCase `editorDeployId` field.
    let configJson;
    try {
        const r = await fetch(VIEWER + '/config');
        check('/config (JSON) reachable', r.ok, `HTTP ${r.status}`);
        if (r.ok) configJson = await r.json();
    } catch (e) {
        check('/config (JSON) reachable', false, e.message);
    }

    if (configJson) {
        check('/config JSON has editorDeployId',
              Object.prototype.hasOwnProperty.call(configJson, 'editorDeployId'),
              `keys=${Object.keys(configJson).join(',')}`);
        check('/config editorDeployId matches /config.js EDITOR_DEPLOY_ID',
              configJson.editorDeployId === id,
              `json=${JSON.stringify(configJson.editorDeployId)} js=${JSON.stringify(id)}`);
    }

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
