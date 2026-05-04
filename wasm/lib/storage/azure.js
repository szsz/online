// Azure Blob Storage backend for the viewer / file-storage server.
//
// Layout (content-addressable — see the local backend for the rationale):
//   _blobs/<sha256>          — immutable content blob (BlockBlob)
//   _meta/<urlencoded-name>.json — {hash, size, updatedAt}
//   <name>                   — legacy plain-name blob, read-only fallback;
//                              the first read promotes it into the new
//                              layout (computes hash, copies to _blobs/,
//                              writes _meta/).
//
// Three auth modes (preferred → fallback):
//   1) Managed Identity / DefaultAzureCredential — set DOC_STORAGE_ACCOUNT
//      (no key, no SAS). Picks up the App Service MSI on Azure or your
//      `az login` credentials when running locally. Requires the identity
//      to have "Storage Blob Data Contributor" on the target container.
//   2) SAS URL  — set DOC_STORAGE_SAS_URL to a full container-scoped SAS
//      (e.g. https://acct.blob.core.windows.net/container?sv=…&sig=…).
//      Kept for legacy/limited-scope dev setups.
//   3) Account key — set DOC_STORAGE_ACCOUNT + DOC_STORAGE_KEY. Discouraged;
//      keep it only as a last-resort fallback.
// Optional: DOC_STORAGE_CONTAINER (default: "userdata").

const { BlobServiceClient, ContainerClient, StorageSharedKeyCredential } = require('@azure/storage-blob');
const crypto = require('crypto');

const sasUrl        = process.env.DOC_STORAGE_SAS_URL;
const accountName   = process.env.DOC_STORAGE_ACCOUNT;
const accountKey    = process.env.DOC_STORAGE_KEY;
const containerName = process.env.DOC_STORAGE_CONTAINER || 'userdata';

let container;
let describeSource;

if (sasUrl) {
    container = new ContainerClient(sasUrl);
    describeSource = `azure SAS (${container.accountName}/${container.containerName})`;
} else if (accountName && accountKey) {
    const credential = new StorageSharedKeyCredential(accountName, accountKey);
    const blobService = new BlobServiceClient(
        `https://${accountName}.blob.core.windows.net`, credential
    );
    container = blobService.getContainerClient(containerName);
    describeSource = `azure (${accountName}/${containerName})`;
} else if (accountName) {
    // No key/SAS → use DefaultAzureCredential (MSI on Azure, az CLI locally).
    // Lazily-required so envs that never reach this branch don't have to
    // install @azure/identity.
    const { DefaultAzureCredential } = require('@azure/identity');
    const credential = new DefaultAzureCredential();
    const blobService = new BlobServiceClient(
        `https://${accountName}.blob.core.windows.net`, credential
    );
    container = blobService.getContainerClient(containerName);
    describeSource = `azure (${accountName}/${containerName} via DefaultAzureCredential)`;
} else {
    throw new Error('Azure storage backend requires DOC_STORAGE_ACCOUNT (preferred, MSI/az-login auth), or DOC_STORAGE_SAS_URL, or DOC_STORAGE_ACCOUNT+DOC_STORAGE_KEY');
}

// Allow folder paths but block traversal attacks.
function safeName(name) {
    if (!name) return null;
    const n = name.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
    if (!n) return null;
    const parts = n.split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) return null;
    return n;
}
function blobKey(hash) {
    if (!/^[0-9a-f]{16,128}$/i.test(hash || '')) return null;
    return '_blobs/' + hash.toLowerCase();
}
function metaKey(name) {
    return '_meta/' + encodeURIComponent(safeName(name)) + '.json';
}

function streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', d => chunks.push(d instanceof Buffer ? d : Buffer.from(d)));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}

