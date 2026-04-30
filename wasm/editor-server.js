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

// Content-hashed asset filenames are baked in at build time by
// wasm/tools/cache-bust-build.js — that step renames each long-cacheable
// asset to <base>.<hash>.<ext>, renames its .br sidecar alongside, and
// rewrites cool.html (asset refs + Module.locateFile shim ahead of
// online.js). At runtime this server only has to set cache headers and
// stream files. The HASHED_RE pattern matches the build-time naming so
// hashed responses get max-age=1y immutable.
const HASHED_RE = /\.[0-9a-f]{8}\.(?:js|css|wasm|data|metadata)$/;

const app = express();

// Cache headers (runs before the brotli chooser so the chosen response
// carries cache info):
//   - sw.js → no-cache. The Service Worker updates itself by re-fetching
//     this file on every navigation; if it's frozen by max-age the fix
//     for any SW bug would never reach existing clients.
//   - HTML → no-cache (cool.html does template substitution; never stale-OK).
//   - WASM payloads + bundled JS → immutable, 1y. Browser HTTP cache will
//     try its best; the SW (sw.js) backstops with Cache Storage when the
//     HTTP cache evicts under pressure.
app.use((req, res, next) => {
    if (req.path.endsWith('/sw.js') || req.path === '/sw.js') {
        res.setHeader('Cache-Control', 'no-cache');
    } else if (HASHED_RE.test(req.path)) {
        // Content-hashed asset: hash changes when content changes,
        // so the URL itself is a version. Cache forever.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (/\.(wasm|data|js\.metadata)$/.test(req.path)) {
        // Belt-and-braces: any unhashed wasm/data/metadata still gets
        // immutable headers. Build-time hashing should rename them, so
        // this branch is only hit by old-cool.html clients pointing at
        // the unhashed name during a deploy window.
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
// The editor runs inside an iframe on the viewer domain, so cool.html and
// all its subresources must be loadable cross-origin. We therefore set
// CORP:cross-origin. Once cool.html is loaded, every subresource it fetches
// (bundle.js, online.wasm, /wasm/:name, etc.) is same-origin with the
// iframe document, so COEP:require-corp is satisfied by our own CORP header.
app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
});

// Favicon — return empty 204 to silence the 404 in logs.
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ── Brotli chooser ──────────────────────────────────────────────
// Deploy-time pre-compression (wasm/tools/precompress-br.js) writes a
// <file>.br next to each large asset. If the client sends
// `Accept-Encoding: br`, serve that and advertise Content-Encoding: br.
// We deliberately avoid runtime compression — brotli-11 of a 260MB wasm
// is ~60s of CPU per request, which would melt the App Service.
//
// MUST run AFTER the CORS/COEP/CORP middlewares above so the streamed
// response inherits those headers — otherwise workers and fetches get
// ERR_BLOCKED_BY_RESPONSE when cross-origin isolation is enforced.
const BR_MIME = {
    '.wasm': 'application/wasm',
    '.data': 'application/octet-stream',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.metadata': 'application/octet-stream',
    '.html': 'text/html; charset=utf-8',
};
function mimeFor(p) {
    if (p.endsWith('.js.metadata')) return BR_MIME['.metadata'];
    return BR_MIME[path.extname(p)] || 'application/octet-stream';
}
app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const ae = req.headers['accept-encoding'] || '';
    if (!ae.includes('br')) return next();
    const urlPath = req.path.split('?')[0];
    if (!/\.(wasm|data|js|css|metadata)$/.test(urlPath)) return next();

    // Resolve request path → on-disk .br file. Both /browser/* and
    // root-level paths (/online.wasm etc.) are served by this app so
    // we check both layouts. The build step renames hashed assets in
    // place (bundle.js → bundle.<hash>.js) and renames the .br sidecar
    // alongside, so a direct `+ '.br'` lookup finds it without any
    // symlink chasing.
    const candidates = [];
    if (urlPath.startsWith('/browser/')) {
        candidates.push(path.join(BROWSER_DIST, urlPath.slice('/browser/'.length) + '.br'));
    } else {
        candidates.push(path.join(WASM_DIR, urlPath + '.br'));
        candidates.push(path.join(BROWSER_DIST, urlPath + '.br'));
    }
    for (const f of candidates) {
        if (fs.existsSync(f)) {
            const stat = fs.statSync(f);
            res.setHeader('Content-Encoding', 'br');
            res.setHeader('Content-Type', mimeFor(urlPath));
            res.setHeader('Content-Length', stat.size);
            res.setHeader('Vary', 'Accept-Encoding');
            fs.createReadStream(f).pipe(res);
            return;
        }
    }
    next();
});

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

// ── cool.html with template substitution ────────────────────────
// Replaces %ACCESS_TOKEN%, %BRANDING_THEME%, etc. with values from POST
// body (or empty strings). Without substitution the iframe tries to
// fetch document URLs containing the literal "%ACCESS_TOKEN%" which 404s.
//
// Asset references (bundle.js → bundle.<hash>.js etc.), the integrator
// branding strip, and the Module.locateFile shim are baked in at build
// time by wasm/tools/cache-bust-build.js — this server no longer rewrites
// HTML beyond the per-request token substitution.
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

// ── Static: browser assets (bundle.<hash>.js, images, etc.) ──────
// fallthrough: true (default) means missing files fall through to our
// final 404 handler which returns plain text (not HTML).
//
// serve-static overwrites Cache-Control via its `maxAge` option *after*
// our cache-control middleware runs, so the long-cache decision needs
// to be re-applied here via setHeaders. Hashed names (bundle.<hash>.js
// etc.) and *.wasm/*.data/*.js.metadata get max-age=1y immutable; the
// rest fall back to the regular 1h shelf life.
app.use('/browser', express.static(BROWSER_DIST, {
    maxAge: '1h',
    setHeaders: (res, filepath) => {
        if (HASHED_RE.test(filepath) || /\.(wasm|data|js\.metadata)$/.test(filepath)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    },
}));

// ── Static: /dicts/<lang>.tar.gz + /dicts/manifest.json ──────────
// Lazy-loaded spellcheck dictionaries. dict-loader.js on the client
// resolves /dicts/ relative to its own script URL, which lands here
// on the editor origin. Cached aggressively — each bundle is effectively
// immutable (filename carries no hash, but the server-side manifest
// can be refreshed on a rebuild).
const DICTS_DIR = fs.existsSync(path.join(__dirname, 'dicts'))
    ? path.join(__dirname, 'dicts')
    : path.join(__dirname, '..', 'dicts');
app.use('/dicts', express.static(DICTS_DIR, {
    maxAge: '7d',
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.tar.gz')) {
            res.setHeader('Content-Type', 'application/gzip');
        } else if (filePath.endsWith('.json')) {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-cache'); // manifest may rotate
        }
    },
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
