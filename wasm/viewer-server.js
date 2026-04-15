// Viewer / File Storage server for COOL WASM co-editing.
// Serves editor.html (upload/share UI) and a REST API for file CRUD.
//
// Storage backend is pluggable — see wasm/lib/storage/index.js.
// Switch with STORAGE_BACKEND=local|azure (default: local).
//   local  → filesystem under LOCAL_STORAGE_DIR (default ./storage)
//   azure  → Azure Blob, requires DOC_STORAGE_ACCOUNT / DOC_STORAGE_KEY

const express = require('express');
const path = require('path');
const fs = require('fs');
const storage = require('./lib/storage');

const PORT = process.env.PORT || 6934;

// ── URLs injected into editor.html ──────────────────────────────
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

const app = express();

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

// ── GET / — serve editor.html with injected config ──────────────
app.get('/', (req, res) => {
    // In deployed package, editor.html is in the same directory as server.js.
    // In development, fall back to browser/html/editor.html.
    const deployPath = path.join(__dirname, 'editor.html');
    const devPath = path.join(__dirname, '..', 'browser', 'html', 'editor.html');
    const htmlPath = fs.existsSync(deployPath) ? deployPath : devPath;
    res.sendFile(htmlPath, (err) => {
        if (err) res.status(500).send('Cannot load editor.html');
    });
});

// ── GET /config — return deployment URLs as JSON ────────────────
app.get('/config', (req, res) => {
    res.json({
        editorUrl: EDITOR_URL,
        relayUrl: RELAY_URL,
        viewerUrl: VIEWER_URL,
    });
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

// ── GET /blank.docx — blank document for pre-warm ───────────────
app.get('/blank.docx', async (req, res) => {
    try {
        await storage.pipeTo('blank.docx', res,
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    } catch (err) {
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Viewer server on port ${PORT}`);
    console.log(`  Storage:    ${storage.describe()}`);
    console.log(`  Editor:     ${EDITOR_URL}`);
    console.log(`  Relay:      ${RELAY_URL}`);
    console.log(`  CORS allow: ${ALLOW_ANY ? '* (any)' : ALLOWED_ORIGINS.join(', ') || '(none)'}`);
});
