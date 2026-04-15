// Viewer / File Storage server for COOL WASM co-editing.
//
// Serves the sidebar viewer UI (file list + iframe editor + hot-switch
// flow + loading shield) from wasm/viewer-public/, plus a REST API for
// file CRUD that's pluggable across storage backends.
//
// Storage backend selection — see wasm/lib/storage/index.js.
//   STORAGE_BACKEND=local   filesystem under LOCAL_STORAGE_DIR (default ./storage)
//   STORAGE_BACKEND=azure   Azure Blob. Auth via DOC_STORAGE_SAS_URL (full
//                           container SAS) OR DOC_STORAGE_ACCOUNT+KEY.
//
// The deployed package layout (created by wasm/deploy-azure.sh) is:
//   server.js            (this file, copied from wasm/viewer-server.js)
//   viewer-public/       (sidebar UI assets, copied from wasm/viewer-public/)
//   editor.html          (legacy upload-only UI, served at /upload)
//   lib/storage/         (backend abstraction)
//   node_modules/        (express, optionally @azure/storage-blob)

const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const storage = require('./lib/storage');

const PORT = parseInt(process.env.PORT || '6934', 10);

// HTTPS — used when SSL_CERT and SSL_KEY are both set and readable.
// On Azure App Service, the platform terminates TLS so these are unset
// and we listen plain HTTP on $PORT (Azure's `process.env.PORT` is the
// internal port the platform routes HTTPS traffic to).
const SSL_CERT = process.env.SSL_CERT || '';
const SSL_KEY  = process.env.SSL_KEY  || '';
const useSSL = !!SSL_CERT && !!SSL_KEY && fs.existsSync(SSL_CERT) && fs.existsSync(SSL_KEY);

// ── URLs injected into the viewer page via /config.js ───────────
const EDITOR_URL = process.env.EDITOR_URL || '';
const RELAY_URL  = process.env.RELAY_URL  || '';
const VIEWER_URL = process.env.FILE_STORAGE_URL || '';

// CORS allow-list. Defaults to EDITOR_URL (the only origin that legitimately
// uploads files into storage) plus self. Override with ALLOWED_ORIGINS as a
// comma-separated list, or `*` to disable origin checking entirely.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
    || [EDITOR_URL, VIEWER_URL].filter(Boolean).join(','))
    .split(',').map(s => s.trim()).filter(Boolean);
const ALLOW_ANY = ALLOWED_ORIGINS.length === 1 && ALLOWED_ORIGINS[0] === '*';

// Where the sidebar UI assets live. By default look next to this script
// (works for both the deployed bundle and the in-tree wasm/viewer-public/).
// VIEWER_PUBLIC env can override for unusual layouts.
const VIEWER_PUBLIC = process.env.VIEWER_PUBLIC
    || path.join(__dirname, 'viewer-public');

const app = express();

// ── Cross-origin isolation ──────────────────────────────────────
// SharedArrayBuffer (used by the editor iframe's WASM threads) requires
// the top-level page to be cross-origin isolated:
//   COOP: same-origin
//   COEP: require-corp
// And we delegate cross-origin-isolated to the editor iframe origin via
// Permissions-Policy so the editor can use SAB inside our iframe.
app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    if (EDITOR_URL) {
        res.setHeader('Permissions-Policy',
            'cross-origin-isolated=(self "' + EDITOR_URL + '")');
    }
    next();
});

// ── CORS ────────────────────────────────────────────────────────
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (ALLOW_ANY) {
        res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// ── GET / — the sidebar viewer UI ───────────────────────────────
app.get('/', (req, res) => {
    const indexPath = path.join(VIEWER_PUBLIC, 'index.html');
    if (!fs.existsSync(indexPath)) {
        return res.status(500).send('viewer-public/index.html missing — broken bundle');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(fs.readFileSync(indexPath));
});

// ── GET /config.js — inject deployment URLs into the viewer ────
// The viewer's index.html does <script src="/config.js"></script>
// before its own JS runs, so window.__CONFIG.EDITOR_URL / .RELAY_URL
// are set before any code reads them.
app.get('/config.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-cache');
    res.send('window.__CONFIG = ' + JSON.stringify({
        EDITOR_URL,
        RELAY_URL,
        VIEWER_URL,
    }) + ';');
});

