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

// ── GET /api/files/ — list files ────────────────────────────────
app.get('/api/files/', async (req, res) => {
    try {
        res.json(await storage.list());
    } catch (err) {
        console.error('List files error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/files/:name — download file ────────────────────────
app.get('/api/files/:name', async (req, res) => {
    try {
        await storage.pipeTo(req.params.name, res);
    } catch (err) {
        console.error('Download error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// ── POST /api/files/:name — upload/overwrite file ───────────────
app.post('/api/files/:name', (req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
        try {
            const data = Buffer.concat(chunks);
            const result = await storage.put(req.params.name, data);
            res.json(result);
        } catch (err) {
            console.error('Upload error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });
});

// ── GET /blank.docx — blank document for prewarm ────────────────
// Try storage first (so an admin can swap the prewarm doc by uploading a
// `blank.docx`), then fall back to the bundled viewer-public/blank.docx.
app.get('/blank.docx', async (req, res) => {
    try {
        const buf = await storage.getBuffer('blank.docx');
        if (buf) {
            res.setHeader('Content-Type',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            return res.end(buf);
        }
    } catch (err) {
        console.error('blank.docx storage lookup error:', err.message);
    }
    // Fallback: bundled blank.docx
    const bundled = path.join(VIEWER_PUBLIC, 'blank.docx');
    if (fs.existsSync(bundled)) {
        res.setHeader('Content-Type',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        return res.end(fs.readFileSync(bundled));
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
