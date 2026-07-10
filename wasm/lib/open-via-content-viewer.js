// open-via-content-viewer.js — open a local document through the Tresorit
// content-viewer's standalone /collabora-tester flow (the content-viewer
// equivalent of lib/open-via-viewer.js's openViaViewer).
//
// Navigates to <base>/collabora-tester, uploads the file through the real
// file <input>, and waits until the editor iframe has navigated to cool.html.
// The editor then loads the doc in "content-viewer mode" (localFileId +
// /local-file/<id>, served by content-preview's service worker).
//
// Co-edit variants:
//   openViaContentViewer(..., { coEdit: true })  — ticks the tester's
//     "Co-edit" checkbox before uploading, so the tester seeds
//     /shared-file/<room> and opens the editor into a relay room. The
//     result gains `joinLink` (scraped from the tester's join-link field)
//     which a second browser hands to joinViaContentViewer.
//   joinViaContentViewer(browser, joinLink, opts) — navigates straight to
//     the join link (the real user flow: paste the shared URL), waits for
//     the editor iframe. opts.userName rides along as &user=.
//
// Returns { page, editorFrame, base[, joinLink] } — editorFrame may be null
// if the iframe never appeared (caller asserts on that).

'use strict';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForEditorFrame(page, opts = {}) {
    await page.waitForFunction(() => {
        const f = document.querySelector('iframe');
        return !!(f && f.src && f.src.includes('cool.html'));
    }, { timeout: opts.iframeTimeout || 40000 });

    let editorFrame = null;
    const deadline = Date.now() + (opts.frameTimeout || 20000);
    while (Date.now() < deadline && !editorFrame) {
        editorFrame = page.frames().find(f => (f.url() || '').includes('cool.html'));
        if (!editorFrame) await sleep(300);
    }
    return editorFrame;
}

async function openViaContentViewer(browser, base, docPath, opts = {}) {
    base = base.replace(/\/+$/, '');
    const page = opts.page || await browser.newPage();
    await page.setViewport(opts.viewport || { width: 1280, height: 900 });
    if (opts.onConsole) page.on('console', opts.onConsole);
    if (opts.onPageError) page.on('pageerror', opts.onPageError);

    await page.goto(`${base}/collabora-tester`, {
        waitUntil: 'domcontentloaded',
        timeout: opts.gotoTimeout || 60000,
    });

    // Optionally set the tester's "User name" field before opening, so the
    // editor session (and comment authorship) carries that name. It's a
    // controlled React input, so type into it rather than setting .value.
    if (opts.userName) {
        // The tester's toolbar (with the "User name" field) renders after the
        // SPA mounts + asset preload — wait for it rather than querying too early.
        try {
            const nameInput = await page.waitForSelector('input[placeholder="User name"]', { timeout: 15000 });
            await nameInput.click({ clickCount: 3 });
            await nameInput.type(opts.userName);
        } catch (e) { /* field absent (non-tester route) — skip */ }
    }

    // Co-edit create: tick the tester's checkbox (real user input) BEFORE
    // uploading — the upload handler reads it to decide create-vs-plain.
    if (opts.coEdit) {
        const box = await page.waitForSelector('[data-testid="coedit-checkbox"]', {
            timeout: opts.inputTimeout || 20000,
        });
        await box.click();
    }

    // The tester's file <input> may be hidden behind an "Open file" button;
    // uploadFile works on hidden inputs directly.
    const input = await page.waitForSelector('input[type=file]', {
        timeout: opts.inputTimeout || 20000,
    });
    await input.uploadFile(docPath);

    // The SPA stages the file into its SW (and, for co-edit, seeds
    // /shared-file/<room>), then points the editor iframe at
    // cool.html?...&localFileId=...
    const editorFrame = await waitForEditorFrame(page, opts);

    let joinLink = null;
    if (opts.coEdit) {
        try {
            const linkEl = await page.waitForSelector('[data-testid="coedit-join-link"]', { timeout: 15000 });
            joinLink = await linkEl.evaluate(el => el.value);
        } catch (e) { /* caller asserts on null joinLink */ }
    }
    return { page, editorFrame, base, joinLink };
}

async function joinViaContentViewer(browser, joinLink, opts = {}) {
    const page = opts.page || await browser.newPage();
    await page.setViewport(opts.viewport || { width: 1280, height: 900 });
    if (opts.onConsole) page.on('console', opts.onConsole);
    if (opts.onPageError) page.on('pageerror', opts.onPageError);

    let url = joinLink;
    if (opts.userName) url += '&user=' + encodeURIComponent(opts.userName);
    await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: opts.gotoTimeout || 60000,
    });

    const editorFrame = await waitForEditorFrame(page, opts);
    return { page, editorFrame };
}


