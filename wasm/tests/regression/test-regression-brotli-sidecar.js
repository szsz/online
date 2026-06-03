// Regression: every asset in cool.html's __assetMap must have a
// served brotli sidecar with a non-trivial compression ratio.
//
// Background — incident 2026-05-06 (build 2026-05-06-92):
//   deploy-azure.sh's prune step kept .br files keyed by the SOURCE
//   filename, but the prune-after-rehash logic dropped sidecars whose
//   names didn't include the hashed pattern. The build shipped 265 MB
//   of uncompressed assets to internal (vs the expected 71 MB) and
//   nobody noticed for a day until cold-load times spiked.
//
// What this test catches:
//   • A KEPT hashed asset that has no `.br` sibling.
//   • A `.br` sibling that's bigger than 0.6× source size — almost
//     certainly serving the source byte-for-byte (a stale or empty
//     stub) rather than a real brotli stream.
//
// Why a separate fast test, not part of cache-bust:
//   The cache-bust test asserts the manifest itself is well-formed.
//   This one asserts the deploy step *also* produced compressed
//   sidecars and the editor-static server actually serves them. A
//   cache-bust pass + brotli-sidecar fail is exactly the build-92
//   incident pattern.
//
// Runtime: < 2s (HEAD request per asset, no browser).

'use strict';

const env = require('../../lib/test-env');
const __cl = require('../../lib/inject-checklist');

const EDITOR = env.EDITOR_URL;
const MAX_RATIO = 0.6; // .br must be < 60% of source — typical 16–28%

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) console.log('  ✓ ' + label);
    else {
        console.log('  ✗ FAIL: ' + label + (ev ? ' [' + ev + ']' : ''));
        allPassed = false;
    }
}

async function fetchAsset(asset, acceptEncoding) {
    // HEAD: editor-static-server serves Content-Length on HEAD too
    // (verified via curl -I) and we want the on-the-wire compressed
    // length, not the auto-decompressed body size that undici
    // produces for any GET. Content-Length from the brotli HEAD
    // matches the .br sidecar size byte-for-byte.
    const url = EDITOR + '/browser/' + asset;
    const headers = {};
    if (acceptEncoding) headers['Accept-Encoding'] = acceptEncoding;
    const resp = await fetch(url, { method: 'HEAD', headers });
    const cl = resp.headers.get('content-length');
    return {
        ok: resp.ok,
        status: resp.status,
        contentEncoding: resp.headers.get('content-encoding') || '',
        contentLength: cl == null ? null : Number(cl),
    };
}

(async () => {
    console.log('=== Regression: brotli sidecar for every cool.html asset ===');
    const t0 = Date.now();

    // 1. Get the asset map.
    let assetMap = {};
    try {
        const cool = await fetch(EDITOR + '/browser/cool.html');
        const html = await cool.text();
        const m = html.match(/window\.__assetMap\s*=\s*(\{[^}]+\})/);
        check('cool.html exposes __assetMap', !!m,
              m ? `${Object.keys(JSON.parse(m[1])).length} entries`
                : 'no match');
        if (m) assetMap = JSON.parse(m[1]);
    } catch (e) {
        check('cool.html exposes __assetMap', false, e.message);
    }

    if (!allPassed) {
        // No assets to iterate — fail fast.
        console.log('\nDuration:', Date.now() - t0, 'ms');
        process.exit(allPassed ? 0 : 1);
    }

    // 2. For each asset: source byte size + brotli byte size + ratio.
    for (const [logical, hashed] of Object.entries(assetMap)) {
        let identity, brotli;
        try {
            identity = await fetchAsset(hashed, 'identity');
        } catch (e) {
            check(`identity fetch ${logical}`, false, e.message);
            continue;
        }
        check(`identity fetch ${logical}`, identity.ok && identity.contentLength != null,
              identity.ok ? `${identity.contentLength} bytes`
                          : `HTTP ${identity.status}`);
        if (!identity.ok || identity.contentLength == null) continue;

        try {
            brotli = await fetchAsset(hashed, 'br');
        } catch (e) {
            check(`brotli fetch ${logical}`, false, e.message);
            continue;
        }
        // The server must serve Content-Encoding: br for every
        // hashed asset. Anything else means the .br sidecar is
        // missing / stale / smaller-than-source.
        check(`Content-Encoding=br for ${logical}`,
              brotli.contentEncoding === 'br',
              `got "${brotli.contentEncoding}"`);
        if (brotli.contentEncoding !== 'br') continue;

        // Content-Length on the brotli response = on-the-wire .br
        // size. fetch (undici) auto-decompresses the BODY but the
        // HEADERS still carry the original Content-Length.
        if (brotli.contentLength == null) {
            check(`Content-Length present for br ${logical}`, false,
                  'header missing');
            continue;
        }
        const ratio = brotli.contentLength / identity.contentLength;
        check(`compression ratio ${logical} < ${MAX_RATIO}`,
              ratio < MAX_RATIO,
              `${(ratio * 100).toFixed(1)}% (br=${brotli.contentLength} src=${identity.contentLength})`);
    }

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e);
    process.exit(2);
});
