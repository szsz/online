const __cl = require('./lib/inject-checklist');
// Regression test: the viewer's document endpoints must serve cache headers
// + honour conditional GET, so that opening the same document twice doesn't
// re-fetch the bytes from the storage backend.
//
// Endpoints under test (viewer.szebeni.hu):
//   /api/files/<name>  — Cache-Control: no-cache, ETag + Last-Modified,
//                        304 on If-None-Match / If-Modified-Since match.
//   /blank.docx        — Cache-Control: public, max-age=3600 (it's a
//                        prewarm fixture), ETag + Last-Modified, 304 on match.
//
// The user-visible bug this guards against: clicking a doc in the sidebar
// re-streams its bytes from the storage backend (Azure Blob round-trip)
// every single time, even when the doc hasn't changed.
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');
const { pickLib } = require('./lib/fetch-url');

const VIEWER = env.FILE_STORAGE_URL;
const PROBE_NAME = 'viewer-cache-probe-' + Date.now() + '.bin';

const T0 = Date.now();
function log(m) { console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`); }

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}${ev?' ['+ev+']':''}`); allPassed = false; }
}

function request(method, urlStr, headers) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const lib = pickLib(urlStr);
        const req = lib.request({
            method, hostname: u.hostname, port: u.port,
            path: u.pathname + (u.search || ''),
            headers: headers || {},
            rejectUnauthorized: false,
        }, (res) => {
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => resolve({
                status: res.statusCode, headers: res.headers,
                body: Buffer.concat(chunks),
            }));
        });
        req.on('error', reject);
        req.end();
    });
}

function uploadProbe() {
    return new Promise((resolve, reject) => {
        const url = VIEWER + '/api/files/' + encodeURIComponent(PROBE_NAME);
        const u = new URL(url);
        const lib = pickLib(url);
        // 64 KiB random payload.
        const body = Buffer.alloc(64 * 1024);
        for (let i = 0; i < body.length; i++) body[i] = Math.floor(Math.random() * 256);
        const req = lib.request({
            method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname,
            headers: { 'Content-Type': 'application/octet-stream',
                       'Content-Length': body.length },
            rejectUnauthorized: false,
        }, (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve({ status: res.statusCode, sentBytes: body.length }));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

(async () => {
    log('=== Regression: viewer document caching ===');

    // Upload a fresh probe doc so we have something with known content.
    const up = await uploadProbe();
    log(`Uploaded ${PROBE_NAME} (${up.sentBytes}B, status=${up.status})`);
    check('Probe upload OK', up.status === 200);

    // ── /api/files/<doc> ────────────────────────────────────────
    log('\n--- /api/files/<doc> ---');
    const r1 = await request('GET', VIEWER + '/api/files/' + encodeURIComponent(PROBE_NAME));
    log(`  Initial GET: status=${r1.status}, body=${r1.body.length}B, ` +
        `ETag=${r1.headers.etag}, Cache-Control=${r1.headers['cache-control']}, ` +
        `Last-Modified=${r1.headers['last-modified']}`);
    check('Initial GET returns 200', r1.status === 200);
    check('Body has the uploaded bytes', r1.body.length === up.sentBytes);
    check('ETag header present', !!r1.headers.etag);
    check('Last-Modified header present', !!r1.headers['last-modified']);
    check('Cache-Control: no-cache (must revalidate)',
          r1.headers['cache-control'] === 'no-cache',
          r1.headers['cache-control']);

    if (r1.headers.etag) {
        const r2 = await request('GET', VIEWER + '/api/files/' + encodeURIComponent(PROBE_NAME),
            { 'If-None-Match': r1.headers.etag });
        log(`  Conditional (If-None-Match): status=${r2.status}, body=${r2.body.length}B`);
        check('If-None-Match → 304', r2.status === 304);
        check('304 response has empty body', r2.body.length === 0);
    }
    if (r1.headers['last-modified']) {
        const r3 = await request('GET', VIEWER + '/api/files/' + encodeURIComponent(PROBE_NAME),
            { 'If-Modified-Since': r1.headers['last-modified'] });
        log(`  Conditional (If-Modified-Since): status=${r3.status}, body=${r3.body.length}B`);
        check('If-Modified-Since → 304', r3.status === 304);
    }

    // Modifying the doc must invalidate the ETag — re-upload, then a
    // conditional GET with the OLD ETag must return 200 (fresh bytes).
    log('\n--- ETag invalidates on overwrite ---');
    await new Promise(r => setTimeout(r, 1100));   // ensure mtime changes
    const oldEtag = r1.headers.etag;
    await uploadProbe();
    const r4 = await request('GET', VIEWER + '/api/files/' + encodeURIComponent(PROBE_NAME),
        { 'If-None-Match': oldEtag });
    log(`  Conditional GET with stale ETag: status=${r4.status}, body=${r4.body.length}B, newETag=${r4.headers.etag}`);
    check('Stale ETag → 200 with fresh body (no false 304)',
          r4.status === 200 && r4.body.length > 0);
    check('New ETag differs from old', r4.headers.etag && r4.headers.etag !== oldEtag,
          'old=' + oldEtag + ' new=' + r4.headers.etag);

    // ── /blank.docx ────────────────────────────────────────────
    log('\n--- /blank.docx ---');
    const b1 = await request('GET', VIEWER + '/blank.docx');
    log(`  Initial GET: status=${b1.status}, body=${b1.body.length}B, ` +
        `ETag=${b1.headers.etag}, Cache-Control=${b1.headers['cache-control']}`);
    check('blank.docx GET returns 200', b1.status === 200);
    check('blank.docx ETag present', !!b1.headers.etag);
    check('blank.docx Cache-Control allows caching',
          /max-age=\d+/.test(b1.headers['cache-control'] || ''),
          b1.headers['cache-control']);

    if (b1.headers.etag) {
        const b2 = await request('GET', VIEWER + '/blank.docx',
            { 'If-None-Match': b1.headers.etag });
        log(`  Conditional (If-None-Match): status=${b2.status}, body=${b2.body.length}B`);
        check('blank.docx If-None-Match → 304', b2.status === 304);
        check('blank.docx 304 body is empty', b2.body.length === 0);
    }

    log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