// ── Migration harness (full-suite port from the legacy viewer) ──────
//
// Legacy tests hold document BYTES in memory and call
// openViaViewer(browser, FILE_STORAGE_URL, name, bytes, opts). These
// wrappers give them a drop-in content-viewer shape:
//
//   openBytesViaContentViewer(browser, base, name, bytes, opts)
//     writes the bytes to a temp file and drives the real
//     /collabora-tester upload. Extra opts pass through (userName,
//     viewport, page, coEdit, ...).
//
//   openCoEditPair(browser, base, name, bytes, opts)
//     A creates a co-edit session (tester checkbox), B joins the link in
//     an ISOLATED browser context. Returns
//     { A: {page, editorFrame}, B: {page, editorFrame}, joinLink }.
//     opts: userA/userB (names), viewport, budgets.
//
//   waitCvInteractive(page, budgetMs)
//     the canonical "document open finished" wait for the tester host:
//     spinner gone + Save button enabled (Document_Loaded reached the
//     host). Poll this instead of legacy shield/prewarm signals.
//
//   cvCharCount(page) / waitCvCharCount(page, pred, budgetMs)
//     #StateWordCount character count from the live editor frame
//     (re-resolved every poll — survives re-opens).

const fs = require('fs');
const os = require('os');
const path = require('path');

async function openBytesViaContentViewer(browser, base, name, bytes, opts = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-open-'));
    const p = path.join(dir, name);
    fs.writeFileSync(p, bytes);
    const r = await openViaContentViewer(browser, base, p, opts);
    return Object.assign(r, { docPath: p, tmpDir: dir });
}

async function waitCvInteractive(page, budgetMs = 300000) {
    const d = Date.now() + budgetMs;
    while (Date.now() < d) {
        const ok = await page.evaluate(() => {
            if (document.querySelector('[role="status"][aria-label="Loading"]')) return false;
            const s = [...document.querySelectorAll('button')]
                .find(b => /^save$/i.test((b.textContent || '').trim()));
            return !!(s && !s.disabled);
        }).catch(() => false);
        if (ok) return true;
        await sleep(500);
    }
    return false;
}

function cvEditorFrame(page) {
    return page.frames().find(f => (f.url() || '').includes('cool.html')) || null;
}

async function cvCharCount(page) {
    const fr = cvEditorFrame(page);
    if (!fr) return -1;
    return fr.evaluate(() => {
        const t = document.querySelector('#StateWordCount')?.textContent || '';
        const m = t.match(/([\d,.]+)\s+character/i);
        return m ? parseInt(m[1].replace(/[,.]/g, ''), 10) : -1;
    }).catch(() => -1);
}

async function waitCvCharCount(page, pred, budgetMs = 60000) {
    const d = Date.now() + budgetMs;
    let last = -1;
    while (Date.now() < d) {
        last = await cvCharCount(page);
        if (pred(last)) return last;
        await sleep(500);
    }
    return last;
}

async function openCoEditPair(browser, base, name, bytes, opts = {}) {
    const viewport = opts.viewport || { width: 1280, height: 900 };
    const A = await openBytesViaContentViewer(browser, base, name, bytes, {
        userName: opts.userA || 'User A', coEdit: true,
        viewport, iframeTimeout: opts.iframeTimeout || 60000,
        onConsole: opts.onConsoleA, page: opts.pageA,
    });
    if (!A.joinLink) throw new Error('openCoEditPair: no join link (co-edit create failed)');
    if (!(await waitCvInteractive(A.page, opts.loadBudgetMs || 300000)))
        throw new Error('openCoEditPair: A never became interactive');
    const ctxB = await browser.createBrowserContext();
    const pageB = await ctxB.newPage();
    const B = await joinViaContentViewer(browser, A.joinLink, {
        page: pageB, userName: opts.userB || 'User B',
        viewport, iframeTimeout: opts.iframeTimeout || 90000,
        onConsole: opts.onConsoleB,
    });
    if (!(await waitCvInteractive(B.page, opts.loadBudgetMs || 300000)))
        throw new Error('openCoEditPair: B never became interactive');
    return { A, B, joinLink: A.joinLink, contextB: ctxB };
}

module.exports = {
    openViaContentViewer, joinViaContentViewer,
    openBytesViaContentViewer, openCoEditPair,
    waitCvInteractive, cvEditorFrame, cvCharCount, waitCvCharCount,
};
