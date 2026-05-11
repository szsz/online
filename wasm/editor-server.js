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

// ── Per-deploy folder prefix ────────────────────────────────────────
// Each editor build deploys into ${wwwroot}/<APP_BUILD_ID>/ so multiple
// deploys coexist on the same origin without filename hashing. URLs
// arrive shaped like `/<id>/browser/cool.html` or `/<id>/online.wasm`;
// the middleware below detects the prefix, stashes the id on req, and
// rewrites req.url so downstream route handlers see the unprefixed
// path. The file-path helpers (browserDistFor / wasmDirFor / dictsDirFor)
// then route file lookups into the matching <id>/ subfolder.
//
// When req.url has no prefix (local dev with a flat editor layout, or
// hand-typed root-level URLs), req.deployId stays undefined and the
// helpers fall back to the flat BROWSER_DIST / WASM_DIR / DICTS_DIR.
// Match per-deploy folder prefix. Two id flavours:
//   YYYY-MM-DD-HHMMSS              — Azure / production deploy
//   local-YYYY-MM-DD-HHMMSS         — wasm-ci-local deploys; the local-
//                                     prefix sorts them under a separate
//                                     namespace at coolwasmfiles.
// Both must round-trip through the prefix-stripping middleware.
const DEPLOY_ID_RE = /^\/((?:local-)?\d{4}-\d{2}-\d{2}-\d{6})(?:\/|$)/;
const DEPLOY_ID_BARE_RE = /^(?:local-)?\d{4}-\d{2}-\d{2}-\d{6}$/;
function browserDistFor(req) {
    return req.deployId
        ? path.join(__dirname, req.deployId, 'browser', 'dist')
        : BROWSER_DIST;
}
function wasmDirFor(req) {
    return req.deployId ? path.join(__dirname, req.deployId) : WASM_DIR;
}
function dictsDirFor(req) {
    // DICTS_DIR is declared further down (path varies by layout); but
    // by deploy-time the dicts live at <id>/dicts/ for per-deploy or
    // ./dicts/ for flat. Resolve both here so we don't bind at module-
    // load time.
    if (req.deployId) return path.join(__dirname, req.deployId, 'dicts');
    return fs.existsSync(path.join(__dirname, 'dicts'))
        ? path.join(__dirname, 'dicts')
        : path.join(__dirname, '..', 'dicts');
}

// Content-hashed asset filenames are baked in at build time by
// wasm/tools/cache-bust-build.js — that step renames each long-cacheable
// asset to <base>.<hash>.<ext>, renames its .br sidecar alongside, and
// rewrites cool.html (asset refs + Module.locateFile shim ahead of
// online.js). At runtime this server only has to set cache headers and
// stream files. The HASHED_RE pattern matches the build-time naming so
// hashed responses get max-age=1y immutable.
const HASHED_RE = /\.[0-9a-f]{8}\.(?:js|css|wasm|data|metadata)$/;

const app = express();

// ── Per-deploy prefix stripper ──────────────────────────────────
// Detect /<APP_BUILD_ID>/ at the start of req.url; set req.deployId
// and rewrite req.url so all downstream middleware and route handlers
// see the unprefixed path. File-path helpers above use req.deployId to
// route reads into the matching <id>/ subfolder.
//
// When no explicit prefix is present but DEFAULT_DEPLOY_ID env is set
// (the CI deploy populates it with the just-deployed id), fall back to
// it — so legacy unprefixed URLs (`/browser/cool.html`, `/online.wasm`)
// still resolve into the current deploy's subfolder. This is what lets
// the existing test suite keep hitting flat URLs without per-test
// migration: the editor transparently routes to the latest deploy.
// Explicit `/<id>/...` URLs always win — the viewer's iframe URL uses
// the explicit form via `window.__CONFIG.EDITOR_DEPLOY_ID`.
//
// MUST run before every other middleware so cache-headers / CORS /
// COOP-COEP / brotli all see the rewritten req.path and treat the
// per-deploy variant identically to the flat-layout request.
const DEFAULT_DEPLOY_ID = (process.env.DEFAULT_DEPLOY_ID || '').trim();
if (DEFAULT_DEPLOY_ID && !DEPLOY_ID_BARE_RE.test(DEFAULT_DEPLOY_ID)) {
    console.warn('[editor-server] DEFAULT_DEPLOY_ID=' + DEFAULT_DEPLOY_ID
                + ' does not match [local-]YYYY-MM-DD-HHMMSS — ignoring');
}
const DEFAULT_DEPLOY_ID_VALID =
    DEFAULT_DEPLOY_ID && DEPLOY_ID_BARE_RE.test(DEFAULT_DEPLOY_ID);
