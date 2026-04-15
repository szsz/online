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

module.exports = { list, getBuffer, pipeTo, put, describe };
