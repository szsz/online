// file-crypto.js — per-file client-side encryption primitives.
//
// A 128-bit secret (stored in the URL fragment `#file=<b64url-secret>`)
// derives three keys via HKDF-SHA256:
//   contentKey — AES-256-GCM for the doc bytes
//   nameKey    — AES-256-GCM for the plaintext filename
//   fileId     — 64-hex-char stable blob key (no content required)
//
// The server sees only ciphertext + opaque fileIds. Keys live in the
// viewer's top window + localStorage — never in the editor iframe.

(function (global) {
    'use strict';

    const te = new TextEncoder();
    const td = new TextDecoder();

    function buf2hex(buf) {
        const b = new Uint8Array(buf);
        let s = '';
        for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
        return s;
    }

    function b64urlEncode(bytes) {
        const bin = String.fromCharCode.apply(null, bytes);
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    function b64urlDecode(str) {
        const s = str.replace(/-/g, '+').replace(/_/g, '/');
        const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
        const bin = atob(s + pad);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function generateSecret() {
        return crypto.getRandomValues(new Uint8Array(16));  // 128 bits
    }

    async function deriveKeys(secretBytes) {
        const ikm = await crypto.subtle.importKey(
            'raw', secretBytes, 'HKDF', false, ['deriveBits']);
        async function derive(info, bits) {
            return crypto.subtle.deriveBits({
                name: 'HKDF',
                hash: 'SHA-256',
                salt: new Uint8Array(),
                info: te.encode(info),
            }, ikm, bits);
        }
        const [contentRaw, nameRaw, fileIdRaw] = await Promise.all([
            derive('content',  256),
            derive('filename', 256),
            derive('file-id',  256),
        ]);
        const [contentKey, nameKey] = await Promise.all([
            crypto.subtle.importKey('raw', contentRaw, 'AES-GCM', false, ['encrypt', 'decrypt']),
            crypto.subtle.importKey('raw', nameRaw,    'AES-GCM', false, ['encrypt', 'decrypt']),
        ]);
        return { contentKey, nameKey, fileId: buf2hex(fileIdRaw) };
    }

    // Encrypt: output = iv(12) || ciphertext+tag(N+16)
    async function encryptBytes(key, plaintext) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
        const out = new Uint8Array(12 + ct.byteLength);
        out.set(iv, 0);
        out.set(new Uint8Array(ct), 12);
        return out;
    }

    async function decryptBytes(key, blob) {
        const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
        if (u8.length < 12 + 16) throw new Error('ciphertext too short');
        const iv = u8.subarray(0, 12);
        const ct = u8.subarray(12);
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
        return new Uint8Array(pt);
    }

    async function encryptName(key, name) {
        return encryptBytes(key, te.encode(name));
    }
    async function decryptName(key, bytes) {
        return td.decode(await decryptBytes(key, bytes));
    }

    global.FileCrypto = {
        generateSecret,
        deriveKeys,
        encryptBytes, decryptBytes,
        encryptName,  decryptName,
        b64urlEncode, b64urlDecode,
        buf2hex,
    };
})(typeof window !== 'undefined' ? window : globalThis);
