// Local-filesystem storage backend for the viewer / file-storage server.
//
// Layout (content-addressable):
//   _blobs/<sha256>            — immutable content. Same hash → same blob,
//                                shared across names. ETag = the hash itself.
//   _meta/<urlencoded-name>.json — {hash, size, updatedAt}. The current
//                                version of `name` is whatever hash this
//                                points at.
//   <name>                     — legacy plain-name files. Read-only fallback;
//                                a first read promotes them into the new
//                                layout (computes hash, writes blob + meta).
//
// Why content-addressable: the relay tracks documents by SHA-256 checkpoint
// hash. If the file storage is keyed by NAME, the relay's hash and the
// storage's content can drift out of sync (e.g., when the relay restarts or
// when a non-COOL writer overwrites a name). By keying the actual bytes
// under the hash, the relay's "expected hash" is literally the URL the late
// joiner fetches — drift becomes impossible.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORAGE_DIR = process.env.LOCAL_STORAGE_DIR
    || path.join(process.cwd(), 'storage');
const BLOBS_DIR = path.join(STORAGE_DIR, '_blobs');
const META_DIR  = path.join(STORAGE_DIR, '_meta');

fs.mkdirSync(STORAGE_DIR, { recursive: true });
fs.mkdirSync(BLOBS_DIR,   { recursive: true });
fs.mkdirSync(META_DIR,    { recursive: true });

// Block path traversal: only allow basename(name).
function safeName(name) { return path.basename(name); }
function blobPath(hash) {
    // Hex hashes only — SHA-256 is 64 chars; reject anything weird so a
    // crafted hash can't escape BLOBS_DIR.
    if (!/^[0-9a-f]{16,128}$/i.test(hash || '')) return null;
    return path.join(BLOBS_DIR, hash.toLowerCase());
}
function metaPath(name) {
    return path.join(META_DIR, encodeURIComponent(safeName(name)) + '.json');
}

// ── Blobs (content-addressable) ────────────────────────────────────
function sha256Hex(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

async function putBlob(buffer) {
    const hash = sha256Hex(buffer);
    const fp = blobPath(hash);
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, buffer);
    return { hash, size: buffer.length };
}

async function statBlob(hash) {
    const fp = blobPath(hash);
    if (!fp || !fs.existsSync(fp)) return null;
    const st = fs.statSync(fp);
    return { size: st.size, etag: hash, lastModified: st.mtime };
}

async function getBlobBuffer(hash) {
    const fp = blobPath(hash);
    if (!fp || !fs.existsSync(fp)) return null;
    return fs.readFileSync(fp);
}

function pipeBlobTo(hash, res, contentType) {
    const fp = blobPath(hash);
    if (!fp || !fs.existsSync(fp)) { res.statusCode = 404; res.end('Not found'); return; }
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    fs.createReadStream(fp).pipe(res);
}

// ── Name → hash metadata ───────────────────────────────────────────
function readMeta(name) {
    const mp = metaPath(name);
    if (!fs.existsSync(mp)) return null;
    try { return JSON.parse(fs.readFileSync(mp, 'utf8')); } catch (e) { return null; }
}
function writeMeta(name, meta) {
    fs.writeFileSync(metaPath(name), JSON.stringify(meta));
}

// Self-healing migration: if a legacy plain-name file exists for `name`
// but no metadata, hash it, write the blob + meta, then return the meta.
function maybeMigrateLegacy(name) {
    const legacyPath = path.join(STORAGE_DIR, safeName(name));
    if (!fs.existsSync(legacyPath)) return null;
    if (path.dirname(legacyPath) !== STORAGE_DIR) return null;  // safety
    const st = fs.statSync(legacyPath);
    if (!st.isFile()) return null;
    const buf = fs.readFileSync(legacyPath);
    const hash = sha256Hex(buf);
    const fp = blobPath(hash);
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, buf);
    const meta = { hash, size: buf.length, updatedAt: st.mtime.toISOString(), migrated: true };
    writeMeta(name, meta);
    return meta;
}

async function getName(name) {
    return readMeta(name) || maybeMigrateLegacy(name);
}

async function setName(name, hash, size) {
    const meta = { hash, size, updatedAt: new Date().toISOString() };
    writeMeta(name, meta);
    return meta;
}

async function listNames() {
    const out = [];
    // Names with metadata first.
    for (const f of fs.readdirSync(META_DIR)) {
        if (!f.endsWith('.json')) continue;
        const name = decodeURIComponent(f.slice(0, -5));
        const meta = readMeta(name);
        if (meta) out.push({ name, hash: meta.hash, size: meta.size, updatedAt: meta.updatedAt });
    }
    // Plus any legacy files that haven't been migrated yet (lazy hash compute).
    const known = new Set(out.map(e => e.name));
    for (const f of fs.readdirSync(STORAGE_DIR)) {
        if (f === '_blobs' || f === '_meta') continue;
        if (known.has(f)) continue;
        try {
            const st = fs.statSync(path.join(STORAGE_DIR, f));
            if (st.isFile()) {
                // Don't compute hash for the listing — that would read every
                // file every list. Mark unknown hash so the client can
                // recognize "needs migration" if it cares.
                out.push({ name: f, hash: null, size: st.size,
                           updatedAt: st.mtime.toISOString(), legacy: true });
            }
        } catch (e) {}
    }
    return out;
}

// ── Backward-compat facades ────────────────────────────────────────
// Existing callers use put(name, buffer) / pipeTo(name, res) /
// getBuffer(name) / stat(name) / list() — keep them, route through the
// new layout.

async function put(name, buffer, { expectedHash = null, force = false } = {}) {
    // Conflict check: if the caller declares the hash it expects the file
    // to currently have, reject the write when it doesn't match (unless
    // force=true). This prevents silent overwrites when the file was
    // modified externally since the editor loaded it.
    if (expectedHash && !force) {
        const currentMeta = readMeta(safeName(name));
        if (currentMeta && currentMeta.hash && currentMeta.hash !== expectedHash) {
            return {
                name: safeName(name),
                conflict: true,
                currentHash: currentMeta.hash,
                expectedHash,
                updatedAt: currentMeta.updatedAt,
            };
        }
    }
    const { hash, size } = await putBlob(buffer);
    await setName(safeName(name), hash, size);
    return { name: safeName(name), size, hash };
}

async function getBuffer(name) {
    const meta = await getName(name);
    if (!meta || !meta.hash) return null;
    return getBlobBuffer(meta.hash);
}

async function pipeTo(name, res, contentType) {
    const meta = await getName(name);
    if (!meta || !meta.hash) { res.statusCode = 404; res.end('Not found'); return; }
    res.setHeader('X-Content-Hash', meta.hash);
    return pipeBlobTo(meta.hash, res, contentType);
}

async function stat(name) {
    const meta = await getName(name);
    if (!meta || !meta.hash) return null;
    const blobMeta = await statBlob(meta.hash);
    if (!blobMeta) return null;
    // ETag is the content hash itself — strong, stable across replicas.
    return {
        size: blobMeta.size,
        etag: meta.hash,
        lastModified: meta.updatedAt ? new Date(meta.updatedAt) : blobMeta.lastModified,
    };
}

async function list() { return listNames(); }

function describe() {
    return `local content-addressed (${STORAGE_DIR})`;
}

module.exports = {
    // New content-addressable API
    putBlob, getBlobBuffer, pipeBlobTo, statBlob,
    setName, getName, listNames,
    // Backward-compat facades
    list, getBuffer, pipeTo, put, stat,
    describe,
};
