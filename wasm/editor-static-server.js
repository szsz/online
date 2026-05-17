// Editor static server — serves the WASM editor (cool.html + bundle.js +
// online.wasm + soffice.data + …) and accepts document uploads at
// /wasm/<name>. Sits behind the SNI router on wasm.atgpartners.info.
//
// Configurable via env (defaults match the on-host setup):
//   PUB                  static asset root        (default: /tmp/static-deploy/public)
//   DOCS                 transient doc-upload dir (default: /tmp/static-deploy/.wasm-docs)
//   HTTP_PORT            plain HTTP port          (default: 6931)
//   HTTPS_PORT           HTTPS port               (default: 6932)
//   SSL_CERT, SSL_KEY    PEM paths; if both set + readable, listen HTTPS
//   FILE_STORAGE_URL     viewer origin, used for CSP frame-ancestors
//                        (default: https://viewer.szebeni.hu)
//
// Caching contract (matters when troubleshooting "the WASM redownloads
// every time"):
//   - HTML responses    → Cache-Control: no-cache (always revalidate)
//   - online.wasm/data  → Cache-Control: public, max-age=31536000, immutable
//   - other assets      → Cache-Control: public, max-age=3600
//   - All responses include ETag (size-mtime) and Last-Modified.
//   - Conditional GET honours BOTH If-None-Match AND If-Modified-Since
//     (some clients send only one) — both produce a body-less 304.
//   - Brotli is preferred when the client sends Accept-Encoding: br and a
//     `<file>.br` sibling exists.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PUB              = process.env.PUB              || '/tmp/static-deploy/public';
const DOCS             = process.env.DOCS             || '/tmp/static-deploy/.wasm-docs';
const HTTP_PORT        = parseInt(process.env.HTTP_PORT  || '6931', 10);
const HTTPS_PORT       = parseInt(process.env.HTTPS_PORT || '6932', 10);
const SSL_CERT         = process.env.SSL_CERT         || '';
const SSL_KEY          = process.env.SSL_KEY          || '';
const FILE_STORAGE_URL = process.env.FILE_STORAGE_URL;
if (!FILE_STORAGE_URL) {
    console.error('ERROR: FILE_STORAGE_URL env not set — needed for CSP frame-ancestors. '
        + 'Source the matching ~/ENV/online*.env before launching, or pass it inline.');
    process.exit(1);
}

fs.mkdirSync(DOCS, { recursive: true });

// Periodic cleanup of /wasm/ doc storage. Each test uploads a unique
// file (named by sha256 in v2). Without cleanup the directory
// accumulates thousands of files over a week of CI runs (~1 GB seen
// in practice) and the disk reads to serve fresh tests slow down.
// Files older than 2 hours are deleted every 30 min.
setInterval(() => {
    try {
        const cutoff = Date.now() - 2 * 60 * 60 * 1000;
        let removed = 0;
        for (const name of fs.readdirSync(DOCS)) {
            const fp = `${DOCS}/${name}`;
            try {
                if (fs.statSync(fp).mtimeMs < cutoff) {
                    fs.unlinkSync(fp);
                    removed++;
                }
            } catch (_) {}
        }
        if (removed > 0) {
            console.log(`[editor-static] reaped ${removed} doc(s) older than 2h`);
        }
    } catch (_) {}
}, 30 * 60 * 1000);

// Content-hashed asset filenames + cool.html rewriting are baked in at
// build/deploy time by wasm/tools/cache-bust-build.js. This server only
// has to set cache headers and stream files — anything matching
// HASHED_RE (<base>.<8 hex>.<ext>) gets served immutable.
const HASHED_RE = /\.[0-9a-f]{8}\.(?:js|css|wasm|data|metadata)$/;

