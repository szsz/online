// Azure Blob Storage backend for the viewer / file-storage server.
//
// Requires DOC_STORAGE_ACCOUNT and DOC_STORAGE_KEY in the environment.
// Container name defaults to `documents` (override via DOC_STORAGE_CONTAINER).

const { BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob');

const accountName   = process.env.DOC_STORAGE_ACCOUNT;
const accountKey    = process.env.DOC_STORAGE_KEY;
const containerName = process.env.DOC_STORAGE_CONTAINER || 'documents';

if (!accountName || !accountKey) {
    throw new Error('Azure storage backend requires DOC_STORAGE_ACCOUNT and DOC_STORAGE_KEY');
}

const credential = new StorageSharedKeyCredential(accountName, accountKey);
const blobService = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`, credential
);
const container = blobService.getContainerClient(containerName);

async function list() {
    const out = [];
    for await (const blob of container.listBlobsFlat()) {
        out.push({ name: blob.name, size: blob.properties.contentLength });
    }
    return out;
}

async function getBuffer(name) {
    try {
        const blob = container.getBlobClient(name);
        const dl = await blob.download(0);
        return await streamToBuffer(dl.readableStreamBody);
    } catch (err) {
        if (err.statusCode === 404) return null;
        throw err;
    }
}

async function pipeTo(name, res, contentType) {
    try {
        const blob = container.getBlobClient(name);
        const dl = await blob.download(0);
        res.setHeader('Content-Type', contentType || dl.contentType || 'application/octet-stream');
        dl.readableStreamBody.pipe(res);
    } catch (err) {
        if (err.statusCode === 404) { res.statusCode = 404; res.end('Not found'); return; }
        throw err;
    }
}

async function put(name, buffer) {
    const blob = container.getBlockBlobClient(name);
    await blob.upload(buffer, buffer.length, {
        blobHTTPHeaders: { blobContentType: 'application/octet-stream' },
    });
    return { name, size: buffer.length };
}

function describe() {
    return `azure (${accountName}/${containerName})`;
}

function streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', d => chunks.push(d instanceof Buffer ? d : Buffer.from(d)));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}

module.exports = { list, getBuffer, pipeTo, put, describe };
