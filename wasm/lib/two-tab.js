// lib/two-tab.js — utilities for puppeteer tests that drive TWO COOL
// tabs (or browsers). All access to the editor iframe goes through
// re-acquiring helpers so a viewer-side `replaceChild` of
// `#editor-frame.src` mid-test doesn't poison every subsequent
// frame.evaluate / waitForFunction with `Error: frame got detached`.
//
// Pattern: any time you'd write
//     await frame.waitForFunction(() => ...);
// instead write
//     await waitInFrame(page, () => ..., { timeout: 60000 });
// and the helper will re-resolve the active cool.html frame each
// poll, surviving up to N iframe replacements.
//
// History:
//   - openSecretInBrowser (lib/open-via-viewer.js) already returns
//     the frame that's loading the FILE (not the bootstrap blank). But
//     in scenarios where the viewer fires a SECOND replaceChild after
//     return (kit switchdoc, watchdog reload, prewarm re-shuffle), the
//     returned frame ref still becomes stale.
//   - regression-paste-coedit, mouse-select-copypaste, and the e2e/
//     latejoin/paste-table tests all hit this. Each used to embed its
//     own ad-hoc retry; this lib centralises the pattern so future
//     fixes touch ONE place.

'use strict';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Resolve the iframe that's currently displaying the FILE (not the
// bootstrap blank-docx prewarm). Always queries the DOM fresh — never
// hands back a stale ref. Returns null if not found yet.
async function getActiveEditorFrame(page) {
    try {
        const activeUrl = await page.evaluate(() => {
            const el = document.getElementById('editor-frame');
            return el && el.src ? el.src : null;
        }).catch(() => null);
        if (!activeUrl || activeUrl.indexOf('cool.html') < 0) return null;
        if (activeUrl.indexOf('__prewarm_blank') >= 0) return null;
        return page.frames().find(f => f.url() === activeUrl) || null;
    } catch (_) { return null; }
}

// Like frame.waitForFunction(predicate) but re-resolves the frame on
// every poll. Survives mid-test iframe replacements that would
// otherwise produce `frame got detached`. predicate runs INSIDE the
// editor frame and must return truthy when the condition is met.
async function waitInFrame(page, predicate, opts) {
    opts = opts || {};
    const timeout = opts.timeout || 60000;
    const pollInterval = opts.pollInterval || 250;
    const deadline = Date.now() + timeout;
    const predStr = predicate.toString();
    let lastErr = null;
    while (Date.now() < deadline) {
        const frame = await getActiveEditorFrame(page);
        if (frame) {
            try {
                const r = await frame.evaluate(new Function('return (' + predStr + ')()'));
                if (r) return r;
            } catch (e) {
                // `frame got detached`, `Execution context was destroyed`,
                // or `Target closed` — all recoverable by re-resolving on
                // the next poll. Capture the most recent error for the
                // post-timeout exception message.
                lastErr = e;
            }
        }
        await sleep(pollInterval);
    }
    const reason = lastErr ? ' (last error: ' + (lastErr.message || lastErr) + ')' : '';
    throw new Error('waitInFrame timed out after ' + timeout + 'ms' + reason);
}

// Run a single evaluate inside the active editor frame, with one
// retry on detach. For one-shot reads (char count, selection text,
// etc.) where waitInFrame's polling is overkill.
async function evalInFrame(page, fn, ...args) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const frame = await getActiveEditorFrame(page);
        if (frame) {
            try { return await frame.evaluate(fn, ...args); }
            catch (e) {
                if (attempt === 2) throw e;
                await sleep(300);
                continue;
            }
        }
        await sleep(300);
    }
    throw new Error('evalInFrame: no active editor frame after 3 attempts');
}

// Wait for the editor to reach the "doc loaded + state bar populated"
// state. Replaces the common pair of frame.waitForFunction calls in
// every 2-browser test:
//     await frame.waitForFunction(() => window.__wasmInitialDocLoaded === true);
//     await frame.waitForFunction(() =>
//         /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''));
async function waitForDocReady(page, opts) {
    opts = opts || {};
    const timeout = opts.timeout || 90000;
    await waitInFrame(page,
        () => window.__wasmInitialDocLoaded === true,
        { timeout });
    await waitInFrame(page,
        () => /character/i.test(
            document.querySelector('#StateWordCount')?.textContent || ''),
        { timeout: Math.min(timeout, 30000) });
}

// Read the current character count from the state bar. -1 if the
// state bar isn't populated yet.
async function getCharCount(page) {
    return evalInFrame(page, () => {
        const t = document.querySelector('#StateWordCount')?.textContent || '';
        const m = t.match(/([\d,]+)\s*character/);
        return m ? parseInt(m[1].replace(/,/g, '')) : -1;
    }).catch(() => -1);
}

// Wait until the character count satisfies pred(count). Useful for
// "doc grew by at least N" assertions after paste / type.
async function waitForCharCount(page, pred, opts) {
    opts = opts || {};
    const timeout = opts.timeout || 12000;
    const deadline = Date.now() + timeout;
    let last = -1;
    while (Date.now() < deadline) {
        last = await getCharCount(page);
        if (pred(last)) return last;
        await sleep(250);
    }
    return last;
}

module.exports = {
    getActiveEditorFrame,
    waitInFrame,
    evalInFrame,
    waitForDocReady,
    getCharCount,
    waitForCharCount,
};
