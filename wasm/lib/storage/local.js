// Local-filesystem storage backend for the viewer / file-storage server.
//
// Stores documents as plain files under LOCAL_STORAGE_DIR (defaults to
// `./storage` next to the running process). Used for development and CI;
// the Azure backend is the production option for App Services deployments.

const fs = require('fs');
const path = require('path');

const STORAGE_DIR = process.env.LOCAL_STORAGE_DIR
    || path.join(process.cwd(), 'storage');

fs.mkdirSync(STORAGE_DIR, { recursive: true });

// Block path traversal: only allow basename(name).
function safePath(name) {
    return path.join(STORAGE_DIR, path.basename(name));
}

async function list() {
    const out = [];
    for (const name of fs.readdirSync(STORAGE_DIR)) {
        const fp = path.join(STORAGE_DIR, name);
        try {
            const st = fs.statSync(fp);
            if (st.isFile()) out.push({ name, size: st.size });
        } catch (e) {}
    }
    return out;
}

async function getBuffer(name) {
    const fp = safePath(name);
    if (!fs.existsSync(fp)) return null;
    return fs.readFileSync(fp);
}

// Cheap "does it exist + when did it change" probe used by the viewer's
// HTTP layer to send ETag / Last-Modified without downloading the body.
// Returns null when the entry doesn't exist.
async function stat(name) {
    const fp = safePath(name);
    if (!fs.existsSync(fp)) return null;
    const st = fs.statSync(fp);
    if (!st.isFile()) return null;
    return {
        size: st.size,
        // Strong-ish ETag from size + mtime in microseconds. The viewer
        // wraps it in W/"…" because the bytes flow through a stream and
        // we can't guarantee byte-for-byte identity across encodings.
        etag: st.size.toString(16) + '-' + Math.floor(st.mtimeMs * 1000).toString(16),
        lastModified: st.mtime,
    };
}

// Pipe the file straight to an HTTP response without buffering.
function pipeTo(name, res, contentType) {
    const fp = safePath(name);
    if (!fs.existsSync(fp)) { res.statusCode = 404; res.end('Not found'); return; }
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    fs.createReadStream(fp).pipe(res);
}

async function put(name, buffer) {
    fs.writeFileSync(safePath(name), buffer);
    return { name: path.basename(name), size: buffer.length };
}

function describe() {
    return `local (${STORAGE_DIR})`;
}

module.exports = { list, getBuffer, pipeTo, put, describe, stat };
