// Regression: viewer's /api/v2/file/:fileId GET response shape.
//
// Background: the v2-encrypted file storage contract (see
// wasm/CLAUDE.md "v2 files...the endpoint returns
// {ciphertext, encName, size, updatedAt}") returns a JSON object
// with exactly these fields:
//
//   ciphertext: base64-encoded AES-GCM blob (iv + payload + authTag)
//   encName:    base64-encoded AES-GCM blob of the filename
//   size:       number, CIPHERTEXT byte count (used for change
//               detection — viewer hashes ciphertext, server tracks
//               size as a fast pre-hash check)
//   updatedAt:  ISO 8601 string, server-side mtime (e.g.
//               "2026-05-07T22:10:14.412Z")
//
// No plaintext fields, no displayName, no hash. The viewer's
// openFileBySecret() flow + the test suite's hash-based change-
// detection pattern both rely on this shape. A field rename
// (e.g. encName → name_enc) would silently break both — the
// browser side gets undefined and falls back to "untitled", the
// hash check returns the same constant for every poll.
//
// What this test asserts:
//   1. Upload a tiny encrypted file via lib/v2-upload's uploadV2.
//   2. GET /api/v2/file/<fileId>. Status 200, JSON content-type.
//   3. Body has exactly {ciphertext, encName, size, updatedAt} —
//      no extras, no missing.
//   4. Each field has the documented type.
//   5. size matches the plaintext byte count we uploaded.
//
// Cleanup: leaves the uploaded blob behind. v2 storage is content-
// addressed by fileId derived from a per-test random secret, so
// each run lands at a unique fileId; old blobs accumulate but
// don't conflict.
//
// Runtime: <2s. Single upload + GET + JSON parse.

'use strict';

const env = require('../../lib/test-env');
const __cl = require('../../lib/inject-checklist');
const { uploadV2 } = require('../../lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;

const EXPECTED_KEYS = ['ciphertext', 'encName', 'size', 'updatedAt'];

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
    console.log('=== Regression: /api/v2/file/:fileId response shape ===');
    const t0 = Date.now();

    // Tiny plaintext — content doesn't matter for shape testing.
    const plaintext = Buffer.from('regression-v2-file-api-shape ' + Date.now(), 'utf8');
    const NAME = `regression-v2-shape-${Date.now()}.txt`;

    let up;
    try {
        up = await uploadV2(VIEWER, NAME, plaintext);
    } catch (e) {
        check('v2 upload succeeds', false, e.message);
        process.exit(1);
    }
    check('v2 upload succeeds', true,
          `fileId=${up.fileId.substring(0, 12)}…`);

    let resp, body;
    try {
        resp = await fetch(VIEWER + '/api/v2/file/' + up.fileId);
    } catch (e) {
        check('GET /api/v2/file/<fileId> reachable', false, e.message);
        process.exit(1);
    }
    check('GET /api/v2/file/<fileId> 200', resp.status === 200,
          `HTTP ${resp.status}`);
    if (resp.status !== 200) process.exit(1);

    const contentType = resp.headers.get('content-type') || '';
    check('Content-Type: application/json',
          contentType.includes('application/json'),
          contentType);

    try {
        body = await resp.json();
    } catch (e) {
        check('body parses as JSON', false, e.message);
        process.exit(1);
    }
    check('body parses as JSON', true, `keys=${Object.keys(body).join(',')}`);

    const got = new Set(Object.keys(body));
    const missing = EXPECTED_KEYS.filter(k => !got.has(k));
    const extra = [...got].filter(k => !EXPECTED_KEYS.includes(k));
    check(`all ${EXPECTED_KEYS.length} expected keys present`,
          missing.length === 0,
          missing.length ? 'missing: ' + missing.join(',') : 'ok');
    check('no extra keys',
          extra.length === 0,
          extra.length ? 'extra: ' + extra.join(',') : 'ok');

    // Type checks.
    check('ciphertext is a string',
          typeof body.ciphertext === 'string' && body.ciphertext.length > 0,
          typeof body.ciphertext + ' len=' + (body.ciphertext || '').length);
    check('encName is a string',
          typeof body.encName === 'string' && body.encName.length > 0,
          typeof body.encName);
    check('size is a number',
          typeof body.size === 'number',
          typeof body.size + '=' + body.size);
    check('updatedAt is an ISO 8601 string',
          typeof body.updatedAt === 'string'
          && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(body.updatedAt),
          typeof body.updatedAt + '=' + body.updatedAt);

    // The ciphertext base64 string decodes to size bytes — that's
    // the server's "fast pre-hash check". AES-GCM ciphertext is
    // plaintext + 12-byte IV + 16-byte authTag = plaintext + 28.
    const cipherBytes = Buffer.from(body.ciphertext, 'base64').length;
    check(`size === ciphertext bytes (${cipherBytes})`,
          body.size === cipherBytes,
          `size=${body.size} ciphertext-decoded=${cipherBytes}`);
    // Sanity: cipherBytes - 28 == plaintext.length
    check(`ciphertext bytes - 28 (IV + tag) === plaintext bytes (${plaintext.length})`,
          cipherBytes - 28 === plaintext.length,
          `cipher=${cipherBytes} plaintext=${plaintext.length} diff=${cipherBytes - plaintext.length}`);

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e);
    process.exit(2);
});
