// Viewer / File Storage server for COOL WASM co-editing.
//
// Serves the sidebar viewer UI (file list + iframe editor + hot-switch
// flow + loading shield) from wasm/viewer-public/, plus a REST API for
// file CRUD that's pluggable across storage backends.
//
// Storage backend selection — see wasm/lib/storage/index.js.
//   STORAGE_BACKEND=local   filesystem under LOCAL_STORAGE_DIR (default ./storage)
//   STORAGE_BACKEND=azure   Azure Blob. Auth (preferred → fallback):
//                           1. DOC_STORAGE_ACCOUNT only → DefaultAzureCredential
//                              (App Service MSI in Azure, `az login` locally)
//                           2. DOC_STORAGE_SAS_URL (full container-scoped SAS)
//                           3. DOC_STORAGE_ACCOUNT+DOC_STORAGE_KEY (legacy)
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
const crypto = require('crypto');
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
            'cross-origin-isolated=(self "' + EDITOR_URL + '"), ' +
            'clipboard-read=(self "' + EDITOR_URL + '"), ' +
            'clipboard-write=(self "' + EDITOR_URL + '")');
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Expected-Hash, X-Force-Overwrite');
    res.setHeader('Access-Control-Expose-Headers', 'X-Content-Hash');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// Iter 61: cache static HTML bodies in memory keyed on mtime + emit
// ETag so revisits 304. Without this every navigation re-downloaded
// the full body (~25KB index.html) even though Cache-Control: no-cache
// only forces revalidation, not refetch. Mirrors the iter 53/58 pattern.
const _htmlCache = new Map(); // path -> { mtimeMs, body, etag }
function serveStaticHtml(req, res, htmlPath, missingMessage) {
    if (!fs.existsSync(htmlPath)) {
        return res.status(500).send(missingMessage);
    }
    const stat = fs.statSync(htmlPath);
    let entry = _htmlCache.get(htmlPath);
    if (!entry || entry.mtimeMs !== stat.mtimeMs) {
        entry = {
            mtimeMs: stat.mtimeMs,
            body: fs.readFileSync(htmlPath),
            etag: '"' + stat.size.toString(16) + '-' + stat.mtimeMs.toString(16) + '"',
        };
        _htmlCache.set(htmlPath, entry);
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', entry.etag);
    res.setHeader('Last-Modified', new Date(stat.mtimeMs).toUTCString());
    const ims = req.headers['if-modified-since'];
    const imsHit = ims && new Date(ims).getTime() >= Math.floor(stat.mtimeMs / 1000) * 1000;
    if (req.headers['if-none-match'] === entry.etag || imsHit) {
        return res.status(304).end();
    }
    res.send(entry.body);
}

// ── GET / and /index.html — the sidebar viewer UI ──────────────
// Both paths resolve to the same file. Some integrations and link
// templates write the explicit `/index.html`; without this alias they
// get Express's default 404 page.
for (const p of ['/', '/index.html']) {
    app.get(p, (req, res) => {
        serveStaticHtml(req, res,
            path.join(VIEWER_PUBLIC, 'index.html'),
            'viewer-public/index.html missing — broken bundle');
    });
}

// ── GET /singleuser.html — same viewer, no relay/co-editing ────
app.get('/singleuser.html', (req, res) => {
    serveStaticHtml(req, res,
        path.join(VIEWER_PUBLIC, 'singleuser.html'),
        'viewer-public/singleuser.html missing');
});

// ── GET /help, /help.html — setup + integration guide ──────────
// Accessible directly (not iframed), so it does not need COEP/CORP.
for (const p of ['/help', '/help.html']) {
    app.get(p, (req, res) => {
        serveStaticHtml(req, res,
            path.join(VIEWER_PUBLIC, 'help.html'),
            'viewer-public/help.html missing');
    });
}

// ── GET /config.js — inject deployment URLs into the viewer ────
// The viewer's index.html does <script src="/config.js"></script>
// before its own JS runs, so window.__CONFIG.EDITOR_URL / .RELAY_URL
// are set before any code reads them.
//
// Iter 54: the config payload is fixed for the lifetime of the
// viewer process (set at startup from .env). Send a stable ETag
// based on the payload hash so revisits 304 instead of re-downloading
// the (~120 byte) script. Tiny wire saving but freezes a step that
// runs before the page's own JS — saves a millisecond on every
// navigation. Cache-Control stays no-cache so a process restart
// (env change) is picked up via the conditional GET.
const _configPayload = 'window.__CONFIG = ' + JSON.stringify({
    EDITOR_URL,
    RELAY_URL,
    VIEWER_URL,
}) + ';';
const _configETag = '"' + require('crypto').createHash('sha256')
    .update(_configPayload).digest('hex').substring(0, 16) + '"';
app.get('/config.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', _configETag);
    if (req.headers['if-none-match'] === _configETag) {
        res.status(304).end();
        return;
    }
    res.send(_configPayload);
});

