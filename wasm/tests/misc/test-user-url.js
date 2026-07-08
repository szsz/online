// One-off diagnostic: open the user's specific URL from two browsers
// and capture console + doc-ready state for each.
'use strict';
const puppeteer = require('puppeteer');
const URL = 'https://viewer.atgpartners.info/#file=r-k3SlUVSwcRHQIJftyp3w';
const T0 = Date.now();
function log(m) { console.log('[' + ((Date.now()-T0)/1000).toFixed(1) + 's] ' + m); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run(label) {
    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 300000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.on('console', m => {
        const t = m.text();
        if (/\[relay\]|WebSocket|hash|locator|CHECKPOINT|activated|Join-response|all sources/i.test(t)) {
            log('[' + label + '] ' + t.substring(0, 240));
        }
    });
    page.on('pageerror', e => log('[' + label + '/PAGEERROR] ' + e.message.substring(0, 200)));
    const navStart = Date.now();
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Install a hook for WasmDocReady (in the parent viewer)
    await page.evaluate(() => {
        window.__docReady = null;
        window.addEventListener('message', function(e) {
            try {
                const m = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
                if (m && m.MessageId === 'WasmDocReady' && !window.__docReady) {
                    window.__docReady = { at: performance.now(), filename: m.Values && m.Values.filename };
                }
            } catch(e) {}
        });
    });

    const deadline = Date.now() + 180000;
    let ready = null;
    while (Date.now() < deadline) {
        ready = await page.evaluate(() => window.__docReady).catch(() => null);
        if (ready) break;
        await sleep(500);
    }
    const wall = Date.now() - navStart;
    log('[' + label + '] ' + (ready ? `READY (wall ${(wall/1000).toFixed(1)}s, filename=${(ready.filename||'').substring(0,16)}…)`
                                    : `STUCK — no WasmDocReady after ${(wall/1000).toFixed(1)}s`));
    return { browser, page, ready };
}

(async () => {
    log('=== Opening user URL from two browsers in parallel ===');
    log('URL: ' + URL);
    const results = await Promise.all([run('A'), run('B')]);
    log('');
    log('A: ' + (results[0].ready ? 'OPENED' : 'STUCK'));
    log('B: ' + (results[1].ready ? 'OPENED' : 'STUCK'));
    for (const r of results) { try { await r.browser.close(); } catch(e) {} }
    process.exit(0);
})();
