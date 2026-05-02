// Service Worker — caches the editor's heavy WASM assets in Cache Storage,
// independent of Chrome's HTTP disk cache.
//
// Why this exists: the response headers for online.wasm + soffice.data
// already say `Cache-Control: public, max-age=31536000, immutable`, but
// Chrome's disk cache is a single LRU pool shared with every other site
// the user visits and has both a per-origin quota AND a per-entry size
// limit. Real users (especially with limited disk or many open tabs)
// routinely have one of our 60+ MB assets evicted between visits, which
// triggers a fresh 60+ MB download on every return.
//
// Cache Storage has its own per-origin quota (typically much larger than
// HTTP cache; see https://web.dev/storage-for-the-web/) AND entries
// placed there persist until we delete them or the user clears site
// data. By moving the heavy assets here we make the cache deterministic.
//
// This SW intercepts ONLY the heavy assets — everything else goes
// through the normal browser pipeline.
//
// Scope: this file lives at /browser/sw.js, so it only intercepts
// /browser/* requests, which is exactly what we want (the editor's
// static asset path).
//
// Versioning: bump CACHE_NAME to invalidate the SW cache for a deploy.
// On activate the SW deletes all caches whose names don't match the
// current version, then takes control of all open clients.

// Cache name embeds the build fingerprint so each new deploy lands in a
// fresh Cache Storage namespace. The activate handler drops any cache
// whose name doesn't match the current CACHE_NAME, so an old build's
// 60+ MB heavy assets are evicted automatically when users revisit
// after a deploy. deploy.sh sed-patches __WASM_BUILD_FINGERPRINT__ here
// the same way it does for wasm-loader.js. If the placeholder is still
// present (dev tree without a deploy), fall back to a stable name.
const BUILD_FINGERPRINT = '__WASM_BUILD_FINGERPRINT__';
const CACHE_NAME = (BUILD_FINGERPRINT === '__WASM_BUILD' + '_FINGERPRINT__')
    ? 'cool-editor-dev'
    : 'cool-editor-' + BUILD_FINGERPRINT;

// Heavy assets we want to lock into Cache Storage. URLs are relative to
// the SW's scope (/browser/) — fetched from `${self.registration.scope}`.
const HEAVY_PATHS = [
    'online.wasm',
    'online.js',
    'online.worker.js',
    'soffice.data',
    'soffice.data.js.metadata',
    'bundle.js',
    'bundle.css',
    'global.js',
];

// Match any request whose URL ends with one of HEAVY_PATHS (allowing for
// content-hash filenames like online.abc12345.wasm or stable filenames).
const HEAVY_PATTERNS = [
    /\/online(\.[a-f0-9]+)?\.wasm(\?|$)/,
    /\/online(\.[a-f0-9]+)?\.js(\?|$)/,
    /\/online\.worker\.js(\?|$)/,
    /\/soffice\.data(\?|$)/,
    /\/soffice\.data\.js\.metadata(\?|$)/,
    /\/bundle(\.[a-f0-9]+)?\.js(\?|$)/,
    /\/bundle(\.[a-f0-9]+)?\.css(\?|$)/,
    /\/global(\.[a-f0-9]+)?\.js(\?|$)/,
];

function isHeavy(url) {
    return HEAVY_PATTERNS.some(re => re.test(url));
}

self.addEventListener('install', (event) => {
    // Don't pre-cache during install — let the lazy fetch handler populate
    // the cache as the editor actually loads. Pre-caching at install time
    // would download everything before the page even runs, defeating the
    // streaming-WASM compile path. We DO call skipWaiting so a new SW
    // takes effect on the next navigation rather than waiting for all
    // tabs to close.
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        // Iter 67: claim clients FIRST, then GC old caches in the
        // background. The new SW serves only out of CACHE_NAME, so the
        // old caches don't affect correctness — keeping them around
        // for an extra few hundred ms while clients.claim() runs is
        // harmless. Previously we awaited delete-all-caches before
        // claim, meaning a user with N old deploys' caches paid N×
        // delete latency before the new SW could take control of any
        // open tab. Reorder so the perceptible "new SW active" moment
        // happens immediately.
        const claimP = self.clients.claim();
        const gcP = caches.keys().then((names) =>
            Promise.all(names.filter(n => n !== CACHE_NAME)
                             .map(n => caches.delete(n))));
        // waitUntil keeps the SW alive for both — claim resolves
        // first and unblocks tabs; gc finishes whenever it finishes.
        await Promise.all([claimP, gcP]);
    })());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    if (!isHeavy(req.url)) return;

    // Cache-first: try Cache Storage, fall back to network. On network
    // success we tee the response into the cache so the next visit hits
    // it. On network failure we still surface the network error rather
    // than serving a half-loaded body.
    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(req.url);
        if (cached) {
            // Notify clients that this URL came from the SW cache so the
            // viewer's "downloading…" UI can show the right state. The
            // perf entry's transferSize will also be 0, which is what our
            // tests assert on.
            return cached;
        }
        const fresh = await fetch(req);
        // Only cache successful, full responses (status 200, not 206 etc.).
        // Clone before consuming the body — Response is one-shot.
        if (fresh.ok && fresh.status === 200) {
            try { await cache.put(req.url, fresh.clone()); }
            catch (e) { /* quota exceeded, keep going */ }
        }
        return fresh;
    })());
});

// Iter 41: precache message handler. wasm-loader.js postMessages
// {type: 'precache', urls: [...]} after prewarmReady fires; we fetch
// any URL not already in the cache and tee it. Backgrounds the heavy-
// asset population so a user who opens the doc, types, then closes the
// tab still leaves Cache Storage warm for their NEXT visit. Already-
// cached URLs are no-op (cheap). Errors swallowed — best-effort.
//
// Iter 192: report cached-count back to clients so callers (and tests)
// know when Cache Storage is actually warm. The fetch handler that
// runs ahead of this message handler may already have populated the
// cache for the URLs the page demanded; the precache loop fills the
// gaps (e.g. heavy assets fetched before the SW took control).
self.addEventListener('message', (event) => {
    if (!event.data || event.data.type !== 'precache') return;
    const urls = Array.isArray(event.data.urls) ? event.data.urls : [];
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
});
