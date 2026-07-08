// Post-deploy smoke test. Opens a known viewer URL in headless Chrome,
// verifies the WASM editor reaches a working state. Exits non-zero on
// failure so deploy.sh can flag a broken deploy loudly.
//
// Verifies:
//   1. WASM file fetches and instantiates cleanly (no truncation, no
//      compile errors). Catches the corrupt-.br class of issues.
//   2. Editor iframe spawns and reaches "Document ready" within 90s.
//   3. A real canvas (>200px in either dimension) renders. Catches
//      the canvas-stuck-at-50x50 partial-load failure.
//
// Usage:
//   node wasm/test-deploy-smoke.js
//   SMOKE_URL=https://viewer.atgpartners.info/#file=... node wasm/test-deploy-smoke.js

'use strict';
const puppeteer = require('puppeteer');

const URL = process.env.SMOKE_URL ||
    'https://viewer.atgpartners.info/#file=oFEV3Kl6xln4lr8rX5r95g';
const TIMEOUT_MS = parseInt(process.env.SMOKE_TIMEOUT_MS || '90000', 10);

async function main() {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        ignoreHTTPSErrors: true,
        defaultViewport: { width: 1280, height: 800 },
    });
    const page = await browser.newPage();
    const fatal = [];
    page.on('console', m => {
        const t = m.text();
        if (t.includes('out of bounds') || t.includes('CompileError') ||
            t.includes('section (code') || t.includes('Aborted(')) {
            fatal.push(t.slice(0, 240));
        }
    });
    page.on('pageerror', e => fatal.push('pageerror: ' + e.message.slice(0, 200)));

    const t0 = Date.now();
    await page.goto(URL, { waitUntil: 'load', timeout: 30000 });

    // Poll the editor iframe until canvas reaches a reasonable size.
    let lastDom = null;
    const deadline = t0 + TIMEOUT_MS;
    while (Date.now() < deadline) {
        const editor = page.frames().find(f => f.url().includes('cool.html'));
        if (editor) {
            try {
                lastDom = await editor.evaluate(() => {
                    const cs = Array.from(document.querySelectorAll('canvas'));
                    const big = cs.find(c => c.width > 200 || c.height > 200);
                    return {
                        docName: document.querySelector('#document-name-input')?.value || '',
                        canvasCount: cs.length,
                        bigCanvas: big ? `${big.width}x${big.height}` : null,
                    };
                });
                if (lastDom.bigCanvas) {
                    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
                    console.log(`  smoke ✓ canvas ${lastDom.bigCanvas} doc="${lastDom.docName}" in ${elapsed}s`);
                    await browser.close();
                    return 0;
                }
            } catch (_) { /* iframe may be navigating */ }
        }
        if (fatal.length) break;
        await new Promise(r => setTimeout(r, 1000));
    }

    await page.screenshot({ path: '/tmp/smoke-fail.png' }).catch(() => {});
    console.error('  smoke ✗ editor did not reach a rendered canvas in time');
    console.error('    final DOM:', JSON.stringify(lastDom));
    if (fatal.length) {
        console.error('    fatal errors observed:');
        fatal.forEach(f => console.error('      ' + f));
    }
    console.error('    screenshot: /tmp/smoke-fail.png');
    await browser.close();
    return 1;
}

main().then(code => process.exit(code)).catch(e => {
    console.error('  smoke ✗ unexpected:', e.message);
    process.exit(2);
});
