// relay-crypto.js: End-to-end encryption for relay messages.
// Key is derived from the URL fragment (#...) using HMAC-SHA256 + AES-256-GCM.
// The relay server only sees ciphertext.

(function() {
    'use strict';

    var RelayCrypto = {
        _key: null,
        _enabled: false,
        _ready: null,

        init: function() {
            if (this._ready) return this._ready;
            var self = this;
            var fragment = window.location.hash.substring(1);
            if (!fragment) {
                console.log('RelayCrypto: no URL fragment, encryption disabled');
                this._ready = Promise.resolve();
                return this._ready;
            }
            this._ready = (async function() {
                self._key = await hmacDeriveAesKey(fragment, 'cool-relay');
                self._enabled = true;
                console.log('RelayCrypto: encryption enabled (key derived from URL fragment)');
            })();
            return this._ready;
        },

        isEnabled: function() { return this._enabled; },

        // Encrypt data. Returns ArrayBuffer if enabled, original data if not.
        // Format: [12-byte IV][AES-GCM ciphertext of [1-byte type][payload]]
        // Type byte: 0x54 ('T') = text, 0x42 ('B') = binary
        encrypt: async function(data) {
            if (this._ready) await this._ready;
            if (!this._enabled) return data;

            var typeByte, payload;
            if (typeof data === 'string') {
                typeByte = 0x54; // 'T'
                payload = new TextEncoder().encode(data);
            } else {
                typeByte = 0x42; // 'B'
                payload = new Uint8Array(data);
            }

            var plaintext = new Uint8Array(1 + payload.length);
            plaintext[0] = typeByte;
            plaintext.set(payload, 1);

            var iv = crypto.getRandomValues(new Uint8Array(12));
            var ciphertext = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: iv }, this._key, plaintext
            );

            var result = new Uint8Array(12 + ciphertext.byteLength);
            result.set(iv, 0);
            result.set(new Uint8Array(ciphertext), 12);
            return result.buffer;
        },

        // Decrypt data. Returns string or Uint8Array based on original type.
        decrypt: async function(data) {
            if (this._ready) await this._ready;
            if (!this._enabled) return data;

            var buf;
            if (data instanceof ArrayBuffer) {
                buf = new Uint8Array(data);
            } else if (data instanceof Uint8Array) {
                buf = data;
            } else {
                return data; // not binary, pass through
            }

            if (buf.length < 13) return data;

            var iv = buf.slice(0, 12);
            var ciphertext = buf.slice(12);

            try {
                var plaintext = new Uint8Array(await crypto.subtle.decrypt(
                    { name: 'AES-GCM', iv: iv }, this._key, ciphertext
                ));
                var typeByte = plaintext[0];
                var payload = plaintext.slice(1);
                if (typeByte === 0x54) { // 'T' = text
                    return new TextDecoder().decode(payload);
                }
                return payload; // binary
            } catch (e) {
                console.warn('RelayCrypto: decrypt failed:', e.message);
                return data;
            }
        }
    };

    // HMAC-SHA256(key=secret, message=salt) → AES-256-GCM CryptoKey
    async function hmacDeriveAesKey(secret, salt) {
        var enc = new TextEncoder();
        var hmacKey = await crypto.subtle.importKey(
            'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
        );
        var derived = await crypto.subtle.sign('HMAC', hmacKey, enc.encode(salt));
        return crypto.subtle.importKey(
            'raw', derived, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
        );
    }

    globalThis.RelayCrypto = RelayCrypto;
})();
