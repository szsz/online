// Regression: viewer arms the WOPI postMessage gate.
//
// Background: cool.html (the WASM kit) gates its WOPI postMessage
// handler on window.WOPIPostmessageReady (browser/src/map/handler/
// Map.WOPI.js:541). The flag is set to true in browser/js/global.js:449
// only when the kit receives a {MessageId: 'Host_PostmessageReady'}
// message from the parent host. Pre-fix, our viewer
// (wasm/viewer-public/index.html) NEVER sent that message, so every
// WOPI postMessage from viewer→kit got dropped with the noisy
// "PostMessage ignored: not ready." log line that fills failing test
// logs. Fix: an `armWOPIReady(iframe)` helper that adds a load listener
// to post Host_PostmessageReady — wired into the initial iframe load
// and into the cold-typechange new-iframe creation path.
//
// This test asserts the deployed-shape and source-shape of the fix:
//   1. wasm/viewer-public/index.html defines armWOPIReady (so the
//      helper exists at all).
//   2. armWOPIReady posts Host_PostmessageReady — exact wording.
//   3. armWOPIReady is wired BEFORE iframe.src = on the prewarm path.
//   4. armWOPIReady is wired on the cold-typechange newIframe path.
//   5. End-to-end: a deployed viewer page boots an editor iframe and
//      window.WOPIPostmessageReady inside the iframe becomes true.
//
// The first 4 checks are source-only (~1s). #5 spins a real puppeteer
// browser against the viewer (~10-15s).

'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const __cl = require('../../lib/inject-checklist');

const VIEWER = env.VIEWER_URL;
const REPO_WASM_DIR = path.resolve(__dirname, '..', '..');

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) console.log('  ✓ ' + label);
    else {
        console.log('  ✗ FAIL: ' + label + (ev ? ' [' + ev + ']' : ''));
        allPassed = false;
    }
}

(async () => {
    console.log('=== Regression: viewer arms WOPI postMessage gate ===');
    const t0 = Date.now();

    // 1-4. Source-shape checks on viewer-public/index.html.
    const src = fs.readFileSync(
        path.join(REPO_WASM_DIR, 'viewer-public/index.html'), 'utf8');

    check('viewer defines armWOPIReady helper',
        /function\s+armWOPIReady\s*\(/.test(src));
    check('armWOPIReady posts Host_PostmessageReady',
        /armWOPIReady[\s\S]{0,800}?MessageId['"\s:]+['"]Host_PostmessageReady/.test(src));
    check('armWOPIReady called on prewarm iframe before src=',
        /armWOPIReady\(iframe\)[\s\S]{0,200}?iframe\.src\s*=/.test(src));
    check('armWOPIReady called on cold-typechange newIframe',
        /armWOPIReady\(newIframe\)/.test(src));

    // 5. End-to-end: boot the viewer and read WOPIPostmessageReady.
    const { launch } = require('../../lib/browser');
    const { browser, cleanup } = await launch();
    try {
        const page = await browser.newPage();
        let kitGotReady = false;
        page.on('console', msg => {
            const t = msg.text();
            if (/Received Host_PostmessageReady/.test(t)) kitGotReady = true;
        });

        await page.goto(VIEWER + '/', { timeout: env.scaleTimeout(60000) });

        // Wait for cool.html iframe to mount and for global.js's
        // postMessageHandler to flip WOPIPostmessageReady. The viewer
        // does prewarm immediately on load, so the iframe should exist
        // within seconds. Poll the iframe's window for the flag.
        const deadline = Date.now() + env.scaleTimeout(60000);
        let ready = false;
        let lastErr = null;
        while (Date.now() < deadline) {
            try {
                const frame = page.frames().find(f =>
                    /\/browser\/dist\/cool\.html/.test(f.url()));
                if (frame) {
                    ready = await frame.evaluate(
                        () => !!window.WOPIPostmessageReady);
                    if (ready) break;
                }
            } catch (e) { lastErr = e.message; }
            await new Promise(r => setTimeout(r, 500));
        }
        check('iframe.WOPIPostmessageReady=true within budget',
            ready, lastErr || (kitGotReady ? 'kit logged ready' : 'never set'));
    } finally {
        await cleanup();
    }

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e);
    process.exit(2);
});
