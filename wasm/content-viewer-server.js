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
