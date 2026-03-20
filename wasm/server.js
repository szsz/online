// Static file server with COOP/COEP headers (required for SharedArrayBuffer/WASM pthreads).
// Also serves as a WOPI-like bridge to Azure Blob Storage for document load/save.
try { require('dotenv').config(); } catch (e) { /* dotenv optional */ }

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception (server continues):', err.message);
});

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 6931;
const ROOT = path.resolve(__dirname, 'public');

// Azure Blob Storage setup (optional — falls back to local storage)
let blobServiceClient = null;
let containerClient = null;
const AZURE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING || '';
const AZURE_ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT_NAME || '';
const AZURE_KEY = process.env.AZURE_STORAGE_ACCOUNT_KEY || '';
const AZURE_CONTAINER = process.env.AZURE_STORAGE_CONTAINER || 'documents';

if (AZURE_CONN || (AZURE_ACCOUNT && AZURE_KEY)) {
    try {
        const { BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob');
        if (AZURE_CONN) {
            blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_CONN);
        } else {
            const cred = new StorageSharedKeyCredential(AZURE_ACCOUNT, AZURE_KEY);
            blobServiceClient = new BlobServiceClient(`https://${AZURE_ACCOUNT}.blob.core.windows.net`, cred);
        }
        containerClient = blobServiceClient.getContainerClient(AZURE_CONTAINER);
        containerClient.createIfNotExists().then(() => {
            console.log(`Azure Blob Storage: using container '${AZURE_CONTAINER}'`);
        }).catch(err => {
            console.error('Azure Blob Storage: failed to create container:', err.message);
        });
    } catch (e) {
        console.warn('Azure Blob Storage: setup failed:', e.message, e.code);
    }
}

// Local fallback storage directory (use /tmp on Azure since wwwroot is read-only)
const LOCAL_STORAGE = process.env.WEBSITE_RUN_FROM_PACKAGE ? '/tmp/wasm-docs' : path.resolve(__dirname, '.wasm-docs');
if (!AZURE_CONN && !AZURE_ACCOUNT) {
    fs.mkdirSync(LOCAL_STORAGE, { recursive: true });
    console.log(`Local document storage: ${LOCAL_STORAGE}`);
}

// Read full request body as Buffer
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}



// Blob helpers
async function blobGet(blobName) {
    if (containerClient) {
        const blob = containerClient.getBlockBlobClient(blobName);
        const resp = await blob.download(0);
        const chunks = [];
        for await (const chunk of resp.readableStreamBody) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }
    // Local fallback
    const fp = path.join(LOCAL_STORAGE, blobName.replace(/[^a-zA-Z0-9._-]/g, '_'));
    return fs.promises.readFile(fp);
}

async function blobPut(blobName, data) {
    if (containerClient) {
        const blob = containerClient.getBlockBlobClient(blobName);
        await blob.upload(data, data.length, { overwrite: true });
        return;
    }
    // Local fallback
    const fp = path.join(LOCAL_STORAGE, blobName.replace(/[^a-zA-Z0-9._-]/g, '_'));
    await fs.promises.writeFile(fp, data);
}

const MIME = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.mjs':  'application/javascript',
    '.wasm': 'application/wasm',
    '.css':  'text/css',
    '.json': 'application/json',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.data': 'application/octet-stream',
};

