// Static file server with COOP/COEP headers (required for SharedArrayBuffer/WASM pthreads).
// Replaces emrun for local development.
// Usage: node wasm/serve.js [port]

// Prevent server from crashing on uncaught errors (e.g., malformed URLs)
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception (server continues):', err.message);
});

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2]) || 6931;
const ROOT = path.resolve(__dirname, '..', 'browser', 'dist');

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

const server = http.createServer((req, res) => {
    // COOP/COEP headers required for SharedArrayBuffer
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');

    // Handle POST (form submit from wasm.html) the same as GET
    let urlPath;
    try {
        urlPath = decodeURIComponent(req.url.split('?')[0]);
    } catch (e) {
        urlPath = req.url.split('?')[0];
    }
    if (urlPath === '/') urlPath = '/wasm.html';

    const filePath = path.join(ROOT, urlPath);

    // Prevent directory traversal
    if (!filePath.startsWith(ROOT)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    // Use streaming for all files (handles large files like soffice.data ~85MB)
    function serveFile(fp) {
        fs.stat(fp, (err, stats) => {
            if (err || !stats.isFile()) {
                // Try with .html extension
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
        res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': stats.size,
        });
        fs.createReadStream(fp).pipe(res);
    }

    serveFile(filePath);
});

server.listen(PORT, () => {
    console.log(`Serving ${ROOT} on http://localhost:${PORT}`);
    console.log('COOP/COEP headers enabled for SharedArrayBuffer support');
    console.log('');
    console.log('URLs:');
    console.log(`  Upload & open:  http://localhost:${PORT}/wasm.html`);
    console.log(`  Fixed file:     http://localhost:${PORT}/cool.html?file_path=/test/example.odt`);
});