// ── Per-deploy folder prefix ────────────────────────────────────
// Mirrors editor-server.js. Each editor build deploys into
// $PUB/<APP_BUILD_ID>/. URLs shaped `/<id>/...` route file lookups into
// that subfolder; unprefixed URLs route via the "current" pointer
// (resolved at request time from $PUB/current-deploy.txt, which the
// deploy step writes). Server-side endpoints (/wasm/, /reports/,
// /clipboard) stay flat at $PUB/$DOCS — they're not per-deploy.
//
// We resolve from a file (not env) so a CI deploy can flip the pointer
// without restarting the server. The file is small (one line), and
// fs.statSync is cheap (~µs); we mtime-cache the parsed id to avoid
// reparsing on every request. The DEFAULT_DEPLOY_ID env var, if set,
// is used as a bootstrap fallback before the pointer file exists.
// Match per-deploy folder prefix. Two id flavours:
//   YYYY-MM-DD-HHMMSS              — Azure / production deploy
//   local-YYYY-MM-DD-HHMMSS         — wasm-ci-local deploys; the local-
//                                     prefix sorts them under a separate
//                                     namespace at coolwasmfiles.
// Both round-trip through the prefix-stripping middleware below.
const DEPLOY_ID_RE = /^\/((?:local-)?\d{4}-\d{2}-\d{2}-\d{6})(?:\/|$)/;
const DEPLOY_ID_BARE_RE = /^(?:local-)?\d{4}-\d{2}-\d{2}-\d{6}$/;
const POINTER_FILE = path.join(PUB, 'current-deploy.txt');
const _pointerCache = { mtimeMs: 0, id: '' };
function readDefaultDeployId() {
    try {
        const stat = fs.statSync(POINTER_FILE);
        if (_pointerCache.mtimeMs !== stat.mtimeMs) {
            const raw = fs.readFileSync(POINTER_FILE, 'utf8').trim();
            _pointerCache.mtimeMs = stat.mtimeMs;
            _pointerCache.id = DEPLOY_ID_BARE_RE.test(raw) ? raw : '';
        }
        return _pointerCache.id;
    } catch (_) {
        // Pointer file missing: bootstrap from env (e.g. when the
        // server was started before the first per-deploy ran).
        const env = (process.env.DEFAULT_DEPLOY_ID || '').trim();
        return DEPLOY_ID_BARE_RE.test(env) ? env : '';
    }
}

// Iter 58: in-memory cache for cool.html. Read once, hold the bytes,
// invalidate on mtime change. Every iframe load hits this path so even
// the small readFileSync (~30 KB) shows up under load.
// Per-deploy mode: multiple cool.html files at different paths, so the
// cache is keyed on the resolved filepath.
const _coolCache = new Map(); // filepath -> { mtimeMs, body, etag }

// SIGHUP is no-op now (used to trigger runtime rehashing). Kept as a
// handler so the default SIGHUP-kills-process behaviour doesn't tear
// down the running server when deploy.sh signals it post-build.
process.on('SIGHUP', () => {
    console.log('SIGHUP — no-op (assets are hashed at build time)');
});

const MIME = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.wasm': 'application/wasm',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ttf': 'font/ttf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ico': 'image/x-icon',
};

// Files whose URL never changes for a given content (we redeploy in place
// and ETag picks up the change, so the URL is stable but the cached body
// might need invalidating). max-age=31536000 + immutable says "trust the
// cache forever, never even revalidate" — Chrome will skip the conditional
// GET entirely for these on most navigations.
const IMMUTABLE = [
    'online.wasm',
    'soffice.data',
    'online.js',
    'online.worker.js',
    'bundle.js',
    'bundle.css',
    'soffice.data.js.metadata',
    'global.js',
];

