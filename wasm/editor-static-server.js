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
const FILE_STORAGE_URL = process.env.FILE_STORAGE_URL || 'https://viewer.szebeni.hu';

fs.mkdirSync(DOCS, { recursive: true });

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

    // /reports/ — serve the test-suite HTML report set produced by
    // wasm/run-all-tests.sh (lives under PUB/reports).
    if (pathname.startsWith('/reports/')) {
        const filepath = path.join(PUB, pathname);
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
    } else if (IMMUTABLE.some(n => pathname.endsWith(n))) {
        headers['Cache-Control'] = 'public, max-age=31536000, immutable';
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
    const accepted = (req.headers['accept-encoding'] || '').includes('br');
    const brPath = filepath + '.br';
    if (accepted && fs.existsSync(brPath)) {
        const brData = fs.readFileSync(brPath);
        headers['Content-Encoding'] = 'br';
        headers['Content-Length'] = brData.length;
        headers['Vary'] = 'Accept-Encoding';
        res.writeHead(200, headers);
        res.end(brData);
        return;
    }

    const data = fs.readFileSync(filepath);
    headers['Content-Length'] = data.length;
    res.writeHead(200, headers);
    res.end(data);
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
