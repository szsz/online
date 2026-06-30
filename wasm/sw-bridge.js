// sw-bridge.js — editor-origin Service Worker. Does TWO things:
//
//   1. **postMessage bridge** for the dynamic-file paths Kit fetches
//      that the FD static site can't serve (/wasm/<id>, /api/blobs/,
//      /api/v2/file/, /api/files/, /api/keys/). Routes them to
//      window.parent (the viewer) via postMessage; the viewer
//      responds with bytes from its in-memory cache or by proxying
//      same-origin to its own dynamic endpoints.
//
//   2. **Cache Storage for heavy assets** (online.wasm, soffice.data,
//      bundle.js, etc.). Independent of the HTTP cache so a busy
//      browser eviction doesn't trigger a 280 MB re-download on
//      every revisit.
//
// Scope = `/` (the file is served from /sw-bridge.js on the editor
// origin). EVERY in-scope request hits this SW's fetch handler:
//   - BRIDGE_PREFIXES → bridge to parent
//   - HEAVY_PATTERNS  → cache-first
//   - anything else   → passthrough (return; default browser fetch)
//
// Why ONE SW instead of two: when both a /sw-bridge.js (scope /) and
// a /<id>/browser/dist/sw.js (scope /<id>/browser/dist/) were
// registered, the most-specific scope wins and only one of them
// becomes the page's controller. Fetches went to whichever scope
// was deeper, and the broader one never fired. Folding both jobs
// into one SW at scope / makes that impossible.
//
// Protocol with the iframe page (wasm-loader.js relays SW ↔ parent):
//   SW → page  postMessage {type:'sw-bridge-request', id, url, method, body}
//   page → SW  postMessage {type:'sw-bridge-response', id, status, headers, body}

'use strict';

const BUILD_FINGERPRINT = '__WASM_BUILD_FINGERPRINT__';
const CACHE_NAME = (BUILD_FINGERPRINT === '__WASM_BUILD' + '_FINGERPRINT__')
    ? 'cool-editor-dev'
    : 'cool-editor-' + BUILD_FINGERPRINT;

// Bridged paths — routed through the iframe page to window.parent.
//
// /wasm/        the per-file plaintext blackboard during edit session
// /api/blobs/   content-addressable blobs used by the relay checkpoint
// /api/v2/file/ encrypted at-rest storage (parent decrypts before reply)
// /api/files/   legacy v1 storage path (still in test fixtures)
// /api/keys/    encryption-key endpoint relay-adapter probes at start-up
const BRIDGE_PREFIXES = ['/wasm/', '/api/blobs/', '/api/v2/file/', '/api/files/', '/api/keys/'];

// Heavy assets — cache-first to survive HTTP-cache eviction. Matches
// both the unhashed canonical names (post-Phase-3 strip) and the
// legacy hashed siblings that some older clients might still request.
const HEAVY_PATTERNS = [
    /\/online(\.[a-f0-9]+)?\.wasm(\?|$)/,
    /\/online(\.[a-f0-9]+)?\.js(\?|$)/,
    /\/online\.worker\.js(\?|$)/,
    /\/soffice(\.[a-f0-9]+)?\.data(\?|$)/,
    /\/soffice\.data\.js(\.[a-f0-9]+)?\.metadata(\?|$)/,
    /\/bundle(\.[a-f0-9]+)?\.js(\?|$)/,
    /\/bundle(\.[a-f0-9]+)?\.css(\?|$)/,
    /\/global(\.[a-f0-9]+)?\.js(\?|$)/,
];

function isHeavy(url) {
    return HEAVY_PATTERNS.some(re => re.test(url));
}

self.addEventListener('install', () => {
    // Take over immediately on first install so the FIRST tab can use
    // the bridge without a reload. We pair this with clients.claim() in
    // activate so existing controlled clients also pick up the new SW.
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        // Claim clients FIRST so newly-arriving fetches go through us.
        // Then GC old build caches in the background — fingerprint-suffixed
        // CACHE_NAMEs make every fresh deploy land in its own namespace,
        // so deleting any cache whose name isn't ours is safe.
        const claimP = self.clients.claim();
        const gcP = caches.keys().then((names) =>
            Promise.all(names.filter(n => n !== CACHE_NAME)
                             .map(n => caches.delete(n))));
        await Promise.all([claimP, gcP]);
    })());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    let url;
    try { url = new URL(req.url); } catch (_) { return; }
    if (url.origin !== self.location.origin) return;       // cross-origin → passthrough

    if (BRIDGE_PREFIXES.some(p => url.pathname.startsWith(p))) {
        event.respondWith(bridge(req));
        return;
    }
    if (req.method === 'GET' && isHeavy(req.url)) {
        event.respondWith(heavyCacheFirst(req));
        return;
    }
    // Everything else: default browser fetch.
});

async function heavyCacheFirst(req) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req.url);
    if (cached) return cached;
    const fresh = await fetch(req);
    if (fresh.ok && fresh.status === 200) {
        try { await cache.put(req.url, fresh.clone()); }
        catch (e) { /* quota exceeded, keep going */ }
    }
    return fresh;
}

// Pending requests, keyed by uuid — promise resolved when the page
// posts back the matching sw-bridge-response.
const _pending = new Map();

self.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) return;

    // Page replying to a SW bridge-request (the bridge() function's
    // pending promise resolves here).
    if (msg.type === 'sw-bridge-response') {
        const pending = _pending.get(msg.id);
        if (!pending) return;
        _pending.delete(msg.id);
        pending.resolve(msg);
        return;
    }

    // Page asking us to precache a list of heavy asset URLs. Fired by
    // wasm-loader.js after prewarm-ready (line ~2087). Pre-fix
    // (2026-06-01), only sw.js (an orphaned, never-registered SW file)
    // had this handler — so the postMessage hit sw-bridge.js, was
    // silently dropped, and SW Cache Storage was never warmed before
    // Session 2 of test-regression-wasm-cache-pressure. Result: 52 MB
    // re-download on second visit, test failed 5/5.
    //
    // sw-bridge.js already has CACHE_NAME + heavyCacheFirst above, so
    // adding this is a no-op for any URL whose fetch handler already
    // populated the cache. The signal back to the page is what makes
    // the test gate work — `precache:done` triggers
    // `window.__swPrecacheDone` in wasm-loader.js:234.
    if (msg.type === 'precache') {
        const urls = Array.isArray(msg.urls) ? msg.urls : [];
        event.waitUntil((async () => {
            const cache = await caches.open(CACHE_NAME);
            let cached = 0, fetched = 0, failed = 0;
            await Promise.all(urls.map(async (url) => {
                try {
                    if (await cache.match(url)) { cached++; return; }
                    const r = await fetch(url, { credentials: 'same-origin' });
                    if (r.ok && r.status === 200) {
                        await cache.put(url, r);
                        fetched++;
                    } else {
                        failed++;
                    }
                } catch (_) { failed++; }
            }));
            const all = await self.clients.matchAll({ includeUncontrolled: true });
            for (const c of all) {
                try { c.postMessage({ type: 'precache:done',
                    urls: urls.length, cached, fetched, failed }); }
                catch (_) {}
            }
        })());
        return;
    }
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
