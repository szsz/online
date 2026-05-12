// sw-bridge.js — editor-origin Service Worker that intercepts file
// fetches Kit makes and routes them to the viewer (parent window) via
// postMessage, instead of going to the network.
//
// Why this exists:
//   The editor is a fully-static site behind Front Door. Kit (LO core
//   in WASM) needs to load the user's document via an HTTP GET to
//   /wasm/<fileId>. Pre-migration, that endpoint lived on a Node
//   server (editor-server.js); post-migration, no editor-origin HTTP
//   handler exists. So we trap Kit's fetches here in the SW and ask
//   the viewer (which holds the plaintext bytes in memory after
//   decrypting) to provide them via postMessage.
//
// Scope: this file MUST be served from the editor origin's ROOT path
// (/sw-bridge.js) so its default scope is `/` and covers every URL
// path Kit might fetch, including /wasm/<id> and the late-join
// /api/blobs/<hash> + /api/v2/file/<id> + /api/files/<name>.
//
// Coexists with the per-deploy asset SW at /<APP_BUILD_ID>/sw.js
// (scope /<APP_BUILD_ID>/browser/), which handles online.wasm /
// soffice.data caching. Different scopes → no conflict; each
// fetch hits the SW with the most-specific scope first.
//
// Protocol with the iframe page (relay-adapter.js / wasm-loader.js
// host the bridge JS that talks to window.parent):
//   SW → page  postMessage {type:'sw-bridge-request', id, url, method, body}
//   page → SW  postMessage {type:'sw-bridge-response', id, status, headers, body}
// The page is responsible for relaying to/from window.parent (viewer).

'use strict';

// Paths the SW bridges to the parent. Any same-origin request whose
// pathname starts with one of these prefixes goes through the bridge;
// everything else passes through to network unchanged.
//
// /wasm/        the per-file plaintext blackboard during edit session
// /api/blobs/   content-addressable blobs used by the relay checkpoint
// /api/v2/file/ encrypted at-rest storage (parent decrypts before reply)
// /api/files/   legacy v1 storage path (still in test fixtures)
const BRIDGE_PREFIXES = ['/wasm/', '/api/blobs/', '/api/v2/file/', '/api/files/'];

self.addEventListener('install', () => {
    // Take over immediately on first install so the FIRST tab can use
    // the bridge without a reload. We pair this with clients.claim() in
    // activate so existing controlled clients also pick up the new SW.
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    let url;
    try { url = new URL(req.url); } catch (_) { return; }
    if (url.origin !== self.location.origin) return;       // cross-origin → passthrough
    if (!BRIDGE_PREFIXES.some(p => url.pathname.startsWith(p))) return;
    event.respondWith(bridge(req));
});

// Pending requests, keyed by uuid — promise resolved when the page
// posts back the matching sw-bridge-response.
const _pending = new Map();

self.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'sw-bridge-response') return;
    const pending = _pending.get(msg.id);
    if (!pending) return;
    _pending.delete(msg.id);
    pending.resolve(msg);
});

async function bridge(req) {
    const id = (self.crypto && self.crypto.randomUUID)
        ? self.crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36);

    // Snapshot the body so we can transfer it. The request body is a
    // ReadableStream and can only be read once; we materialize to an
    // ArrayBuffer for the postMessage hop. Empty for GET/HEAD.
    // Also keep the raw body for the network-fallback path below so
    // we don't double-consume the request stream.
    let body = null;
    if (req.method === 'POST' || req.method === 'PUT') {
        body = await req.arrayBuffer();
    }

    // Pick a controlled client (the iframe page) to send the request to.
    // matchAll with {type:'window'} returns top-level + iframe windows in
    // our scope. If no client is controlled — e.g. a standalone cool.html
    // visit with no viewer parent (legacy / debug usage), or before the
    // page's bridge relay has activated — fall through to the network so
    // tests and ad-hoc opens that pre-stage at /wasm/<id> on the editor
    // server keep working. The viewer-mediated path is the production
    // contract; this is the safety valve.
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: false });
    if (!clients.length) {
        return networkFallback(req, body);
    }

    const replyP = new Promise((resolve, reject) => {
        _pending.set(id, { resolve, reject });
        // Safety timeout: 15s. Short enough that a misbehaving parent
        // doesn't hang Kit indefinitely; long enough to absorb a slow
        // parent decryption + reply.
        setTimeout(() => {
            if (_pending.has(id)) {
                _pending.delete(id);
                reject(new Error('sw-bridge: parent reply timeout'));
            }
        }, 15000);
    });

    const transfer = body ? [body] : [];
    clients[0].postMessage({
        type: 'sw-bridge-request',
        id,
        url: req.url,
        method: req.method,
        body,
    }, transfer);

    let reply;
    try { reply = await replyP; }
    catch (e) {
        // Parent didn't reply in time — try the network as last resort.
        return networkFallback(req, body);
    }

    // Sentinel: status === 0 means "no bridge available, fall through".
    // The iframe page emits this when it has no viewer parent (e.g.
    // standalone cool.html visit) so the SW doesn't burn its 15s
    // timeout when we already know nobody can answer.
    if (reply.status === 0) {
        return networkFallback(req, body);
    }

    const headers = new Headers(reply.headers || {});
    return new Response(reply.body || null, {
        status: reply.status || 200,
        headers,
    });
}

// Build a network request equivalent to `req` (the original event.request
// was already consumed for its body). Used as the fallback when no
// controlled client can answer the bridge.
function networkFallback(req, body) {
    const init = {
        method: req.method,
        headers: req.headers,
        // Body must be set only on methods that allow it.
        body: (req.method === 'POST' || req.method === 'PUT') ? body : null,
        credentials: req.credentials,
        mode: req.mode === 'navigate' ? 'cors' : req.mode,
        redirect: req.redirect,
    };
    // Some properties (mode, credentials) error if their value is the
    // SW-default "navigate"/"only-if-cached" combo for sub-requests.
    try { return fetch(req.url, init); }
    catch (_) { return fetch(req.url); }
}