// ── GET /config — same data as JSON, used by editor.html ───────
app.get('/config', (req, res) => {
    res.json({
        editorUrl: EDITOR_URL,
        relayUrl: RELAY_URL,
        viewerUrl: VIEWER_URL,
    });
});

// ── GET /lib/*.js — client-side helper scripts (file-crypto.js,
// recent-files.js). Served as plain static assets from
// viewer-public/lib so index.html's <script src="lib/…"> tags resolve.
app.use('/lib', express.static(path.join(VIEWER_PUBLIC, 'lib'), {
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache');
    },
}));

// ── GET /report/* — viewer hot-switch report (test artifact) ──
// Lets a remote operator open the latest run of
// test-regression-viewer-hot-switch-report.js without sshfs/scp.
// REPORT_DIR is overridable for CI; default is the path the test writes to.
const REPORT_DIR = process.env.REPORT_DIR || '/tmp/hot-switch-report';
app.use('/report', express.static(REPORT_DIR, {
    extensions: ['html'],
    setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache'); },
}));

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

// ── POST /api/folders — create a folder ───────────────────────────
// Body: JSON {path: "folder/subfolder"}.
// Folders are virtual — they exist only when files inside them exist.
// But we record them in a .folders metadata file so empty folders show
// in the tree until something is added.
// Folder list is stored as a virtual file in the same storage backend.
const FOLDERS_KEY = '__system__folders.json';
async function readFolders() {
    try {
        const buf = await storage.getBuffer(FOLDERS_KEY);
        return buf ? JSON.parse(buf.toString('utf8')) : [];
    } catch(e) { return []; }
}
async function writeFolders(folders) {
    await storage.put(FOLDERS_KEY, Buffer.from(JSON.stringify(folders)));
}

app.post('/api/folders', express.json(), async (req, res) => {
    const folderPath = req.body && req.body.path;
    if (!folderPath || typeof folderPath !== 'string') {
        return res.status(400).json({ error: 'Missing path' });
    }
    const parts = folderPath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '').split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) {
        return res.status(400).json({ error: 'Invalid folder path' });
    }
    const clean = parts.join('/');
    const folders = await readFolders();
    if (!folders.includes(clean)) {
        folders.push(clean);
        await writeFolders(folders);
    }
    res.json({ path: clean, created: true });
});

app.get('/api/folders', async (req, res) => {
    res.json(await readFolders());
});

// ── Encryption key API ──────────────────────────────────────────
// Keys are derived from HMAC(secret, fileId|keyVersion|secret|messagekey).
// The keyVersion is an hourly counter. Clients request keys via the
// viewer (postMessage → fetch → respond), never directly from the editor.
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'dev-secret-change-in-prod';

app.get('/api/keys/current-version', (req, res) => {
    // Monotonically increasing hourly counter from a fixed epoch
    const epoch = new Date('2026-01-01T00:00:00Z').getTime();
    const version = Math.floor((Date.now() - epoch) / 3600000);
    res.json({ keyVersion: version });
});

