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
    if (opts.singleUser) url = url.replace('/#', '/?singleuser#');

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

    // Wrap the Frame in a re-resolving proxy that survives inner-iframe
    // location.reload() calls.
    //
    // PR #81 fixed the PARENT-side iframe replaceChild race. But once
    // the test holds editorFrame, the iframe's OWN wasm-loader can
    // re-navigate via `location.reload()` (it does this in the warm-
    // restore handshake at wasm-loader.js around line ~1380 when the
    // restore times out, and again at the parent's 180s cross-type
    // canvas-paint watchdog at viewer-public/index.html:1327-1335).
    // Either path destroys the puppeteer Frame handle's contentDocument
    // even though the parent iframe element identity is unchanged, so
    // `editorFrame.evaluate(...)` throws "frame got detached" or
    // "Execution context was destroyed, most likely because of a
    // navigation".
    //
    // On Azure these reloads rarely fire because warm-restore succeeds
    // and the kit paints. On the CI runner Chrome they fire reliably,
    // accounting for ~22 of 60 failing tests (Cluster A from the
    // 2026-05-14 root-cause clustering). All affected tests use the
    // editorFrame returned here for `evaluate`, `waitForFunction`,
    // `isDetached`, or `url` — only those four methods, per grep.
    //
    // Strategy: return a thin object that wraps each of the four
    // methods and, on detach-shaped errors, re-resolves the frame via
    // the same getElementById('editor-frame').src lookup that found it
    // the first time. Up to 3 attempts with 500 ms backoff so a reload
    // that's still in flight gets a chance to settle.
    return { page, editorFrame: makeResilientFrame(page, editorFrame), context };
}

function makeResilientFrame(page, initialFrame) {
    let cached = initialFrame;

    async function _reresolve() {
        const activeUrl = await page.evaluate(() => {
            const el = document.getElementById('editor-frame');
            return el && el.src ? el.src : null;
        }).catch(() => null);
        if (!activeUrl
            || activeUrl.indexOf('cool.html') < 0
            || activeUrl.indexOf('__prewarm_blank') >= 0) {
            return null;
        }
        return page.frames().find(f => f.url() === activeUrl) || null;
    }

    function _isDetachShape(err) {
        const m = err && err.message ? err.message : String(err);
        return /detached|destroyed|not attached|execution context was destroyed/i.test(m);
    }

    function _wrap(method) {
        return async function(...args) {
            for (let attempt = 0; attempt < 3; attempt++) {
                if (!cached || (typeof cached.isDetached === 'function' && cached.isDetached())) {
                    const next = await _reresolve();
                    if (next) cached = next;
                }
                if (!cached) {
                    if (attempt === 2) throw new Error('ResilientFrame: editor-frame gone — no resolvable cool.html iframe');
                    await new Promise(r => setTimeout(r, 500));
                    continue;
                }
                try {
                    return await cached[method](...args);
                } catch (err) {
                    if (attempt < 2 && _isDetachShape(err)) {
                        cached = null;
                        await new Promise(r => setTimeout(r, 500));
                        continue;
                    }
                    throw err;
                }
            }
        };
    }

    return {
        // Re-resolving async methods (the puppeteer Frame surface tests
        // actually use — grep across test-*.js shows only these four).
        evaluate: _wrap('evaluate'),
        waitForFunction: _wrap('waitForFunction'),

        // Sync passthroughs — best-effort against the current cached
        // frame. url() returning '' after detach is the typical Frame
        // behavior so we mirror that.
        url: () => (cached ? cached.url() : ''),
        isDetached: () => (cached ? cached.isDetached() : true),

        // Escape hatch — tests that need the raw Frame (e.g. for
        // page.frames() membership tests) can pull it.
        _frame: () => cached,
    };
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
