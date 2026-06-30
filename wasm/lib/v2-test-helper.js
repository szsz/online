// lib/v2-test-helper.js — utilities that wrap the v2 encrypted-upload
// flow for test scripts.
//
// - uploadFile(viewer, name, bytes): upload a file and return the
//   {b64urlSecret, fileId, secret} triple. Bytes may be a Buffer,
//   Uint8Array, or a utf-8 string.
//
// - seedRecentFiles(page, entries): install rf_v1 localStorage on the
//   page so the viewer's sidebar renders the test's files at load time.
//   `entries` is [{b64urlSecret, fileId, cachedName}]. `cachedName` is
//   optional but makes the sidebar label human-readable.
//
// - openByHash(page, viewer, b64urlSecret, gotoOpts): goto /#file=<sec>.
//   The viewer's init() auto-detects the 22-char base64url secret and
//   calls openFileBySecret(); no click or sidebar needed.
//
// - clickSidebarFile(page, fileId): click the sidebar entry whose
//   data-fileid attribute matches. Requires seedRecentFiles() first.
//
// - waitForSidebar(page, fileId, timeoutMs): wait for the sidebar entry
//   to be present in the DOM.
//
// None of these reach into the editor iframe — the page just drives
// the parent viewer.

'use strict';

const { uploadV2 } = require('./v2-upload');

async function uploadFile(viewerUrl, name, bytes) {
    if (typeof bytes === 'string') bytes = Buffer.from(bytes, 'utf8');
    if (bytes instanceof Uint8Array && !Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
    return uploadV2(viewerUrl, name, bytes);
}

async function seedRecentFiles(page, entries) {
    // Normalize: accept {b64urlSecret,fileId,cachedName} from uploadFile
    // directly, or {secret,fileId,cachedName}.
    const now = new Date().toISOString();
    const files = entries.map((e, i) => ({
        secret: e.secret || e.b64urlSecret,
        fileId: e.fileId,
        cachedName: e.cachedName || null,
        lastVisited: e.lastVisited || new Date(Date.now() - i).toISOString(),
    }));
    await page.evaluateOnNewDocument((list) => {
        localStorage.setItem('rf_v1', JSON.stringify({ files: list }));
    }, files);
}

async function openByHash(page, viewerUrl, b64urlSecret, gotoOpts) {
    return page.goto(viewerUrl.replace(/\/$/, '') + '/#file=' + b64urlSecret,
        Object.assign({ waitUntil: 'domcontentloaded' }, gotoOpts || {}));
}

async function clickSidebarFile(page, fileId) {
    await page.evaluate(id => {
        const el = document.querySelector(`.file[data-fileid="${id}"]`);
        if (!el) throw new Error('File not in sidebar: ' + id);
        el.click();
    }, fileId);
}

async function waitForSidebar(page, fileId, timeoutMs) {
    return page.waitForFunction(
        id => !!document.querySelector(`.file[data-fileid="${id}"]`),
        { timeout: timeoutMs || 30000 }, fileId);
}

module.exports = {
    uploadFile,
    seedRecentFiles,
    openByHash,
    clickSidebarFile,
    waitForSidebar,
};
