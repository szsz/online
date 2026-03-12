// Service Worker: transparent E2E file encryption for /wasm/* requests.
// Encrypts POST bodies before they reach the server, decrypts GET responses
// before they reach emscripten_fetch. The server only sees ciphertext.
//
// Key is sent from the page via postMessage({ type: 'setKey', key: '...' }).
// Derived via HMAC-SHA256(key, salt="cool-file") → AES-256-GCM.

let encryptionKey = null;
let keyReady = null;
let keyResolve = null;

function resetKeyPromise() {
    keyReady = new Promise(function(resolve) { keyResolve = resolve; });
}
resetKeyPromise();

self.addEventListener('install', function() {
    self.skipWaiting();
});

self.addEventListener('activate', function(event) {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'setKey') {
        hmacDeriveAesKey(event.data.key, 'cool-file').then(function(key) {
            encryptionKey = key;
            console.log('CryptoSW: file encryption key derived');
            if (keyResolve) keyResolve();
        });
    }
});

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

async function encryptData(plaintext) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, encryptionKey, plaintext);
    var result = new Uint8Array(12 + ciphertext.byteLength);
    result.set(iv);
    result.set(new Uint8Array(ciphertext), 12);
    return result.buffer;
}

async function decryptData(data) {
    var buf = new Uint8Array(data);
    var iv = buf.slice(0, 12);
    var ciphertext = buf.slice(12);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, encryptionKey, ciphertext);
}

self.addEventListener('fetch', function(event) {
    var url = new URL(event.request.url);

    // Only intercept /wasm/<hash> document requests (not /wasm/meta/*)
    if (!url.pathname.startsWith('/wasm/') || url.pathname.startsWith('/wasm/meta/')) {
        return;
    }

    // HEAD — pass through (existence check only)
    if (event.request.method === 'HEAD') {
        return;
    }

    // GET — fetch encrypted blob from server, decrypt, return plaintext
    if (event.request.method === 'GET') {
        event.respondWith(keyReady.then(function() {
            return fetch(event.request);
        }).then(function(response) {
            if (!response.ok) return response;
            return response.arrayBuffer().then(function(encrypted) {
                return decryptData(encrypted);
            }).then(function(plaintext) {
                return new Response(plaintext, {
                    status: 200,
                    headers: { 'Content-Type': 'application/octet-stream' }
                });
            });
        }).catch(function(err) {
            console.error('CryptoSW: GET decrypt failed', err);
            return new Response('Decryption failed', { status: 500 });
        }));
        return;
    }

    // POST — encrypt plaintext body, forward to server
    if (event.request.method === 'POST') {
        event.respondWith(keyReady.then(function() {
            return event.request.arrayBuffer();
        }).then(function(plaintext) {
            return encryptData(plaintext);
        }).then(function(encrypted) {
            return fetch(event.request.url, {
                method: 'POST',
                body: encrypted
            });
        }).catch(function(err) {
            console.error('CryptoSW: POST encrypt failed', err);
            return new Response('Encryption failed', { status: 500 });
        }));
        return;
    }
});
