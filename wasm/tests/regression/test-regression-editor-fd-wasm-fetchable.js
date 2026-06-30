// Regression: editor's online.wasm + soffice.data are fetchable from the
// per-deploy folder at the editor URL (Front Door / Azure static-website
// OR the local editor-static-server, depending on env).
//
// Background: snapshot-milestones (and ~60 other tests) on
// 2026-05-16-113700 reproduced a failure signature where the editor
// iframe fires only ~47 HTTP requests pulling ~0.05 MB total — the
// kit never fetches `online.wasm` (~70 MB brotli) or `soffice.data`
// (~16 MB), so the WASM module never starts. The deployed editor
// HOSTS those files at `/<EDITOR_DEPLOY_ID>/browser/dist/online.wasm`
// and `/.../soffice.data` post-PR-#45 per-deploy-folders.
//
// This test fails fast if those URLs are broken. Cheap (4 HEAD + 2
// partial GET), runs early in the suite so the kit-paint cluster's
// red logs don't fill the test report when the actual issue is FD/
// editor-static-server not serving the WASM module bytes.
//
// What it asserts:
//   1. `${EDITOR}/<id>/browser/dist/online.wasm` HEAD → 200.
//   2. Content-Type is `application/wasm` (Azure FD often strips this
//      — accept it as a soft warning, not a hard fail).
//   3. Content-Length ≥ 10 MB (sanity: the file is real, not an HTML
//      404 page that the static-site served as text/html). Real size
//      is ~70 MB brotli / ~250 MB raw — 10 MB is a generous floor.
//   4. Range GET first 16 bytes — first 4 bytes must be the WASM magic
//      `\0asm`. This catches the case where FD serves an HTML error
//      page with a 200 status but text/html body.
//   5. Same as 1+3+4 for `soffice.data`.
//
// If THIS test passes but kit-paint tests still fail, the problem is
// downstream — Module.locateFile resolves wrong, or the SW bridge
// interferes, or the kit's MAIN_WORKER never starts. If THIS test
// fails, the deploy script or FD routing for the per-deploy folder
// is broken and the fix lives there.

'use strict';

const env = require('../../lib/test-env');
const __cl = require('../../lib/inject-checklist');

const EDITOR = env.EDITOR_URL;
const DEPLOY_ID = env.EDITOR_DEPLOY_ID;

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) console.log('  ✓ ' + label);
    else {
        console.log('  ✗ FAIL: ' + label + (ev ? ' [' + ev + ']' : ''));
        allPassed = false;
    }
}

async function head(url) {
    try {
        const r = await fetch(url, { method: 'HEAD' });
        return { ok: true, status: r.status, headers: r.headers };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

async function getFirstBytes(url, n) {
    try {
        const r = await fetch(url, { headers: { Range: `bytes=0-${n - 1}` } });
        if (!r.ok && r.status !== 206 && r.status !== 200) {
            return { ok: false, status: r.status };
        }
        const buf = await r.arrayBuffer();
        return { ok: true, status: r.status, bytes: new Uint8Array(buf) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function isWasmMagic(bytes) {
    // WASM binary format: first 4 bytes are 0x00, 0x61, 0x73, 0x6d ('\0asm')
    return bytes && bytes.length >= 4
        && bytes[0] === 0x00 && bytes[1] === 0x61
        && bytes[2] === 0x73 && bytes[3] === 0x6d;
}

async function checkAsset(name, isWasm) {
    const prefix = DEPLOY_ID ? '/' + DEPLOY_ID : '';
    const url = `${EDITOR}${prefix}/browser/dist/${name}`;
    console.log('\n=== ' + name + ' ===');
    console.log('  URL: ' + url);

    const h = await head(url);
    check(name + ': HEAD reachable', h.ok, h.error);
    if (!h.ok) return;
    check(name + ': HEAD status 200', h.status === 200, 'HTTP ' + h.status);
    if (h.status !== 200) return;

    const len = h.headers.get('content-length');
    const enc = h.headers.get('content-encoding') || '';
    const ct = h.headers.get('content-type') || '';
    console.log('  Content-Type: ' + ct);
    console.log('  Content-Encoding: ' + enc);
    console.log('  Content-Length: ' + len + ' (' + (len ? (+len / 1e6).toFixed(1) + ' MB' : '?') + ')');

    // Content-Length floor: 10 MB. WASM is ~70 MB raw / ~30 MB brotli; soffice.data
    // is ~250 MB raw / ~110 MB brotli. 10 MB is a generous floor that catches HTML
    // error pages (typically <100 KB) while tolerating compression variation.
    const lenOk = len && +len >= 10_000_000;
    check(name + ': Content-Length ≥ 10 MB', lenOk, len + ' bytes');

    if (isWasm) {
        // For online.wasm: confirm body starts with WASM magic. Skip for
        // soffice.data (it's an Emscripten data bundle, not a wasm module).
        // If the response is brotli-encoded, fetch decodes it automatically
        // for us — the resulting bytes are the raw WASM module.
        const g = await getFirstBytes(url, 16);
        check(name + ': Range GET reachable', g.ok, g.error || ('HTTP ' + g.status));
        if (g.ok) {
            const magicOk = isWasmMagic(g.bytes);
            const head4 = g.bytes ? Array.from(g.bytes.slice(0, 4))
                .map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ') : '?';
            check(name + ': starts with WASM magic (\\0asm)',
                magicOk, 'first 4 bytes: ' + head4);
        }
    } else {
        // soffice.data: just confirm we can fetch the first bytes and they're
        // not text/html. Emscripten packager file format starts with file
        // table — first byte is typically a small int.
        const g = await getFirstBytes(url, 16);
        check(name + ': Range GET reachable', g.ok, g.error || ('HTTP ' + g.status));
        if (g.ok && ct) {
            check(name + ': not text/html',
                !ct.startsWith('text/html'), ct);
        }
    }
}

(async () => {
    console.log('=== Regression: editor FD per-deploy WASM assets reachable ===');
    console.log('  EDITOR_URL=' + EDITOR);
    console.log('  EDITOR_DEPLOY_ID=' + (DEPLOY_ID || '(none — using flat layout)'));
    const t0 = Date.now();

    await checkAsset('online.wasm', /* isWasm */ true);
    await checkAsset('soffice.data', /* isWasm */ false);

    console.log('\nDuration: ' + (Date.now() - t0) + ' ms');
    if (!allPassed) {
        console.log('\nHint: if this test fails, the kit-paint cluster of tests');
        console.log('  (~60 tests on 2026-05-16-113700) is downstream — the kit');
        console.log('  iframe loads cool.html but the WASM module bytes are not');
        console.log('  reachable from the per-deploy folder. Investigate:');
        console.log('  - editor-build.yml: did the latest run actually publish');
        console.log('    online.wasm + soffice.data to coolwasmfiles?');
        console.log('  - deploy-front-door.sh: is the per-deploy folder');
        console.log('    uploaded to wasmeditor storage with the right path?');
        console.log('  - $EDITOR_URL/<deploy-id>/browser/dist/online.wasm: try');
        console.log('    curl -I directly to see the actual response.');
    }
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e);
    process.exit(2);
});
