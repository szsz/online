// editor-bridge.js — viewer-side handler for the editor iframe's
// Service Worker bridge.
//
// The editor iframe runs on a separate origin. Its bridge SW
// (sw-bridge.js, scope /) intercepts Kit's fetches to /wasm/<id> and
// the /api/* paths and posts them to its controlled page, which
// forwards to window.parent (us). We answer here with bytes.
//
// In-memory cache: when the user opens a v2 file, the viewer
// decrypts ciphertext locally and stages plaintext via stage().
// Subsequent /wasm/<fileId> GETs from the editor are served from
// that cache. POSTs from Kit (save) overwrite the cache entry; the
// viewer can then re-encrypt + persist via the v2 API.

(function (global) {
    'use strict';

    // fileId → ArrayBuffer of plaintext document bytes for this session.
    // Lives in memory only; cleared on navigate / unload. We don't
    // persist plaintext anywhere observable.
    var stagedFiles = new Map();
    // fileId → { displayName, fileId, secretB64 } so save callbacks know
    // where to put the re-encrypted bytes.
    var stagedMeta = new Map();
    // Listeners notified when a /wasm/<fileId> POST arrives (i.e., a
    // save from the editor). Lets the viewer kick re-encryption + the
    // /api/v2/file/<fileId> PUT.
    var saveListeners = [];

    function stage(fileId, plaintext, meta) {
        stagedFiles.set(fileId, plaintext);
        if (meta) stagedMeta.set(fileId, meta);
    }
    function unstage(fileId) {
        stagedFiles.delete(fileId);
        stagedMeta.delete(fileId);
    }
    function onSave(cb) { saveListeners.push(cb); }
    function getStaged(fileId) { return stagedFiles.get(fileId); }

    // Pick the editor's origin from window.__CONFIG (already set by
    // /config.js before this script runs). Used for the origin check
    // on inbound messages — we only trust messages from the editor.
    function editorOrigin() {
        try {
            if (global.__CONFIG && global.__CONFIG.EDITOR_URL) {
                return new URL(global.__CONFIG.EDITOR_URL).origin;
            }
        } catch (_) {}
        return null;
    }

    function reply(target, targetOrigin, id, status, body, headers) {
        var transfer = body ? [body] : [];
        target.postMessage({
            type: 'sw-bridge-response',
            id: id,
            status: status,
            headers: headers || {},
            body: body || null,
        }, targetOrigin, transfer);
    }

    // The /api/blobs/, /api/files/, /api/v2/file/ paths are same-origin
    // to the viewer. We just proxy them. Note: /api/v2/file/<id> returns
    // CIPHERTEXT — the editor side is responsible for handling that
    // (today the relay-adapter routes those to the parent for decryption
    // via a separate, older postMessage handler in the viewer; that path
    // continues to work and is not what this bridge handles).
    async function proxyOwnOrigin(pathAndQuery, method, body) {
        var init = { method: method || 'GET' };
        if (body) init.body = body;
        var r = await fetch(pathAndQuery, init);
        var buf = await r.arrayBuffer();
        return {
            status: r.status,
            headers: { 'content-type': r.headers.get('content-type') || 'application/octet-stream' },
            body: buf,
        };
    }

    async function handle(msg, source, sourceOrigin) {
        var url;
        try { url = new URL(msg.url); }
        catch (_) { return reply(source, sourceOrigin, msg.id, 400, null); }

        var p = url.pathname;
        var search = url.search || '';

        try {
            // /wasm/<fileId> — served from the in-memory cache.
            if (p.indexOf('/wasm/') === 0) {
                var fileId = decodeURIComponent(p.slice('/wasm/'.length).split('?')[0]);
                if (msg.method === 'POST' || msg.method === 'PUT') {
                    // Save from editor: capture the new bytes and notify
                    // listeners (the viewer's openFileBySecret installs
                    // a save listener that re-encrypts + PUTs to v2).
                    if (msg.body) stagedFiles.set(fileId, msg.body);
                    for (var i = 0; i < saveListeners.length; i++) {
                        try { saveListeners[i](fileId, msg.body, stagedMeta.get(fileId)); }
                        catch (e) { console.warn('[editor-bridge] save listener threw', e); }
                    }
                    return reply(source, sourceOrigin, msg.id, 200,
                        new TextEncoder().encode(JSON.stringify({
                            name: fileId, size: (msg.body ? msg.body.byteLength : 0),
                        })).buffer,
                        { 'content-type': 'application/json' });
                }
                // GET: serve from cache.
                var bytes = stagedFiles.get(fileId);
                if (bytes) {
                    // Clone the ArrayBuffer so the cache entry survives
                    // the transfer — without this the second GET (e.g.
                    // checkpoint hash + late-join replay) would find the
                    // cache neutered. ArrayBuffer.transfer would be
                    // ideal but isn't universally supported yet.
                    var copy = bytes.slice(0);
                    return reply(source, sourceOrigin, msg.id, 200, copy,
                        { 'content-type': 'application/octet-stream' });
                }
                return reply(source, sourceOrigin, msg.id, 404, null);
            }

            // /api/* — proxy own-origin. /api/keys/ is handled here too;
            // relay-adapter probes it at startup to discover the v2
            // encryption key version. Pre-bridge it 404'd on the editor
            // origin and relay-adapter fell back to "run unencrypted".
            if (p.indexOf('/api/blobs/') === 0 ||
                p.indexOf('/api/files/') === 0 ||
                p.indexOf('/api/v2/file/') === 0 ||
                p.indexOf('/api/keys/') === 0) {
                var r = await proxyOwnOrigin(p + search, msg.method, msg.body);
                return reply(source, sourceOrigin, msg.id, r.status, r.body, r.headers);
            }

            return reply(source, sourceOrigin, msg.id, 404, null);
        } catch (e) {
            console.warn('[editor-bridge] handle error', e);
            return reply(source, sourceOrigin, msg.id, 500,
                new TextEncoder().encode(e.message || 'bridge error').buffer);
        }
    }

    // Install the listener. Trust only messages from the editor origin.
    var editor = editorOrigin();
    window.addEventListener('message', function (ev) {
        if (editor && ev.origin !== editor) return;
        var msg = ev.data;
        if (!msg || msg.type !== 'sw-bridge-request') return;
        handle(msg, ev.source, ev.origin);
    });

    // Expose for the viewer's openFileBySecret etc.
    global.EditorBridge = {
        stage: stage,
        unstage: unstage,
        get: getStaged,
        onSave: onSave,
        editorOrigin: editorOrigin,
    };
})(window);
