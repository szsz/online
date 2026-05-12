// Regression: /wasm/<name> (the plaintext transit endpoint between
// viewer and editor) lives on the VIEWER, not the editor.
//
// Background: the editor used to host POST/GET /wasm/:name. As of the
// FD migration (2026-05-12), the editor is fully static behind Front
// Door + Storage; the dynamic /wasm/ endpoint moved to viewer-server.
// All client refs (viewer-public/index.html, wasm-loader.js's
// switchdocument, relay-adapter.js's late-join/save) now resolve to
// the viewer via resolveFileStorageBase() / the fileStorageUrl param.
//
// This lockdown asserts:
//   1. POST FILE_STORAGE_URL/wasm/<name> succeeds (200) and the
//      response body shape is { name, size }.
//   2. GET FILE_STORAGE_URL/wasm/<name> returns the same bytes.
//   3. The GET response carries Cross-Origin-Resource-Policy:
//      cross-origin so the editor iframe (COEP:require-corp) can load
//      the file without ERR_BLOCKED_BY_RESPONSE.
//   4. EDITOR_URL/wasm/<name> POST/GET is NOT expected to work post-
//      cutover (best-effort — App-Service legacy may still answer
//      during the transition, so this is reported, not asserted).
//
// Runtime: <2s.

'use strict';

const env = require('./lib/test-env');
const __cl = require('./lib/inject-checklist');
const crypto = require('crypto');

const VIEWER = env.FILE_STORAGE_URL;
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
    console.log('=== Regression: /wasm/<name> is hosted by the viewer (not editor) ===');
    const t0 = Date.now();

    const name = 'regression-endpoint-' + crypto.randomBytes(6).toString('hex') + '.bin';
    const body = crypto.randomBytes(512);

    // 1. POST viewer/wasm/<name>
    let postResp, postJson;
    try {
        postResp = await fetch(VIEWER + '/wasm/' + encodeURIComponent(name), {
            method: 'POST', body,
        });
        postJson = await postResp.json().catch(() => null);
    } catch (e) {
        check('POST viewer/wasm/<name> network', false, e.message);
        process.exit(1);
    }
    check('POST viewer/wasm/<name> → 200', postResp.status === 200,
          'HTTP ' + postResp.status);
    check('POST response { name, size } shape',
          postJson && postJson.name === name && postJson.size === body.length,
          postJson ? JSON.stringify(postJson) : 'no JSON');

    // 2. GET viewer/wasm/<name> — same bytes back
    let getResp, gotBytes;
    try {
        getResp = await fetch(VIEWER + '/wasm/' + encodeURIComponent(name));
        const ab = await getResp.arrayBuffer();
        gotBytes = Buffer.from(ab);
    } catch (e) {
        check('GET viewer/wasm/<name> network', false, e.message);
        process.exit(1);
    }
    check('GET viewer/wasm/<name> → 200', getResp.status === 200,
          'HTTP ' + getResp.status);
    check('GET returns identical bytes',
          gotBytes && gotBytes.length === body.length && gotBytes.equals(body),
          gotBytes ? `${gotBytes.length}B / expected ${body.length}B` : 'no bytes');

    // 3. CORP:cross-origin so the editor iframe (COEP:require-corp) can
    // load the file. CORS Allow-Origin alone wouldn't be enough for the
    // browser's resource-policy check.
    const corp = (getResp.headers.get('cross-origin-resource-policy') || '').toLowerCase();
    check('GET carries CORP: cross-origin',
          corp === 'cross-origin', 'got "' + corp + '"');

    // 4. Editor /wasm/ is NOT the canonical location post-cutover.
    // Reported, not asserted — App-Service legacy may still answer
    // during the transition. Surfaces the cutover progress in the log.
    if (EDITOR && EDITOR !== VIEWER) {
        try {
            const r = await fetch(EDITOR + '/wasm/' + encodeURIComponent(name));
            console.log('  · editor/wasm/<name> HTTP ' + r.status
                + (r.status === 200 ? ' (legacy App-Service still answering)' : ''));
        } catch (e) {
            console.log('  · editor/wasm/<name> fetch error: ' + e.message);
        }
    }

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e);
    process.exit(2);
});
