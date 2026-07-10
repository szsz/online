#!/usr/bin/env node
/*
 * content-viewer-server.js — static host for the Tresorit content-preview
 * SPA (its built dist/), served in place of the legacy viewer.
 *
 * In the content-viewer architecture the browser stack is:
 *
 *   Tresorit Web Access (host)                              [cross-origin]
 *     └─ content-preview SPA  @ viewer.<domain>             ← THIS server
 *          ├─ Service Worker (collabora-sw.js, scope /)     proxies editor bytes
 *          └─ editor iframe  @ /collabora-<ver>/cool.html   [same-origin, SW-served]
 *
 * This replaces wasm/viewer-server.js on the viewer host: same port / cert /
 * SNI wiring, but it serves the content-preview build (which embeds our WASM
 * editor same-origin via its service worker) instead of viewer-public/. It is
 * pure static hosting — the v2 REST API, relay, and sw-bridge relay drop out
 * of this path (documents come from Tresorit via the content-viewer's SW).
 *
 * Config (env; set by launch-content-viewer.sh / systemd):
 *   PORT                 listen port (default 6934)
 *   CONTENT_VIEWER_DIST  path to the built content-preview dist/ (required)
 *   SSL_CERT, SSL_KEY    PEM paths; if both readable → HTTPS, else HTTP
 *   CSP                  optional Content-Security-Policy header value
 */

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const PORT = parseInt(process.env.PORT || '6934', 10);
const DIST = process.env.CONTENT_VIEWER_DIST
    || path.join(__dirname, '..', '..', 'content-preview', 'dist');
const SSL_CERT = process.env.SSL_CERT || '';
const SSL_KEY = process.env.SSL_KEY || '';
const useSSL = !!SSL_CERT && !!SSL_KEY && fs.existsSync(SSL_CERT) && fs.existsSync(SSL_KEY);

const INDEX = path.join(DIST, 'index.html');
if (!fs.existsSync(INDEX)) {
    console.error(`ERROR: CONTENT_VIEWER_DIST has no index.html: ${DIST}`);
    console.error('       Build content-preview (pnpm build) first, or set CONTENT_VIEWER_DIST.');
    process.exit(1);
}

const app = express();

// ── Cross-origin isolation (SharedArrayBuffer / WASM threads) ──
// Mirrors content-preview's own web.config + dev-server headers. COEP
// `credentialless` is the known-good baseline — `require-corp` was tried
// upstream (commit 3a076e8) and reverted (61ee9f5). CORP:cross-origin lets a
// COEP-enabled cross-origin parent (Tresorit Web Access) embed this SPA.
app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (process.env.CSP) res.setHeader('Content-Security-Policy', process.env.CSP);
    next();
});

// ── Shared-file store (co-edit doc seeding) ──
// Co-edit through the content viewer needs the doc bytes reachable by
// EVERY participant: browser A uploads a local file (bytes live only in
// A's service-worker cache), so a joiner B needs one shared HTTP home to
// fetch the same bytes from. The relay broker is metadata-only by design
// (hash + locator URL, never bytes — message-relay.js), so this server
// parks the bytes instead:
//
//   POST /shared-file/<key>   body = raw doc bytes, X-File-Name header
//   GET  /shared-file/<key>   → the bytes + X-File-Name
//
// The creating page POSTs here before opening the editor and advertises
// the room; the relay checkpoint locator points back at this URL; joiners
// GET it (same-origin — the SW passes /shared-file through untouched).
// In-memory with an LRU cap: entries live as long as the process, which
// exceeds any co-edit session on the single-instance test deployments
// this server targets. Not durable storage — same contract as the SW's
// own USER_FILES_CACHE (bounded, best-effort).
const SHARED_MAX_FILES = 30;                    // LRU entry cap
const SHARED_MAX_BYTES = 25 * 1024 * 1024;      // per-file cap
const sharedFiles = new Map();                  // key → { bytes, name, ts }
const SHARED_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/; // no path tricks

app.post('/shared-file/:key', express.raw({ type: () => true, limit: SHARED_MAX_BYTES }), (req, res) => {
    const key = req.params.key;
    if (!SHARED_KEY_RE.test(key)) return res.status(400).send('Bad key');
    if (!req.body || !req.body.length) return res.status(400).send('Empty body');
    // Refresh-on-write LRU: delete-then-set moves the key to the end.
    sharedFiles.delete(key);
    sharedFiles.set(key, {
        bytes: req.body,
        name: String(req.headers['x-file-name'] || ''),
        ts: Date.now(),
    });
    while (sharedFiles.size > SHARED_MAX_FILES) {
        sharedFiles.delete(sharedFiles.keys().next().value);
    }
    res.status(200).json({ ok: true, size: req.body.length });
});

app.get('/shared-file/:key', (req, res) => {
    const entry = sharedFiles.get(req.params.key);
    if (!entry) return res.status(404).send('No such shared file');
    res.setHeader('Content-Type', 'application/octet-stream');
    if (entry.name) res.setHeader('X-File-Name', entry.name);
    res.setHeader('Cache-Control', 'no-store');
    res.send(entry.bytes);
});

// ── Static assets from dist/ ──
// The service worker (collabora-sw.js) and hashed /assets/* bundles live
// here. index:false so directory requests fall through to the SPA handler.
app.use(express.static(DIST, {
    index: false,
    setHeaders(res, filePath) {
        if (filePath.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
        else if (filePath.endsWith('.data')) res.setHeader('Content-Type', 'application/octet-stream');
        const base = path.basename(filePath);
        if (base === 'collabora-sw.js' || base.endsWith('-sw.js')) {
            // The SW must be allowed to claim the root scope and never be
            // served stale (a stale SW would proxy the wrong editor build).
            res.setHeader('Service-Worker-Allowed', '/');
            res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.replace(/\\/g, '/').includes('/assets/')) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    },
}));

// ── SPA fallback ──
// Client routes (collabora-tester, open-office-document, preload,
// view-document, …) resolve to index.html. Never fall back for:
//   - non-GET requests,
//   - asset-looking paths with an extension (would mask a real 404 with HTML),
//   - the SW-owned /collabora-<datetime>/ editor-asset prefix (served by the
//     SW at runtime; a miss here means the SW isn't active yet — surface it as
//     404, not HTML). Note the version prefix (/collabora-2026-…Z/) must NOT
//     swallow the /collabora-tester client route, hence the datetime anchor.
// A final middleware (not app.get('*')) keeps this valid on Express 4 and 5.
const SW_ASSET_PREFIX = /^\/collabora-\d{4}-\d{2}-\d{2}T/;
app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (path.extname(req.path)) return res.status(404).send('Not found');
    if (SW_ASSET_PREFIX.test(req.path)) return res.status(404).send('Not found');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(INDEX);
});

const server = useSSL
    ? https.createServer({ cert: fs.readFileSync(SSL_CERT), key: fs.readFileSync(SSL_KEY) }, app)
    : http.createServer(app);

server.listen(PORT, () => {
    console.log(`content-viewer server on ${useSSL ? 'HTTPS' : 'HTTP'} port ${PORT}`);
    console.log(`  dist: ${DIST}`);
    if (useSSL) console.log(`  TLS:  cert=${SSL_CERT}`);
});
