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

// Iter 58: in-memory cache for cool.html. Read once, hold the bytes,
// invalidate on mtime change. Every iframe load hits this path so even
// the small readFileSync (~30 KB) shows up under load.
const _coolCache = { mtimeMs: 0, body: null, etag: null };

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
    let pathname = decodeURIComponent(parsed.pathname);

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

    // Default: serve from PUB (and special-case `/` → editor.html).
    if (pathname === '/') pathname = '/editor.html';
    if (pathname === '/editor.html') {
        const p = path.join(PUB, 'browser/editor.html');
        if (fs.existsSync(p)) {
            res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
            res.end(fs.readFileSync(p));
            return;
        }
    }

    // cool.html is served as-is. The build step (cache-bust-build.js)
    // already rewrote asset refs to hashed names, injected the loading
    // overlay + custom loaders + Module.locateFile shim, and stripped
    // branding hooks. Cache-Control: no-cache so a deploy is picked up
    // on the next refresh.
    //
    // Iter 58: cache the body in memory keyed on mtime + emit ETag so
    // the iframe's revisit hits 304. The previous early-return skipped
    // the generic ETag block below, which meant every iframe load got
    // a full-body 200 even though the browser already had it. Mirrors
    // editor-server.js iter 53 (Azure side).
    if (pathname.endsWith('/cool.html')) {
        const filepath = path.join(PUB, pathname);
        if (fs.existsSync(filepath)) {
            const stat = fs.statSync(filepath);
            if (_coolCache.mtimeMs !== stat.mtimeMs || !_coolCache.body) {
                _coolCache.body = fs.readFileSync(filepath);
                _coolCache.mtimeMs = stat.mtimeMs;
                _coolCache.etag = '"' + stat.size.toString(16) + '-' + stat.mtimeMs.toString(16) + '"';
            }
            const headers = {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache',
                'ETag': _coolCache.etag,
                'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
            };
            const ims = req.headers['if-modified-since'];
            const imsHit = ims && new Date(ims).getTime() >= Math.floor(stat.mtimeMs / 1000) * 1000;
            if (req.headers['if-none-match'] === _coolCache.etag || imsHit) {
                res.writeHead(304, headers);
                res.end();
                return;
            }
            res.writeHead(200, headers);
            res.end(_coolCache.body);
            return;
        }
    }

    const filepath = path.join(PUB, pathname);
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
    if (pathname.endsWith('.html') || pathname.endsWith('/sw.js')) {
        // SW must always revalidate so a code update rolls out within
        // 24h max instead of being pinned by the immutable rule below.
        headers['Cache-Control'] = 'no-cache';
    } else if (HASHED_RE.test(pathname)) {
        // Content-hashed asset (built by cache-bust-build.js): the hash
        // is the version, so the URL itself rolls on every change.
        headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    } else if (IMMUTABLE.some(n => pathname.endsWith(n))) {
        // Belt-and-braces for any unhashed wasm/data still on disk
        // (e.g. clients caching an older cool.html during a deploy
        // window). Build-time hashing replaces these in the normal
        // path.
        headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    } else if (pathname.endsWith('.js')) {
        // Non-hashed JS: no-cache so code changes take effect immediately.
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
