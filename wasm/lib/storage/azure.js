// Azure Blob Storage backend for the viewer / file-storage server.
//
// Two auth modes:
//   1) SAS URL  — set DOC_STORAGE_SAS_URL to a full container-scoped SAS URL
//      (e.g. https://acct.blob.core.windows.net/container?sv=…&sig=…).
//      Preferred for limited-scope tokens handed out to dev setups.
//   2) Account key — set DOC_STORAGE_ACCOUNT + DOC_STORAGE_KEY, plus optional
//      DOC_STORAGE_CONTAINER (default: "documents").

const { BlobServiceClient, ContainerClient, StorageSharedKeyCredential } = require('@azure/storage-blob');

const sasUrl        = process.env.DOC_STORAGE_SAS_URL;
const accountName   = process.env.DOC_STORAGE_ACCOUNT;
const accountKey    = process.env.DOC_STORAGE_KEY;
const containerName = process.env.DOC_STORAGE_CONTAINER || 'documents';

let container;
let describeSource;

if (sasUrl) {
    // SAS URL is container-scoped: https://{account}.blob.core.windows.net/{container}?{sasQuery}
    container = new ContainerClient(sasUrl);
    describeSource = `azure SAS (${container.accountName}/${container.containerName})`;
} else if (accountName && accountKey) {
    const credential = new StorageSharedKeyCredential(accountName, accountKey);
    const blobService = new BlobServiceClient(
        `https://${accountName}.blob.core.windows.net`, credential
    );
    container = blobService.getContainerClient(containerName);
    describeSource = `azure (${accountName}/${containerName})`;
} else {
    throw new Error('Azure storage backend requires DOC_STORAGE_SAS_URL or DOC_STORAGE_ACCOUNT+DOC_STORAGE_KEY');
}

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
    return describeSource;
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