const server = http.createServer(async (req, res) => {
    // All pages get COOP/COEP (required for SharedArrayBuffer).
    // The parent (document manager) must also set COEP: credentialless
    // for cross-origin isolated to propagate through the frame tree.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    let urlPath;
    try {
        urlPath = decodeURIComponent(req.url.split('?')[0]);
    } catch (e) {
        urlPath = req.url.split('?')[0];
    }
    if (urlPath === '/') urlPath = '/wasm.html';

    // Serve runtime config from environment variables
    if (urlPath === '/config.js') {
        const relayUrl = process.env.RELAY_URL || '';
        const cdnUrl = process.env.CDN_URL || '';
        const cdnVersion = process.env.CDN_VERSION || '';
        const body = `window.__CONFIG__=${JSON.stringify({ relayUrl, cdnUrl, cdnVersion })};`;
        res.writeHead(200, { 'Content-Type': 'application/javascript', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
        return;
    }

    // /wasm/meta/<hash> — encrypted filename metadata (stored as <hash>.meta blob)
    if (urlPath.startsWith('/wasm/meta/')) {
        const hash = urlPath.substring('/wasm/meta/'.length).split('?')[0];
        if (!hash) { res.writeHead(400); res.end('Missing hash'); return; }
        const metaName = hash + '.meta';
        try {
            if (req.method === 'GET') {
                const data = await blobGet(metaName);
                res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': data.length });
                res.end(data);
            } else if (req.method === 'POST') {
                const body = await readBody(req);
                await blobPut(metaName, body);
                res.writeHead(200);
                res.end('OK');
                console.log(`POST /wasm/meta/${hash} — metadata saved`);
            } else {
                res.writeHead(405); res.end('Method not allowed');
            }
        } catch (err) {
            res.writeHead(err.statusCode || 404);
            res.end(err.message || 'Not found');
        }
        return;
    }

    // /wasm/* endpoints: document load/save via Azure Blob Storage
    // HEAD /wasm/<blobName> — check if document exists
    // GET  /wasm/<blobName> — download document (called by COOLWSD emscripten_fetch)
    // POST /wasm/<blobName> — upload/save document (called by saveToServer or wasm.html)
    if (urlPath.startsWith('/wasm/')) {
        const blobName = urlPath.substring('/wasm/'.length).split('?')[0];
        if (!blobName) {
            res.writeHead(400);
            res.end('Missing blob name');
            return;
        }

        try {
            if (req.method === 'HEAD') {
                await blobGet(blobName);
                res.writeHead(200);
                res.end();
            } else if (req.method === 'GET') {
                const data = await blobGet(blobName);
                res.writeHead(200, {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': data.length,
                });
                res.end(data);
                console.log(`GET /wasm/${blobName} — ${data.length} bytes`);
            } else if (req.method === 'POST') {
                const body = await readBody(req);
                await blobPut(blobName, body);
                res.writeHead(200);
                res.end('OK');
                console.log(`POST /wasm/${blobName} — ${body.length} bytes saved`);
            } else {
                res.writeHead(405);
                res.end('Method not allowed');
            }
        } catch (err) {
            console.error(`/wasm/${blobName} error:`, err.message);
            res.writeHead(err.statusCode || 500);
            res.end(err.message);
        }
        return;
    }

    const filePath = path.join(ROOT, urlPath);

    if (!filePath.startsWith(ROOT)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    function serveFile(fp) {
        fs.stat(fp, (err, stats) => {
            if (err || !stats.isFile()) {
                const fpHtml = fp + '.html';
                fs.stat(fpHtml, (err2, stats2) => {
                    if (err2 || !stats2.isFile()) {
                        res.writeHead(404);
                        res.end('Not found: ' + urlPath);
                        return;
                    }
                    streamFile(fpHtml, stats2);
                });
                return;
            }
            streamFile(fp, stats);
        });
    }

    function streamFile(fp, stats) {
        const ext = path.extname(fp).toLowerCase();
        const contentType = MIME[ext] || 'application/octet-stream';
        // online.js changes between builds — don't cache aggressively.
        // HTML/JSON: no-cache. WASM/data: immutable (versioned via ?v= on CDN).
        const basename = path.basename(fp);
        const noCache = ext === '.html' || ext === '.json' || basename === 'online.js';
        const cacheControl = noCache
            ? 'no-cache'
            : 'public, max-age=31536000, immutable';
        res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': stats.size,
            'Cache-Control': cacheControl,
        });
        fs.createReadStream(fp).pipe(res);
    }

    serveFile(filePath);
});

server.listen(PORT, () => {
    console.log(`Serving ${ROOT} on port ${PORT}`);
    console.log(`Document storage: ${containerClient ? 'Azure Blob Storage' : 'local (' + LOCAL_STORAGE + ')'}`);
});
