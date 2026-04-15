// Viewer / File Storage server for COOL WASM co-editing.
// Serves editor.html (upload/share UI) and a REST API for file CRUD
// backed by Azure Blob Storage.

const express = require('express');
const { BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob');
const path = require('path');

const PORT = process.env.PORT || 6934;

// ── Azure Blob Storage ──────────────────────────────────────────
const accountName = process.env.DOC_STORAGE_ACCOUNT;
const accountKey  = process.env.DOC_STORAGE_KEY;
const containerName = process.env.DOC_STORAGE_CONTAINER || 'documents';

if (!accountName || !accountKey) {
    console.error('Missing DOC_STORAGE_ACCOUNT or DOC_STORAGE_KEY');
    process.exit(1);
}

const credential = new StorageSharedKeyCredential(accountName, accountKey);
const blobService = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`, credential
);
const container = blobService.getContainerClient(containerName);

// ── URLs injected into editor.html ──────────────────────────────
const EDITOR_URL = process.env.EDITOR_URL || '';
const RELAY_URL  = process.env.RELAY_URL  || '';
const VIEWER_URL = process.env.FILE_STORAGE_URL || '';

const app = express();

// CORS — editor app on a different domain needs access
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
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
    const htmlPath = require('fs').existsSync(deployPath) ? deployPath : devPath;
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
        const files = [];
        for await (const blob of container.listBlobsFlat()) {
            files.push({ name: blob.name, size: blob.properties.contentLength });
        }
        res.json(files);
    } catch (err) {
        console.error('List files error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── GET /api/files/:name — download file ────────────────────────
app.get('/api/files/:name', async (req, res) => {
    try {
        const blob = container.getBlobClient(req.params.name);
        const download = await blob.download(0);
        res.setHeader('Content-Type', download.contentType || 'application/octet-stream');
        download.readableStreamBody.pipe(res);
    } catch (err) {
        if (err.statusCode === 404) return res.status(404).send('Not found');
        console.error('Download error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/files/:name — upload/overwrite file ───────────────
app.post('/api/files/:name', (req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
        try {
            const data = Buffer.concat(chunks);
            const blob = container.getBlockBlobClient(req.params.name);
            await blob.upload(data, data.length, {
                blobHTTPHeaders: { blobContentType: 'application/octet-stream' },
            });
            res.json({ name: req.params.name, size: data.length });
        } catch (err) {
            console.error('Upload error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });
});

// ── GET /blank.docx — blank document for pre-warm ───────────────
app.get('/blank.docx', async (req, res) => {
    try {
        const blob = container.getBlobClient('blank.docx');
        const download = await blob.download(0);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        download.readableStreamBody.pipe(res);
    } catch (err) {
        if (err.statusCode === 404) return res.status(404).send('No blank.docx in storage');
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Viewer server on port ${PORT}`);
    console.log(`  Blob: ${accountName}/${containerName}`);
    console.log(`  Editor: ${EDITOR_URL}`);
    console.log(`  Relay:  ${RELAY_URL}`);
});
