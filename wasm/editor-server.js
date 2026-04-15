// Editor App server for COOL WASM co-editing.
// Serves static browser assets (cool.html, bundle.js, CSS, images)
// and WASM artifacts (online.wasm, online.data, soffice.data).
// Accepts temporary file uploads at POST /wasm/:name so the viewer
// iframe flow can push a document for the WASM to load.
//
// Does server-side template substitution on cool.html (replaces
// %ACCESS_TOKEN%, %BRANDING_THEME%, etc. with values from POST body
// or empty strings).

const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 6932;

// In deployed package, browser/dist is alongside server.js.
// In development, it's at ../browser/dist relative to wasm/.
const BROWSER_DIST = fs.existsSync(path.join(__dirname, 'browser', 'dist'))
    ? path.join(__dirname, 'browser', 'dist')
    : path.join(__dirname, '..', 'browser', 'dist');
const WASM_DIR     = path.join(__dirname);
const UPLOAD_DIR   = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();

app.use(compression());

// Cache headers: immutable for large assets, no-cache for HTML
app.use((req, res, next) => {
    if (/\.(wasm|data|js\.metadata)$/.test(req.path)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (/\.html$/.test(req.path) || req.path === '/') {
        res.setHeader('Cache-Control', 'no-cache');
    }
    next();
});

// CORS — viewer on a different domain pushes file uploads to /wasm/:name.
// Defaults to FILE_STORAGE_URL (the only origin that legitimately POSTs files).
// Override with ALLOWED_ORIGINS as a comma-separated list, or `*` to disable.
const FILE_STORAGE_URL = process.env.FILE_STORAGE_URL || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || FILE_STORAGE_URL)
    .split(',').map(s => s.trim()).filter(Boolean);
const ALLOW_ANY = ALLOWED_ORIGINS.length === 1 && ALLOWED_ORIGINS[0] === '*';

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

// Cross-origin isolation — required for SharedArrayBuffer (WASM threads).
// All resources served by this app are same-origin with cool.html and
// get CORP:same-origin. The document content loaded from /wasm/:name
// is also same-origin. No cross-origin fetches happen once cool.html
// is loaded, so COEP:require-corp is safe.
app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
});

// Favicon — return empty 204 to silence the 404 in logs.
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Parse form-urlencoded body (needed to read access_token from editor.html form POST)
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ── POST /wasm/:name — temp file upload from viewer ─────────────
// Strips query string so filenames with ?access_token=... work too.
app.post('/wasm/:name', (req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
        const data = Buffer.concat(chunks);
        const fileName = req.params.name.split('?')[0];
        const filePath = path.join(UPLOAD_DIR, fileName);
        fs.writeFileSync(filePath, data);
        res.json({ name: fileName, size: data.length });
    });
});

// ── GET /wasm/:name — serve uploaded temp files ─────────────────
app.get('/wasm/:name', (req, res) => {
    const fileName = req.params.name.split('?')[0];
    const filePath = path.join(UPLOAD_DIR, fileName);
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
    res.sendFile(filePath);
});

// ── Static: WASM artifacts at root level ────────────────────────
const wasmFiles = ['online.wasm', 'online.data', 'online.js', 'online.worker.js',
                   'soffice.data', 'soffice.data.js.metadata',
                   'relay-adapter.js', 'wasm-loader.js'];
for (const f of wasmFiles) {
    app.get('/' + f, (req, res) => {
        const filePath = path.join(WASM_DIR, f);
        if (!fs.existsSync(filePath)) return res.status(404).send(f + ' not found');
        res.sendFile(filePath);
    });
}

// ── cool.html with template substitution ─────────────────────────
// Replaces %ACCESS_TOKEN%, %BRANDING_THEME%, etc. with values from POST
// body (or empty strings). Without substitution, WASM tries to fetch
// document URLs containing literal "%ACCESS_TOKEN%" which fails.
function serveCoolHtml(req, res) {
    const coolHtml = path.join(BROWSER_DIST, 'cool.html');
    if (!fs.existsSync(coolHtml)) return res.status(404).send('cool.html not built');

    let html = fs.readFileSync(coolHtml, 'utf8');

    const accessToken = req.body?.access_token || req.query?.access_token || '';
    const accessTokenTtl = req.body?.access_token_ttl || req.query?.access_token_ttl || '0';
    const accessHeader = req.body?.access_header || '';
    const noAuthHeader = req.body?.no_auth_header || '';
    const uiRtl = req.body?.ui_rtl_settings || '';

    const subs = {
        '%ACCESS_TOKEN%':          accessToken,
        '%ACCESS_TOKEN_TTL%':      accessTokenTtl,
        '%ACCESS_HEADER%':         accessHeader,
        '%NO_AUTH_HEADER%':        noAuthHeader,
        '%UI_RTL_SETTINGS%':       uiRtl,
        '%BRANDING_THEME%':        '',
        '%LOGO_URL%':              '',
        '%PRODUCT_BRANDING_NAME%': 'Collabora Online',
    };

    for (const [key, val] of Object.entries(subs)) {
        html = html.split(key).join(val);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
}
app.get('/browser/cool.html',  serveCoolHtml);
app.post('/browser/cool.html', serveCoolHtml);

// ── Static: browser assets (bundle.js, bundle.css, images, etc.) ─
// fallthrough: true (default) means missing files fall through to our
// final 404 handler which returns plain text (not HTML).
app.use('/browser', express.static(BROWSER_DIST, {
    maxAge: '1h',
}));

// 404 for anything under /browser/ that didn't match a file above.
// Plain text so browser doesn't try to interpret as CSS/JS.
app.use('/browser', (req, res) => {
    res.status(404).type('text/plain').send('Not found: /browser' + req.path);
});

// ── Health check ────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.send('COOL WASM Editor App');
});

// ── 404 handler — explicit plain-text response ──────────────────
app.use((req, res) => {
    res.status(404).type('text/plain').send('Not found: ' + req.path);
});

app.listen(PORT, () => {
    console.log(`Editor server on port ${PORT}`);
    console.log(`  Browser dist: ${BROWSER_DIST}`);
    console.log(`  WASM dir:     ${WASM_DIR}`);
    console.log(`  Uploads:      ${UPLOAD_DIR}`);
});
