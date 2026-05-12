// lib/open-via-viewer.js — Test helper that mirrors a real-user flow:
// uploads a v2-encrypted file via the viewer's API, navigates the
// browser to the viewer's deep-link URL, waits for the viewer to
// iframe the editor, and returns the editor iframe handle.
//
// Why this helper exists
// ----------------------
// Pre-FD-migration, tests could bypass the viewer entirely: POST
// plaintext bytes to `${EDITOR_URL}/wasm/<name>` and then navigate
// directly to `${EDITOR_URL}/browser/cool.html?WOPISrc=<name>`. The
// editor App Service hosted `/wasm/<name>` as a temp blackboard and
// served the bytes back to Kit at boot.
//
// Post-FD-migration the editor is a static site on Azure Front Door
// with no dynamic endpoint. The /wasm/<id> + /api/blobs/ + /api/v2/
// file/ fetches Kit makes are intercepted by /sw-bridge.js (scope /)
// and routed via postMessage to the parent (viewer). For the bridge
// to work the page MUST have a viewer parent — direct cool.html
// access has no parent, the SW falls through to network, and FD
// returns 404 because /wasm/ isn't a thing.
//
// So tests must drive the viewer flow now: upload to viewer storage,
// navigate the viewer, let it iframe the editor. This helper packages
// that dance.
//
// Usage
// -----
//   const { openViaViewer } = require('./lib/open-via-viewer');
//
//   const fixture = fs.readFileSync('path/to/doc.docx');
//   const { page, editorFrame, fileId, b64urlSecret } =
//       await openViaViewer(browser, env.FILE_STORAGE_URL,
//                           'mydoc.docx', fixture);
//
//   // Interactions go to editorFrame for DOM, page for mouse/keys:
//   await editorFrame.waitForSelector('#StateWordCount');
//   await page.mouse.click(640, 400);     // page coords are fine —
//                                          // viewer's index.html
//                                          // mounts the iframe
//                                          // fullscreen at (0,0)
//                                          // once it removes the
//                                          // loading shield.
//   await page.keyboard.type('hello');

'use strict';

const { uploadV2 } = require('./v2-upload');

async function openViaViewer(browser, viewerUrl, name, bytes, opts) {
    opts = opts || {};

    // 1. Upload v2-encrypted ciphertext to viewer storage. The
    //    returned b64urlSecret is what we put in the URL fragment;
    //    the viewer derives the per-file content + name keys from
    //    it and decrypts locally.
    const up = await uploadV2(viewerUrl, name, bytes);

    // 2. Open the page. Allow the caller to attach console handlers
    //    before navigation by passing opts.onPage(page).
    const page = await browser.newPage();
    if (opts.viewport) await page.setViewport(opts.viewport);
    if (opts.defaultTimeout) page.setDefaultTimeout(opts.defaultTimeout);
    if (typeof opts.onPage === 'function') opts.onPage(page);

    // 3. Navigate to the viewer's deep-link. The viewer's
    //    openFileBySecret runs, decrypts, stages plaintext in
    //    EditorBridge, builds the iframe URL (with
    //    ?fileStorageUrl + EDITOR_DEPLOY_ID baked in), and iframes
    //    cool.html. `opts.urlSuffix` (e.g. '&planc=1', '&singleuser')
    //    is appended after the hash so anything reading
    //    window.location.search before the iframe init still sees
    //    a clean URL.
    let url = viewerUrl.replace(/\/+$/, '')
        + '/' + (opts.viewerPath || '')
        + '#file=' + up.b64urlSecret
        + (opts.urlSuffix || '');
    if (opts.singleUser) url = url.replace('/#', '/?singleuser#');

    await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: opts.gotoTimeout || 60000,
    });

    // 4. Wait for the editor iframe to attach and load cool.html.
    //    The viewer kicks off iframe creation a fraction of a second
    //    after the page settles (it has to decrypt + stage first);
    //    polling for the right frame is the simplest way.
    const iframeT0 = Date.now();
    const iframeTimeout = opts.iframeTimeout || 60000;
    let editorFrame = null;
    while (Date.now() - iframeT0 < iframeTimeout) {
        editorFrame = page.frames().find(
            f => f.url() && f.url().indexOf('cool.html') >= 0
        );
        if (editorFrame) break;
        await new Promise(r => setTimeout(r, 200));
    }
    if (!editorFrame) {
        throw new Error('openViaViewer: editor iframe never loaded '
            + 'within ' + iframeTimeout + 'ms — viewer probably '
            + 'failed to decrypt or stage the file (check page console)');
    }

    return {
        page,
        editorFrame,
        fileId: up.fileId,
        b64urlSecret: up.b64urlSecret,
        secret: up.secret,
        upload: up,
    };
}

module.exports = { openViaViewer };