// ── GET /config — same data as JSON, used by editor.html ───────
app.get('/config', (req, res) => {
    res.json({
        editorUrl: EDITOR_URL,
        relayUrl: RELAY_URL,
        viewerUrl: VIEWER_URL,
    });
});

// ── GET /upload — legacy upload-only UI (editor.html) ──────────
// Kept for backwards compatibility with share links generated by the
// upload page. Most users land on / (the sidebar viewer) instead.
app.get('/upload', (req, res) => {
    const deployPath = path.join(__dirname, 'editor.html');
    const devPath    = path.join(__dirname, '..', 'browser', 'html', 'editor.html');
    const htmlPath   = fs.existsSync(deployPath) ? deployPath : devPath;
    if (!fs.existsSync(htmlPath)) return res.status(404).send('editor.html not bundled');
    res.sendFile(htmlPath);
});

// ── GET /api/files/ — list files (with current hashes) ─────────
app.get('/api/files/', async (req, res) => {
    try {
        // listNames returns [{name, hash, size, updatedAt}] from the
        // content-addressable layer; legacy plain-name blobs without
        // metadata appear with hash=null.
        const items = typeof storage.listNames === 'function'
            ? await storage.listNames() : await storage.list();
        res.json(items);
    } catch (err) {
        console.error('List files error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/blobs/:hash — content-addressable blob ─────────────
// The actual document bytes, addressed by their SHA-256 hash. Same hash
// → same bytes, forever — so this is the cleanest immutable resource on
// the server: max-age=1y + immutable + ETag = the hash itself. Late
// joiners download from here so the bytes they get can never drift from
// what the relay's checkpoint hash promised.
app.get('/api/blobs/:hash', async (req, res) => {
    try {
        const hash = req.params.hash;
        if (!/^[0-9a-f]{16,128}$/i.test(hash)) {
            res.status(400).json({ error: 'Bad hash format' });
            return;
        }
        // Conditional GET shortcut — content-addressable URLs never change
        // body, so ETag = hash always matches.
        if (req.headers['if-none-match'] === '"' + hash + '"') {
            res.status(304).end(); return;
        }
        const blobMeta = typeof storage.statBlob === 'function'
            ? await storage.statBlob(hash) : null;
        if (!blobMeta) { res.status(404).json({ error: 'No such blob' }); return; }
        res.setHeader('ETag', '"' + hash + '"');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('Content-Length', blobMeta.size);
        // Body type is opaque (the editor knows the doc type from the name);
        // application/octet-stream avoids any browser content-sniffing.
        await storage.pipeBlobTo(hash, res, 'application/octet-stream');
    } catch (err) {
        console.error('Blob download error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// ── GET /api/files/:name — download current version of `name` ──
// Resolves the name to its current hash via metadata, then proxies the
// blob bytes. Sends `X-Content-Hash: <hash>` so the caller knows which
// content version it got (handy for the relay-adapter — and for tests).
//
// Cache contract: Cache-Control: no-cache. The mapping name→hash is
// mutable (co-editing saves update it), so we always revalidate. The
// underlying blob fetch is a 304 on hash-match, but the name's own
// ETag rotates with each save.
app.get('/api/files/:name', async (req, res) => {
    try {
        const meta = typeof storage.getName === 'function'
            ? await storage.getName(req.params.name)
            : (typeof storage.stat === 'function' ? await storage.stat(req.params.name) : null);
        if (!meta) { res.status(404).json({ error: 'Not found' }); return; }
        const hash = meta.hash || meta.etag;   // legacy stat() returns etag
        if (hash) {
            const wEtag = 'W/"' + hash + '"';
            res.setHeader('ETag', wEtag);
            res.setHeader('X-Content-Hash', hash);
            const lastMod = meta.updatedAt
                ? new Date(meta.updatedAt).toUTCString()
                : (meta.lastModified ? new Date(meta.lastModified).toUTCString() : null);
            if (lastMod) res.setHeader('Last-Modified', lastMod);
            res.setHeader('Cache-Control', 'no-cache');
            const ims = req.headers['if-modified-since'];
            const imsHit = lastMod && ims &&
                new Date(ims).getTime() >= new Date(lastMod).getTime();
            if (req.headers['if-none-match'] === wEtag || imsHit) {
                res.status(304).end(); return;
            }
        }
        await storage.pipeTo(req.params.name, res);
    } catch (err) {
        console.error('Download error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// ── POST /api/files/:name — upload new version of `name` ───────
// Computes the SHA-256 server-side, stores under /_blobs/<hash>, and
// updates the name → hash mapping. Returns {name, size, hash} so the
// uploader knows the canonical hash without re-computing.
app.post('/api/files/:name', (req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
        try {
            const data = Buffer.concat(chunks);
            const result = await storage.put(req.params.name, data);
            res.json(result);  // {name, size, hash}
        } catch (err) {
            console.error('Upload error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });
});

// ── GET /blank.docx — blank document for prewarm ────────────────
// Try storage first (so an admin can swap the prewarm doc by uploading a
// `blank.docx`), then fall back to the bundled viewer-public/blank.docx.
//
// Caching: the bundled file's mtime is stable across deploys (its tracked
// in source), so set a 1-hour max-age + ETag — first-visit downloads it,
// subsequent visits get 304 quickly.
app.get('/blank.docx', async (req, res) => {
    const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    // Helper: send a buffer with cache headers.
    function sendWithCache(buf, etag, lastMod) {
        const wEtag = 'W/"' + etag + '"';
        res.setHeader('Content-Type', DOCX_MIME);
        res.setHeader('ETag', wEtag);
        if (lastMod) res.setHeader('Last-Modified', new Date(lastMod).toUTCString());
        res.setHeader('Cache-Control', 'public, max-age=3600');
        const ims = req.headers['if-modified-since'];
        const imsHit = lastMod && ims &&
            new Date(ims).getTime() >= new Date(lastMod).getTime();
        if (req.headers['if-none-match'] === wEtag || imsHit) {
            return res.status(304).end();
        }
        res.end(buf);
    }

    // Storage-side blank.docx (admin override).
    try {
        if (typeof storage.stat === 'function') {
            const meta = await storage.stat('blank.docx');
            if (meta) {
                const buf = await storage.getBuffer('blank.docx');
                if (buf) return sendWithCache(buf, meta.etag, meta.lastModified);
            }
        } else {
            const buf = await storage.getBuffer('blank.docx');
            if (buf) {
                res.setHeader('Content-Type', DOCX_MIME);
                return res.end(buf);
            }
        }
    } catch (err) {
        console.error('blank.docx storage lookup error:', err.message);
    }
    // Fallback: bundled blank.docx — use the file's own stat for ETag.
    const bundled = path.join(VIEWER_PUBLIC, 'blank.docx');
    if (fs.existsSync(bundled)) {
        const st = fs.statSync(bundled);
        const buf = fs.readFileSync(bundled);
        const etag = st.size.toString(16) + '-' + Math.floor(st.mtimeMs * 1000).toString(16);
        return sendWithCache(buf, etag, st.mtime);
    }
    res.status(404).send('blank.docx not available (neither in storage nor bundled)');
});

const server = useSSL
    ? https.createServer({ cert: fs.readFileSync(SSL_CERT), key: fs.readFileSync(SSL_KEY) }, app)
    : http.createServer(app);

server.listen(PORT, () => {
    console.log(`Viewer server on ${useSSL ? 'HTTPS' : 'HTTP'} port ${PORT}`);
    console.log(`  UI:         ${VIEWER_PUBLIC}`);
    console.log(`  Storage:    ${storage.describe()}`);
    console.log(`  Editor:     ${EDITOR_URL}`);
    console.log(`  Relay:      ${RELAY_URL}`);
    console.log(`  CORS allow: ${ALLOW_ANY ? '* (any)' : ALLOWED_ORIGINS.join(', ') || '(none)'}`);
    if (useSSL) console.log(`  TLS:        cert=${SSL_CERT}`);
});