app.get('/api/keys/:fileId/:keyVersion', (req, res) => {
    const material = req.params.fileId + '|' + req.params.keyVersion + '|' + ENCRYPTION_SECRET + '|messagekey';
    const key = crypto.createHmac('sha256', ENCRYPTION_SECRET).update(material).digest('base64');
    res.json({
        fileId: req.params.fileId,
        keyVersion: parseInt(req.params.keyVersion, 10),
        key: key,
    });
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
// Use a wildcard so nested paths (foo/bar.docx) work. Azure's front-end
// decodes %2F in URL paths to real /, so a plain :name (single segment)
// misses any nested upload. path-to-regexp v8 (Express 5) uses *name for
// greedy matches; earlier versions used :name(.+). We normalize the
// captured name below so either syntax works.
app.get('/api/files/*name', async (req, res) => {
    if (Array.isArray(req.params.name)) req.params.name = req.params.name.join('/');
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
app.post('/api/files/*name', (req, res) => {
    if (Array.isArray(req.params.name)) req.params.name = req.params.name.join('/');
    // The prewarm blank is read-only runtime. It's uploaded once by the
    // deploy script and must stay pristine — otherwise LO saves during
    // the prewarm window bleed content back into the blank and every
    // subsequent prewarm loads that bleed-state. Admins can still seed
    // via the deploy path (which reads the bundled viewer-public/blank.docx),
    // but client-side POSTs are rejected. Clients that want to save
    // must first rename (Save As) and repost under the new name.
    if (req.params.name === '__prewarm_blank.docx') {
        req.on('data', () => {});  // drain, don't buffer
        req.on('end', () => {
            res.status(403).json({
                error: 'prewarm-read-only',
                message: 'The prewarm blank is read-only. Rename the document (Save As) to save.',
            });
        });
        return;
    }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
        try {
            const data = Buffer.concat(chunks);
            const expectedHash = req.headers['x-expected-hash'] || null;
            const force = req.headers['x-force-overwrite'] === 'true';
            const result = await storage.put(req.params.name, data, { expectedHash, force });
            if (result.conflict) {
                res.status(409).json(result);
                return;
            }
            res.json(result);  // {name, size, hash}
        } catch (err) {
            console.error('Upload error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });
});

// ══════════════════════════════════════════════════════════════════
// v2 API — opaque per-file encryption
// ══════════════════════════════════════════════════════════════════
// The client derives content+name keys from a 128-bit URL-fragment
// secret; the server only stores ciphertext. fileId is a 64-hex string
// derived from the same secret (HKDF info="file-id"). We reject any
// other shape to keep the namespace disjoint from other _blobs/_meta
// files and to block path traversal.
const FILE_ID_RE = /^[0-9a-f]{64}$/;

// GET /api/v2/file/:fileId → returns {ciphertext: base64, encName: base64,
//                                     size, updatedAt}
app.get('/api/v2/file/:fileId', async (req, res) => {
    const id = req.params.fileId;
    if (!FILE_ID_RE.test(id)) return res.status(400).json({ error: 'bad fileId' });
    try {
        const name = 'v2/' + id;
        const meta = typeof storage.getName === 'function'
            ? await storage.getName(name) : null;
        if (!meta) return res.status(404).json({ error: 'not found' });
        const buf = await storage.getBuffer(name);
        if (!buf) return res.status(404).json({ error: 'not found' });
        res.json({
            ciphertext: buf.toString('base64'),
            encName: meta.encName || null,
            size: buf.length,
            updatedAt: meta.updatedAt,
        });
    } catch(e) {
        console.error('v2 get error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// PUT /api/v2/file/:fileId
// Body: JSON {ciphertext: base64, encName: base64}
app.put('/api/v2/file/:fileId', express.json({ limit: '256mb' }), async (req, res) => {
    const id = req.params.fileId;
    if (!FILE_ID_RE.test(id)) return res.status(400).json({ error: 'bad fileId' });
    const { ciphertext, encName } = req.body || {};
    if (typeof ciphertext !== 'string' || typeof encName !== 'string') {
        return res.status(400).json({ error: 'ciphertext and encName required (base64)' });
    }
    try {
        const buf = Buffer.from(ciphertext, 'base64');
        const name = 'v2/' + id;
        const result = await storage.put(name, buf, {});
        // Stash encName on the meta record (piggy-backs on existing
        // content-addressable storage; encName is an opaque blob the
        // server never inspects).
        if (typeof storage.setMetaField === 'function') {
            await storage.setMetaField(name, 'encName', encName);
        } else if (typeof storage.setName === 'function') {
            // Fallback: attach via a sidecar name — most backends support
            // writing to _meta directly. We implement setMetaField in azure.js.
        }
        res.json({ fileId: id, size: buf.length, hash: result.hash });
    } catch(e) {
        console.error('v2 put error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/v2/file/:fileId
app.delete('/api/v2/file/:fileId', async (req, res) => {
    const id = req.params.fileId;
    if (!FILE_ID_RE.test(id)) return res.status(400).json({ error: 'bad fileId' });
    try {
        if (typeof storage.deleteName === 'function') {
            await storage.deleteName('v2/' + id);
        }
        res.json({ ok: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/v2/index → list of {fileId, encName, size, updatedAt}
// The server does not decrypt anything. Clients filter this list
// against their localStorage recent-files to render the sidebar.
app.get('/api/v2/index', async (req, res) => {
    try {
        const items = typeof storage.listNames === 'function'
            ? await storage.listNames() : [];
        const v2 = [];
        for (const it of items) {
            if (it.name && it.name.startsWith('v2/')) {
                const fileId = it.name.substring(3);
                if (FILE_ID_RE.test(fileId)) {
                    v2.push({
                        fileId,
                        encName: it.encName || null,
                        size: it.size,
                        updatedAt: it.updatedAt,
                    });
                }
            }
        }
        res.json(v2);
    } catch(e) {
        console.error('v2 index error:', e.message);
        res.status(500).json({ error: e.message });
    }
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
