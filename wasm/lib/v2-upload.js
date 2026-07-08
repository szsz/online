// lib/v2-upload.js — Node-side helper that mirrors what the browser
// viewer does when it uploads a file: generate a 128-bit secret,
// derive content + name keys via HKDF-SHA256, encrypt the doc and
// filename with AES-256-GCM, PUT to /api/v2/file/<fileId>, and return
// { secret, fileId } so the test can open /#file=<secret> in the
// viewer.
//
// Every test that used to `POST /api/files/<name>` should call this
// instead. The returned secret is the only way to open the file; tests
// navigate to `${VIEWER}/#file=${secret}` and the viewer's own
// openFileBySecret() decrypts and hands plaintext to the editor iframe.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { URL } = require('url');

function hkdf(ikm, info, bytes) {
    return new Promise((resolve, reject) => {
        crypto.hkdf('sha256', ikm, Buffer.alloc(0), info, bytes,
            (err, d) => err ? reject(err) : resolve(Buffer.from(d)));
    });
}

async function deriveKeys(secret) {
    const [contentKey, nameKey, fileIdRaw] = await Promise.all([
        hkdf(secret, Buffer.from('content'),  32),
        hkdf(secret, Buffer.from('filename'), 32),
        hkdf(secret, Buffer.from('file-id'),  32),
    ]);
    return {
        contentKey, nameKey,
        fileId: Buffer.from(fileIdRaw).toString('hex'),
    };
}

function encryptAesGcm(key, plaintext) {
    const iv = crypto.randomBytes(12);
    const c  = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(plaintext), c.final()]);
    return Buffer.concat([iv, ct, c.getAuthTag()]);
}

function b64urlEncode(bytes) {
    return Buffer.from(bytes).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function put(url, body, headers) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname, method: 'PUT',
            headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
            rejectUnauthorized: false,
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

/**
 * Upload an encrypted file to the viewer via /api/v2/file/:fileId.
 *
 * @param {string} viewerUrl  e.g. 'https://viewer.atgpartners.info'
 * @param {string} name       plaintext filename (e.g. 'test.docx') —
 *                            never sent to server; encrypted under nameKey
 * @param {Buffer} bytes      file content bytes
 * @returns {Promise<{secret: string, fileId: string, b64urlSecret: string}>}
 */
async function uploadV2(viewerUrl, name, bytes) {
    const secret = crypto.randomBytes(16);
    const { contentKey, nameKey, fileId } = await deriveKeys(secret);
    const ciphertext = encryptAesGcm(contentKey, bytes);
    const encName    = encryptAesGcm(nameKey, Buffer.from(name, 'utf8'));
    const body = JSON.stringify({
        ciphertext: ciphertext.toString('base64'),
        encName:    encName.toString('base64'),
    });
    const url = viewerUrl.replace(/\/$/, '') + '/api/v2/file/' + fileId;
    const resp = await put(url, body);
    if (resp.status !== 200) {
        throw new Error(`v2 upload failed: ${resp.status} ${resp.body.substring(0, 200)}`);
    }
    return {
        secret,                              // raw 16 bytes
        fileId,                              // 64-hex blob key
        b64urlSecret: b64urlEncode(secret),  // for the URL fragment
    };
}

/**
 * Convenience: upload a file from disk.
 */
async function uploadV2FromPath(viewerUrl, name, path) {
    return uploadV2(viewerUrl, name, fs.readFileSync(path));
}

function getReq(url) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname,
            method: 'GET',
            rejectUnauthorized: false,
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks),
            }));
        });
        req.on('error', reject);
        req.end();
    });
}

function decryptAesGcm(key, blob) {
    const iv  = blob.slice(0, 12);
    const tag = blob.slice(blob.length - 16);
    const ct  = blob.slice(12, blob.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
}

/**
 * Download the most-recent v2 file for `secret` and decrypt it. The
 * viewer's GET /api/v2/file/<fileId> returns the same JSON shape it
 * accepts on upload — { ciphertext, encName, size, updatedAt }; this
 * helper decrypts both halves and returns plaintext.
 *
 * @param {string} viewerUrl
 * @param {Buffer} secret  16-byte secret returned by uploadV2
 * @returns {Promise<{bytes: Buffer, name: string, updatedAt: string, size: number, fileId: string}>}
 */
async function downloadV2(viewerUrl, secret) {
    const { contentKey, nameKey, fileId } = await deriveKeys(secret);
    const url = viewerUrl.replace(/\/$/, '') + '/api/v2/file/' + fileId;
    const resp = await getReq(url);
    if (resp.status !== 200) {
        throw new Error(`v2 download failed: ${resp.status} ${resp.body.toString().substring(0, 200)}`);
    }
    const j = JSON.parse(resp.body.toString());
    const ct      = Buffer.from(j.ciphertext, 'base64');
    const encName = Buffer.from(j.encName, 'base64');
    return {
        bytes: decryptAesGcm(contentKey, ct),
        name:  decryptAesGcm(nameKey, encName).toString('utf8'),
        updatedAt: j.updatedAt,
        size: j.size,
        fileId,
    };
}

module.exports = { uploadV2, uploadV2FromPath, downloadV2, deriveKeys };
