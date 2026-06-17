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

// Open an additional browser page on an existing uploaded file (same
// fileId / b64urlSecret). Lets multi-browser co-edit tests stage the
// file once and join the room from N tabs.
//
// Pass `opts.isolatedContext = true` for co-edit tests so each tab gets
// its own browser context (separate localStorage / sessionStorage /
// IndexedDB). Without isolation, two pages on the same browser share
// state — including any viewer-derived per-tab client id — and the
// relay sees them as one client. Returns `context` so callers can
// close it when they close the page.
async function openSecretInBrowser(browser, viewerUrl, b64urlSecret, opts) {
    opts = opts || {};

    let context = null;
    let page;
    if (opts.isolatedContext) {
        context = await browser.createBrowserContext();
        page = await context.newPage();
    } else {
        page = await browser.newPage();
    }
    if (opts.viewport) await page.setViewport(opts.viewport);
    if (opts.defaultTimeout) page.setDefaultTimeout(opts.defaultTimeout);
    if (typeof opts.onPage === 'function') opts.onPage(page);

    let url = viewerUrl.replace(/\/+$/, '')
        + '/' + (opts.viewerPath || '')
        + '#file=' + b64urlSecret
        + (opts.urlSuffix || '');
    // Mode: single-user is the viewer default (2026-06-17). Co-edit tests
    // must opt in explicitly with `coEditing: true` on EVERY tab in the
    // session so the relay connects and the tabs see each other.
    // `singleUser: true` is now redundant (it's the default) but still
    // honored for explicitness / back-compat.
    if (opts.coEditing) url = url.replace('/#', '/?co-editing#');
    else if (opts.singleUser) url = url.replace('/#', '/?singleuser#');

    // JOBS_SCALE wiring. Under parallel test runners (JOBS=2+) on the
    // self-hosted runner, CPU contention slows canvas paint enough to
    // trip the viewer's 180s cross-type watchdog, tearing the iframe
    // down mid-test. The viewer reads ?ws=N and uses it as a multiplier
    // on those budgets. We append ?ws=$JOBS_SCALE here so every test
    // that opens via this helper inherits the widening. opts.urlSuffix
    // is preserved (it's after the hash so doesn't conflict with the
    // search-string `ws` param).
    const _jobsScale = parseInt(process.env.JOBS_SCALE || '1', 10);
    if (Number.isFinite(_jobsScale) && _jobsScale > 1) {
        // Inject ?ws= into the search portion (before the hash). If a
        // mode param (?co-editing / ?singleuser) is already present, append
        // with & instead of starting a new query string.
        const _hashIdx = url.indexOf('#');
        const _searchEnd = _hashIdx === -1 ? url.length : _hashIdx;
        const _hasSearch = url.slice(0, _searchEnd).includes('?');
        const _sep = _hasSearch ? '&' : '?';
        url = url.slice(0, _searchEnd) + _sep + 'ws=' + _jobsScale
            + url.slice(_searchEnd);
    }

    await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: opts.gotoTimeout || 60000,
    });

    // Wait for the FILE-loading iframe — not the blank-docx bootstrap.
    //
    // viewer-public/index.html:828 creates an initial iframe with
    // WOPISrc=blank.docx during bootstrap. Then openFileBySecret →
    // openFile runs (async, triggered by the #file=<secret> hash) and
    // takes one of two paths:
    //   - Hot-switch (same-doctype, prewarm ready): rewrites iframe.src
    //     with a #switchdoc= hash. Frame ref survives.
    //   - Cold-reload (cross-doctype OR no-prewarm-yet, the typical FIRST
    //     open path): index.html:1292 does `parentNode.replaceChild`
    //     which REMOVES the bootstrap iframe and appends a new one. The
    //     puppeteer Frame ref to the old iframe becomes "detached" ~50–
    //     200 ms after openFileBySecret completes.
    //
    // Tests that match the first `cool.html`-URL frame land on the blank
    // bootstrap, then their next `frame.evaluate / waitForFunction` call
    // throws "frame got detached" because the replaceChild already ran.
    //
    // Strategy: resolve the iframe via getElementById('editor-frame').src
    // (the active id — parked iframes get renamed) AND require the URL to
    // NOT carry WOPISrc=blank.docx. That waits past the bootstrap and
    // returns the iframe the viewer is actually loading the file into.
    const iframeT0 = Date.now();
    const iframeTimeout = opts.iframeTimeout || 60000;
    let editorFrame = null;
    while (Date.now() - iframeT0 < iframeTimeout) {
        const activeUrl = await page.evaluate(() => {
            const el = document.getElementById('editor-frame');
            return el && el.src ? el.src : null;
        }).catch(() => null);
        // BLANK_FILENAME in viewer-public/index.html is '__prewarm_blank.docx'
        // — match the substring to handle either form (encoded/decoded).
        if (activeUrl
            && activeUrl.indexOf('cool.html') >= 0
            && activeUrl.indexOf('__prewarm_blank') < 0) {
            editorFrame = page.frames().find(f => f.url() === activeUrl);
            if (editorFrame) break;
        }
        await new Promise(r => setTimeout(r, 200));
    }
    if (!editorFrame) {
        throw new Error('openSecretInBrowser: file-loading iframe never '
            + 'replaced the bootstrap blank-docx iframe within '
            + iframeTimeout + 'ms — viewer probably failed to decrypt '
            + 'or stage the file (check page console)');
    }

    return { page, editorFrame, context };
}

async function openViaViewer(browser, viewerUrl, name, bytes, opts) {
    opts = opts || {};
    const up = await uploadV2(viewerUrl, name, bytes);
    const { page, editorFrame, context } =
        await openSecretInBrowser(browser, viewerUrl, up.b64urlSecret, opts);
    return {
        page,
        editorFrame,
        context,
        fileId: up.fileId,
        b64urlSecret: up.b64urlSecret,
        secret: up.secret,
        upload: up,
    };
}

module.exports = { openViaViewer, openSecretInBrowser };