function sha256Hex(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

// ── Blobs (content-addressable) ────────────────────────────────────
async function putBlob(buffer) {
    const hash = sha256Hex(buffer);
    const key = blobKey(hash);
    const blob = container.getBlockBlobClient(key);
    // exists() lets us skip the upload when the same content is already
    // stored — saves time and PUT cost when many users save unchanged docs.
    const exists = await blob.exists();
    if (!exists) {
        await blob.upload(buffer, buffer.length, {
            blobHTTPHeaders: { blobContentType: 'application/octet-stream' },
        });
    }
    return { hash, size: buffer.length };
}

async function statBlob(hash) {
    const key = blobKey(hash);
    if (!key) return null;
    try {
        const blob = container.getBlobClient(key);
        const props = await blob.getProperties();
        return { size: props.contentLength, etag: hash, lastModified: props.lastModified };
    } catch (err) {
        if (err.statusCode === 404) return null;
        throw err;
    }
}

async function getBlobBuffer(hash) {
    const key = blobKey(hash);
    if (!key) return null;
    try {
        const blob = container.getBlobClient(key);
        const dl = await blob.download(0);
        return await streamToBuffer(dl.readableStreamBody);
    } catch (err) {
        if (err.statusCode === 404) return null;
        throw err;
    }
}

async function pipeBlobTo(hash, res, contentType) {
    const key = blobKey(hash);
    if (!key) { res.statusCode = 404; res.end('Bad hash'); return; }
    try {
        const blob = container.getBlobClient(key);
        const dl = await blob.download(0);
        res.setHeader('Content-Type', contentType || dl.contentType || 'application/octet-stream');
        dl.readableStreamBody.pipe(res);
    } catch (err) {
        if (err.statusCode === 404) { res.statusCode = 404; res.end('Not found'); return; }
        throw err;
    }
}

// ── Name → hash metadata ───────────────────────────────────────────
async function readMeta(name) {
    try {
        const blob = container.getBlobClient(metaKey(name));
        const dl = await blob.download(0);
        const buf = await streamToBuffer(dl.readableStreamBody);
        return JSON.parse(buf.toString('utf8'));
    } catch (err) {
        if (err.statusCode === 404) return null;
        return null;
    }
}
async function writeMeta(name, meta) {
    const blob = container.getBlockBlobClient(metaKey(name));
    const body = Buffer.from(JSON.stringify(meta), 'utf8');
    await blob.upload(body, body.length, {
        blobHTTPHeaders: { blobContentType: 'application/json' },
    });
}

// Self-healing migration: a legacy plain-name blob with no metadata.
// Compute hash, write to _blobs/, write metadata.
async function maybeMigrateLegacy(name) {
    const sn = safeName(name);
    try {
        const blob = container.getBlobClient(sn);
        const dl = await blob.download(0);
        const buf = await streamToBuffer(dl.readableStreamBody);
        const { hash, size } = await putBlob(buf);
        const meta = {
            hash, size,
            updatedAt: dl.lastModified ? dl.lastModified.toISOString() : new Date().toISOString(),
            migrated: true,
        };
        await writeMeta(sn, meta);
        return meta;
    } catch (err) {
        if (err.statusCode === 404) return null;
        throw err;
    }
}

async function getName(name) {
    const meta = await readMeta(name);
    if (meta) return meta;
    return maybeMigrateLegacy(name);
}

async function setName(name, hash, size) {
    const meta = { hash, size, updatedAt: new Date().toISOString() };
    await writeMeta(safeName(name), meta);
    return meta;
}

// Merge-patch a single field into the meta record. Used by the v2 API
// to attach encrypted-name ciphertext without rewriting unrelated fields.
async function setMetaField(name, field, value) {
    const sn = safeName(name);
    const existing = (await readMeta(sn)) || {};
    existing[field] = value;
    existing.updatedAt = new Date().toISOString();
    await writeMeta(sn, existing);
    return existing;
}

// Delete a name → hash pointer and its metadata. The underlying _blobs/
// content is left alone (still referenced by any other name that pointed
// at the same hash; content-addressable so unique per hash).
async function deleteName(name) {
    const sn = safeName(name);
    try {
        await container.getBlobClient(metaKey(sn)).deleteIfExists();
    } catch(e) {}
    try {
        await container.getBlobClient(sn).deleteIfExists();
    } catch(e) {}
}

async function listNames() {
    // Iterate metadata blobs only; legacy plain-name blobs without metadata
    // would need an extra pass. We list those too so the UI stays complete.
    const out = [];
    const known = new Set();
    for await (const blob of container.listBlobsFlat({ prefix: '_meta/' })) {
        const fn = blob.name.slice('_meta/'.length);
        if (!fn.endsWith('.json')) continue;
        const name = decodeURIComponent(fn.slice(0, -5));
        try {
            const meta = await readMeta(name);
            if (meta) {
                out.push({
                    name, hash: meta.hash, size: meta.size,
                    updatedAt: meta.updatedAt,
                    encName: meta.encName || null,  // v2 per-file name ciphertext
                });
                known.add(name);
            }
        } catch (e) {}
    }
    for await (const blob of container.listBlobsFlat()) {
        if (blob.name.startsWith('_blobs/') || blob.name.startsWith('_meta/')) continue;
        if (known.has(blob.name)) continue;
        out.push({
            name: blob.name,
            hash: null,
            size: blob.properties.contentLength,
            updatedAt: blob.properties.lastModified
                ? blob.properties.lastModified.toISOString() : null,
            legacy: true,
        });
    }
    return out;
}

// ── Backward-compat facades ────────────────────────────────────────
async function put(name, buffer, { expectedHash = null, force = false } = {}) {
    const safe = safeName(name);
    if (!safe) throw new Error('Invalid file name: ' + name);
    if (expectedHash && !force) {
        const currentMeta = await readMeta(safe);
        if (currentMeta && currentMeta.hash && currentMeta.hash !== expectedHash) {
            return {
                name: safe,
                conflict: true,
                currentHash: currentMeta.hash,
                expectedHash,
                updatedAt: currentMeta.updatedAt,
            };
        }
    }
    const { hash, size } = await putBlob(buffer);
    await setName(safe, hash, size);
    return { name: safe, size, hash };
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
    return {
        size: blobMeta.size,
        etag: meta.hash,
        lastModified: meta.updatedAt ? new Date(meta.updatedAt) : blobMeta.lastModified,
    };
}

async function list() { return listNames(); }

function describe() { return describeSource; }

module.exports = {
    putBlob, getBlobBuffer, pipeBlobTo, statBlob,
    setName, getName, listNames, setMetaField, deleteName,
    list, getBuffer, pipeTo, put, stat,
    describe,
};