function setCommonHeaders(res) {
    // SharedArrayBuffer requires cross-origin isolation. The iframe inside
    // the viewer needs COEP+CORP to be allowed in a COEP-isolated parent.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    // CSP frame-ancestors only matters for HTML documents loaded as iframes;
    // but it's harmless on other responses and keeps a single header set.
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self' " + FILE_STORAGE_URL);
    // CORS — the viewer POSTs documents into /wasm/ from a different origin.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function handler(req, res) {
    setCommonHeaders(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const parsed = url.parse(req.url);
    // Malformed percent-encoding throws URIError; degrade to raw pathname
    // instead of letting Node's uncaughtException fire and leave the
    // request hanging (which detaches puppeteer iframes mid-test).
    let pathname;
    try {
        pathname = decodeURIComponent(parsed.pathname);
    } catch (_) {
        pathname = parsed.pathname;
    }

    // Per-deploy: if the URL starts with /<id>/, strip the prefix and
    // route file lookups into $PUB/<id>/. If no prefix but a default
    // deploy id is configured (via $PUB/current-deploy.txt written by
    // the deploy step), use that. Server-side endpoints below (/wasm/,
    // /reports/, /clipboard) continue to use PUB/DOCS — they are not
    // per-deploy and ignore effectivePub.
    let effectivePub = PUB;
    const __prefixMatch = pathname.match(DEPLOY_ID_RE);
    if (__prefixMatch) {
        effectivePub = path.join(PUB, __prefixMatch[1]);
        pathname = pathname.slice(__prefixMatch[0].length - 1) || '/';
    } else {
        const defaultId = readDefaultDeployId();
        if (defaultId) effectivePub = path.join(PUB, defaultId);
    }

    // /collabora-online-mobile/cool/clipboard — COOL's Clipboard.js in
    // WASM mode POSTs clipboard data here so the upload→paste cycle works
    // for external rich-text paste. Simple in-memory store keyed by Tag.
    // Handle both paths: COOL resolves the relative URL differently
    // depending on context — POST comes from JS as a relative URL,
    // GET comes from fetch inside cool.html at /browser/cool.html.
    if (pathname.startsWith('/collabora-online-mobile/cool/clipboard') ||
        pathname.startsWith('/browser/collabora-online-mobile/cool/clipboard')) {
        const qs = parsed.query || '';
        const tag = (qs.match(/Tag=([^&]+)/) || [])[1] || 'default';
        if (req.method === 'POST') {
            const chunks = [];
            req.on('data', c => chunks.push(c));
            req.on('end', () => {
                if (!handler._clipStore) handler._clipStore = new Map();
                handler._clipStore.set(tag, Buffer.concat(chunks));
                setTimeout(() => handler._clipStore && handler._clipStore.delete(tag), 60000);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{"ok":true}');
            });
            return;
        }
        if (req.method === 'GET') {
            const data = handler._clipStore && handler._clipStore.get(tag);
            if (!data) { res.writeHead(404); res.end('No clipboard'); return; }
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length });
            res.end(data);
            return;
        }
    }

    // /wasm/ — transient document storage for the editor's WOPI loader.
    // Uploaded by the viewer; read by the WASM editor at open time.
    if (pathname.startsWith('/wasm/')) {
        // Strip any query template that slipped through the URL builder.
        let name = pathname.substring(6).split('?')[0].split('&')[0];
        const filepath = path.join(DOCS, path.basename(name));
        if (req.method === 'POST') {
            const chunks = [];
            req.on('data', c => chunks.push(c));
            req.on('end', () => {
                fs.writeFileSync(filepath, Buffer.concat(chunks));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, size: fs.statSync(filepath).size }));
            });
            return;
        }
        if (req.method === 'GET') {
            if (!fs.existsSync(filepath)) { res.writeHead(404); res.end('Not found'); return; }
            const data = fs.readFileSync(filepath);
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': data.length,
            });
            res.end(data);
            return;
        }
    }

    // /reports/ — serve test reports from PUB.
    // (/timing-report/ removed with test-timing-report.js — superseded by
    // test-snapshot-milestones.js, served via the viewer at /report/.)
    if (pathname.startsWith('/reports/')) {
        let filepath = path.join(PUB, pathname);
        // Resolve directory to index.html
        try { if (fs.statSync(filepath).isDirectory()) filepath = path.join(filepath, 'index.html'); } catch(e) {}
        if (!fs.existsSync(filepath)) { res.writeHead(404); res.end(); return; }
        const ext = path.extname(filepath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
        res.end(fs.readFileSync(filepath));
        return;
    }

    // Per-deploy build-info.json — for the regression test that probes
    // ${EDITOR}/<id>/build-info.json. Lives at the root of each <id>/
    // folder (effectivePub). In flat mode (no deploy-id prefix and no
    // default), the file doesn't exist and 404 falls through naturally.
    if (pathname === '/build-info.json') {
        const bi = path.join(effectivePub, 'build-info.json');
        if (fs.existsSync(bi)) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
            res.end(fs.readFileSync(bi));
            return;
        }
        // fall through to generic 404
    }

    // Default: serve from effectivePub (and special-case `/` → editor.html).
    if (pathname === '/') pathname = '/editor.html';
    if (pathname === '/editor.html') {
        const p = path.join(effectivePub, 'browser/editor.html');
        if (fs.existsSync(p)) {
            res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
            res.end(fs.readFileSync(p));
            return;
        }
    }

    // cool.html is served with template-placeholder substitution baked
    // in at read time. The COOL build emits placeholders %ACCESS_TOKEN%,
    // %ACCESS_TOKEN_TTL%, %BRANDING_THEME%, etc.; the pre-FD editor-
    // server.js did this per-request, deploy-front-door.sh does it via
    // sed at upload time for the FD path. This server is the third path
    // (local dev box + CI Phase 1's locally-launched stack) — without
    // the substitution, the kit reads cool.html, finds a literal
    // "%ACCESS_TOKEN%", appends it to the document fetch URL, and the
    // resulting `/wasm/<id>?access_token=%ACCESS_TOKEN%&access_token_ttl=
    // %ACCESS_TOKEN_TTL%` returns 404. That hangs the kit at
    // COOLWSD::run() entry, which is the kit-paint failure cluster
    // (chart, caching, e2e-upload, singleuser, pptx-viewer,
    // snapshot-milestones — ~25 tests) we've been hunting through 3+
    // iterations. Defaults match deploy-front-door.sh's sed args.
    //
    // Iter 58 baseline: in-memory cache keyed on mtime + ETag for 304
    // revalidation. Substitution happens once per mtime, cache holds
    // the substituted bytes.
    if (pathname.endsWith('/cool.html')) {
        let filepath = path.join(effectivePub, pathname);
        // Apply the same dist→bridge rewrite as the generic file branch
        // below uses. The viewer's iframe URL is always
        // /browser/dist/cool.html, but deploy.sh flattens dist/* into the
        // browser/ dir, so /browser/dist/cool.html as-is doesn't exist on
        // disk. Without this rewrite the substitution handler skips
        // (fs.existsSync=false), the request falls through to the generic
        // file branch, the file gets served WITHOUT substitution, and the
        // literal `%ACCESS_TOKEN%` placeholders end up in the kit's doc
        // fetch URL → 404 → kit exits → kit-paint failure cluster. The
        // bug landed in the previous fix because the dist→bridge rewrite
        // happened only in the generic branch; this re-applies it inside
        // the cool.html handler so substitution sees the right file.
        if ((!fs.existsSync(filepath) || !fs.statSync(filepath).isFile()) &&
            pathname.startsWith('/browser/dist/')) {
            const rewritten = '/browser/' + pathname.slice('/browser/dist/'.length);
            const alt = path.join(effectivePub, rewritten);
            if (fs.existsSync(alt) && fs.statSync(alt).isFile()) {
                filepath = alt;
            }
        }
        // Per-deploy fallback (mirrors the generic branch's flat-$PUB
        // retry): when effectivePub is a per-deploy folder and the file
        // isn't there, retry at the flat $PUB root (with the same
        // dist→bridge rewrite applied).
        if (effectivePub !== PUB &&
            (!fs.existsSync(filepath) || !fs.statSync(filepath).isFile())) {
            const flatCandidates = [
                path.join(PUB, pathname),
            ];
            if (pathname.startsWith('/browser/dist/')) {
                flatCandidates.push(path.join(PUB,
                    '/browser/' + pathname.slice('/browser/dist/'.length)));
            }
            for (const cand of flatCandidates) {
                if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
                    filepath = cand;
                    break;
                }
            }
        }
        if (fs.existsSync(filepath) && fs.statSync(filepath).isFile()) {
            const stat = fs.statSync(filepath);
            let entry = _coolCache.get(filepath);
            if (!entry || entry.mtimeMs !== stat.mtimeMs) {
                let html = fs.readFileSync(filepath, 'utf8');
                html = html
                    .split('%ACCESS_TOKEN_TTL%').join('0')
                    .split('%ACCESS_TOKEN%').join('')
                    .split('%ACCESS_HEADER%').join('')
                    .split('%NO_AUTH_HEADER%').join('')
                    .split('%UI_RTL_SETTINGS%').join('')
                    .split('%BRANDING_THEME%').join('')
                    .split('%LOGO_URL%').join('')
                    .split('%PRODUCT_BRANDING_NAME%').join('Collabora Online');
                const body = Buffer.from(html, 'utf8');
                entry = {
                    body,
                    mtimeMs: stat.mtimeMs,
                    etag: '"' + body.length.toString(16) + '-' + stat.mtimeMs.toString(16) + '"',
                };
                _coolCache.set(filepath, entry);
            }
            // Cache policy: path-keyed cool.html (under /<EDITOR_BUILD_ID>/…)
            // is immutable by construction — the URL contains the deploy
            // ID so the bytes at that URL never change. Flat-layout
            // cool.html (at /browser/cool.html) is mutated by every
            // deploy, so it stays no-cache. The path-keyed check matches
            // an 8+-digit segment that starts with a date prefix
            // (e.g. /2026-05-16-113700/...) — same shape resolve-ids.sh
            // emits. The caching test (test-caching.js Test 3) locks
            // this behaviour: path-keyed cool.html MUST include
            // 'immutable' in Cache-Control.
            const pathKeyed = /^\/\d{4}-\d{2}-\d{2}-\d+\//.test(pathname);
            const headers = {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': pathKeyed
                    ? 'public, max-age=31536000, immutable'
                    : 'no-cache',
                'ETag': entry.etag,
                'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
            };
            const ims = req.headers['if-modified-since'];
            const imsHit = ims && new Date(ims).getTime() >= Math.floor(stat.mtimeMs / 1000) * 1000;
            if (req.headers['if-none-match'] === entry.etag || imsHit) {
                res.writeHead(304, headers);
                res.end();
                return;
            }
            res.writeHead(200, headers);
            res.end(entry.body);
            return;
        }
    }

    let filepath = path.join(effectivePub, pathname);
    // Match Azure FD's literal-path semantics on local:
    //   - On Azure FD, /<id>/browser/dist/cool.html maps to the literal
    //     storage path $web/<id>/browser/dist/cool.html.
    //   - On local, deploy.sh flattens BUILD_DIR/browser/dist/* into
    //     $PUB/<id>/browser/*, so the viewer's /browser/dist/cool.html
    //     URL would 404. Rewrite /browser/dist/<x> → /browser/<x> to
    //     bridge the layout difference. (Migrating deploy.sh to preserve
    //     dist/ would mean migrating every test that probes /browser/<x>
    //     — much bigger blast radius.)
    if ((!fs.existsSync(filepath) || !fs.statSync(filepath).isFile()) &&
        pathname.startsWith('/browser/dist/')) {
        const rewritten = '/browser/' + pathname.slice('/browser/dist/'.length);
        const alt = path.join(effectivePub, rewritten);
        if (fs.existsSync(alt) && fs.statSync(alt).isFile()) {
            filepath = alt;
        }
    }
    // Per-deploy fallback: Azure FD also serves root-level files (like
    // sw-bridge.js, deliberately kept at $PUB/ as one copy across deploys
    // by deploy.sh). When effectivePub is the per-deploy <id>/ folder and
    // the lookup misses, retry at the flat $PUB root.
    if (effectivePub !== PUB &&
        (!fs.existsSync(filepath) || !fs.statSync(filepath).isFile())) {
        const flat = path.join(PUB, pathname);
        if (fs.existsSync(flat) && fs.statSync(flat).isFile()) {
            filepath = flat;
        }
    }
    if (!fs.existsSync(filepath) || !fs.statSync(filepath).isFile()) {
        res.writeHead(404); res.end('Not found: ' + pathname); return;
    }

    const ext = path.extname(filepath);
    const mime = MIME[ext] || 'application/octet-stream';
    const stat = fs.statSync(filepath);

    const headers = { 'Content-Type': mime };
    const etag = '"' + stat.size.toString(16) + '-' + stat.mtimeMs.toString(16) + '"';
    headers['ETag'] = etag;
    headers['Last-Modified'] = stat.mtime.toUTCString();
    if (pathname.endsWith('.html')
        || pathname.endsWith('/sw.js')
        || pathname.endsWith('/sw-bridge.js')) {
        // SW must always revalidate so a code update rolls out within
        // 24h max instead of being pinned by the immutable rule below.
        // sw-bridge.js also gets the Service-Worker-Allowed header in
        // case it's served from a non-root path (gives it `/` scope).
        headers['Cache-Control'] = 'no-cache';
        if (pathname.endsWith('/sw-bridge.js')) {
            headers['Service-Worker-Allowed'] = '/';
        }
    } else if (effectivePub !== PUB) {
        // Per-deploy folder is in play (req routed through <id>/ via
        // either explicit prefix or current-deploy.txt pointer). The
        // URL is content-addressed by build id; cache forever.
        headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    } else if (HASHED_RE.test(pathname)) {
        // Legacy content-hashed asset (pre-per-deploy era).
        headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    } else if (IMMUTABLE.some(n => pathname.endsWith(n))) {
        // Belt-and-braces for unhashed wasm/data in flat layout.
        headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    } else if (pathname.endsWith('.js')) {
        // Non-hashed JS in flat layout — no-cache so code changes take
        // effect immediately on dev hosts.
        headers['Cache-Control'] = 'no-cache';
    } else {
        headers['Cache-Control'] = 'public, max-age=3600';
    }

    // Conditional GET — honour BOTH If-None-Match and If-Modified-Since.
    // Even though Cache-Control: immutable should make Chrome skip the
    // conditional request entirely, some clients still send one (eg. on
    // F5 reload), and an incorrect 200-with-body would look like a
    // re-download in the network tab.
    const ims = req.headers['if-modified-since'];
    // HTTP-date precision is whole seconds, so floor mtime before comparing.
    const imsHit = ims && new Date(ims).getTime() >= Math.floor(stat.mtimeMs / 1000) * 1000;
    if (req.headers['if-none-match'] === etag || imsHit) {
        res.writeHead(304, headers);
        res.end();
        return;
    }

    // Serve a precompiled `<file>.br` if the client accepts brotli.
    // STALENESS CHECK: only serve .br if it's newer than the source.
    // A stale .br (from a previous build) causes silent binary mismatches
    // that break WebAssembly instantiation.
    //
    // The build step renames hashed assets in place (bundle.js →
    // bundle.<hash>.js) and renames the .br sidecar alongside, so a
    // direct `+ '.br'` lookup finds it.
    //
    // Iter 64: stream large bodies instead of fs.readFileSync into a
    // Buffer. online.wasm.br + soffice.data.br are tens of MB, and a
    // burst of cold loaders allocating 30MB Buffers each is what makes
    // the server transiently RSS-spike under load. Streaming gives
    // TCP backpressure proper visibility into the read pipeline.
    const accepted = (req.headers['accept-encoding'] || '').includes('br');
    const brPath = filepath + '.br';
    if (accepted && fs.existsSync(brPath) &&
        fs.statSync(brPath).mtimeMs >= stat.mtimeMs) {
        const brStat = fs.statSync(brPath);
        headers['Content-Encoding'] = 'br';
        headers['Content-Length'] = brStat.size;
        headers['Vary'] = 'Accept-Encoding';
        res.writeHead(200, headers);
        const stream = fs.createReadStream(brPath);
        stream.on('error', () => res.end());
        stream.pipe(res);
        return;
    }

    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    const stream = fs.createReadStream(filepath);
    stream.on('error', () => res.end());
    stream.pipe(res);
}

// HTTP — exposed mainly so the SNI router has a fallback / for local curl.
http.createServer(handler).listen(HTTP_PORT, () => {
    console.log(`Editor-static HTTP  on :${HTTP_PORT}  (PUB=${PUB})`);
});

console.log(`Editor-static document storage: ${DOCS}`);
console.log(`Editor-static FILE_STORAGE_URL (CSP): ${FILE_STORAGE_URL}`);

// HTTPS — the SNI router routes wasm.atgpartners.info traffic here.
if (SSL_CERT && SSL_KEY && fs.existsSync(SSL_CERT) && fs.existsSync(SSL_KEY)) {
    try {
        https.createServer({
            cert: fs.readFileSync(SSL_CERT),
            key:  fs.readFileSync(SSL_KEY),
        }, handler).listen(HTTPS_PORT, () => {
            console.log(`Editor-static HTTPS on :${HTTPS_PORT}  (cert=${SSL_CERT})`);
        });
    } catch(e) {
        console.log(`Editor-static HTTPS not available: ${e.message}`);
    }
} else {
    console.log('Editor-static HTTPS skipped (SSL_CERT / SSL_KEY not set)');
}

process.on('uncaughtException', e => console.log(`Editor-static uncaught: ${e.message}`));
