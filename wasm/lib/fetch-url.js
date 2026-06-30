// fetch-url.js — protocol-aware HTTP/HTTPS fetch helper for tests.
//
// Phase 1 (CI) spawns local servers on plain HTTP free ports;
// production / Azure Phase 2 hits HTTPS. Tests that hardcoded
// require('https').get() against ${EDITOR_URL}/... blew up when
// EDITOR_URL became http://127.0.0.1:<port>:
//
//   ERR_INVALID_PROTOCOL: Protocol "http:" not supported.
//   EPROTO ... packet length too long  (TLS handshake against plain HTTP)
//
// This helper picks the right module per call so the same test code
// works under both transports without `if (url.startsWith('https'))`
// scattered across the suite.

const http  = require('http');
const https = require('https');

function pickLib(url) {
    return url.startsWith('https:') ? https : http;
}

function fetchUrl(url, headers) {
    const opts = headers ? { headers } : undefined;
    return new Promise((resolve, reject) => {
        const req = pickLib(url).get(url, opts || {}, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end',  ()  => resolve({
                status:  res.statusCode,
                headers: res.headers,
                body,
            }));
        });
        req.on('error', reject);
    });
}

function headUrl(url, headers) {
    return new Promise((resolve, reject) => {
        const opts = { method: 'HEAD' };
        if (headers) opts.headers = headers;
        const req = pickLib(url).request(url, opts, (res) => {
            res.on('data', () => {});
            res.on('end',  ()  => resolve({
                status:  res.statusCode,
                headers: res.headers,
            }));
        });
        req.on('error', reject);
        req.end();
    });
}

module.exports = { fetchUrl, headUrl, pickLib };