app.use((req, res, next) => {
    const m = req.url.match(DEPLOY_ID_RE);
    if (m) {
        req.deployId = m[1];
        // Strip the prefix but keep a leading slash so downstream route
        // patterns like '/browser/cool.html' still match. "/<id>/foo"
        // becomes "/foo"; bare "/<id>" becomes "/".
        const remainder = req.url.slice(m[0].length - 1);
        req.url = remainder || '/';
    } else if (DEFAULT_DEPLOY_ID_VALID) {
        // Unprefixed URL + a configured default: route through the
        // default's folder without modifying req.url (caller didn't
        // ask for a prefix, so we don't add one to req.url either —
        // the file lookup is done via wasmDirFor / browserDistFor).
        req.deployId = DEFAULT_DEPLOY_ID;
    }
    next();
});

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

// Per-deploy build-info.json — small JSON written by the deploy step
// alongside each <id>/ folder. `${EDITOR}/<id>/build-info.json` is what
// the per-deploy-folder regression test probes to confirm a deploy
// happened and to read its metadata (id, git sha, deploy timestamp).
// In flat mode (no prefix) the file doesn't exist; 404 is correct.
app.get('/build-info.json', (req, res) => {
    const f = path.join(wasmDirFor(req), 'build-info.json');
    if (!fs.existsSync(f)) return res.status(404).type('text/plain').send('build-info.json not found');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(f);
});

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
        candidates.push(path.join(browserDistFor(req), urlPath.slice('/browser/'.length) + '.br'));
    } else {
        candidates.push(path.join(wasmDirFor(req), urlPath + '.br'));
        candidates.push(path.join(browserDistFor(req), urlPath + '.br'));
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
// In per-deploy mode (req.deployId set by the prefix-stripper above),
// each of these resolves under wasmDirFor(req) which routes into the
// matching <id>/ subfolder.
const wasmFiles = ['online.wasm', 'online.data', 'online.js', 'online.worker.js',
                   'soffice.data', 'soffice.data.js.metadata',
                   'relay-adapter.js', 'wasm-loader.js'];
for (const f of wasmFiles) {
    app.get('/' + f, (req, res) => {
        const filePath = path.join(wasmDirFor(req), f);
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
// Iter 53: cache the no-token-substitution variant. The vast majority
// of requests are GETs with no body params, all of which produce the
// same output (every %TOKEN% → empty/branding default). readFileSync
// + 8 split/join passes is cheap individually but gets called 100s of
// times per page load, and warm-snapshot deploys want the cool.html
// response to be as cheap as possible since the *next* page-load JS
// is what we want occupying the CPU. Cache invalidates when the file
// mtime rolls (each deploy bumps it).
// Cache the no-token-substitution body per cool.html source path so
// per-deploy folders each get their own cache entry. The key is the
// absolute file path (works for both flat and per-deploy layouts).
const _coolCache = new Map(); // path -> { mtimeMs, body }
function serveCoolHtml(req, res) {
    const coolHtml = path.join(browserDistFor(req), 'cool.html');
    if (!fs.existsSync(coolHtml)) return res.status(404).send('cool.html not built');

    const accessToken = req.body?.access_token || req.query?.access_token || '';
    const accessTokenTtl = req.body?.access_token_ttl || req.query?.access_token_ttl || '0';
    const accessHeader = req.body?.access_header || '';
    const noAuthHeader = req.body?.no_auth_header || '';
    const uiRtl = req.body?.ui_rtl_settings || '';
    const noSubs = !accessToken && !accessHeader && !noAuthHeader && !uiRtl
                && (accessTokenTtl === '0' || accessTokenTtl === '');

    if (noSubs) {
        const stat = fs.statSync(coolHtml);
        let entry = _coolCache.get(coolHtml);
        if (!entry || entry.mtimeMs !== stat.mtimeMs) {
            let html = fs.readFileSync(coolHtml, 'utf8');
            // Empty-token substitution variant — bake the static result.
            html = html
                .split('%ACCESS_TOKEN%').join('')
                .split('%ACCESS_TOKEN_TTL%').join('0')
                .split('%ACCESS_HEADER%').join('')
                .split('%NO_AUTH_HEADER%').join('')
                .split('%UI_RTL_SETTINGS%').join('')
                .split('%BRANDING_THEME%').join('')
                .split('%LOGO_URL%').join('')
                .split('%PRODUCT_BRANDING_NAME%').join('Collabora Online');
            entry = { mtimeMs: stat.mtimeMs, body: html };
            _coolCache.set(coolHtml, entry);
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(entry.body);
    }

    // Token-bearing request — full substitution (rare path, e.g. when
    // hosted by a WOPI integrator that POSTs the cool.html access token).
    let html = fs.readFileSync(coolHtml, 'utf8');
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
// In per-deploy mode the underlying static root varies by req.deployId
// (`browserDistFor(req)`). We cache one express.static handler per
// (deploy-id || flat) so the handler config doesn't get re-created on
// every request, but each deploy lives in its own self-contained tree.
// The cache key is the deploy-id (empty string for flat). Map entries
// are tiny (a closure + a few options), so unbounded growth as new
// deploys appear is acceptable.
//
// serve-static overwrites Cache-Control via its `maxAge` option *after*
// our cache-control middleware runs, so the long-cache decision needs
// to be re-applied here via setHeaders. Hashed names (bundle.<hash>.js
// etc.) and *.wasm/*.data/*.js.metadata get max-age=1y immutable; the
// rest fall back to the regular 1h shelf life.
const _browserStaticCache = new Map();
function browserStaticFor(req) {
    const key = req.deployId || '';
    let handler = _browserStaticCache.get(key);
    if (!handler) {
        handler = express.static(browserDistFor(req), {
            maxAge: '1h',
            setHeaders: (res, filepath) => {
                if (HASHED_RE.test(filepath) || /\.(wasm|data|js\.metadata)$/.test(filepath)) {
                    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                }
            },
        });
        _browserStaticCache.set(key, handler);
    }
    return handler;
}
app.use('/browser', (req, res, next) => browserStaticFor(req)(req, res, next));

// ── Static: /dicts/<lang>.tar.gz + /dicts/manifest.json ──────────
// Lazy-loaded spellcheck dictionaries. dict-loader.js on the client
// resolves /dicts/ relative to its own script URL, which lands here
// on the editor origin. Cached aggressively — each bundle is effectively
// immutable (filename carries no hash, but the server-side manifest
// can be refreshed on a rebuild).
//
// Like /browser/ above, per-deploy mode routes the dicts root via
// `dictsDirFor(req)` and we cache one handler per deploy-id key.
const _dictsStaticCache = new Map();
function dictsStaticFor(req) {
    const key = req.deployId || '';
    let handler = _dictsStaticCache.get(key);
    if (!handler) {
        handler = express.static(dictsDirFor(req), {
            maxAge: '7d',
            setHeaders: (res, filePath) => {
                if (filePath.endsWith('.tar.gz')) {
                    res.setHeader('Content-Type', 'application/gzip');
                } else if (filePath.endsWith('.json')) {
                    res.setHeader('Content-Type', 'application/json');
                    res.setHeader('Cache-Control', 'no-cache'); // manifest may rotate
                }
            },
        });
        _dictsStaticCache.set(key, handler);
    }
    return handler;
}
app.use('/dicts', (req, res, next) => dictsStaticFor(req)(req, res, next));

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
