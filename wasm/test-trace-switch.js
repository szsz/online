const puppeteer = require('puppeteer');
const VIEWER = env.FILE_STORAGE_URL;
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');

(async () => {
    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });
    const ctx = await browser.createBrowserContext();

    // Pre-upload doc to viewer
    const pre = await ctx.newPage();
    await pre.goto(VIEWER + '/', { waitUntil: 'domcontentloaded' });
    const bytes = fs.readFileSync(path.join(__dirname, '..', 'test', 'data', 'test document.docx'));
    await pre.evaluate(async (n, arr) => {
        await fetch('/api/files/' + encodeURIComponent(n), { method: 'POST', body: new Blob([new Uint8Array(arr)]) });
    }, 'trace-doc.docx', Array.from(bytes));
    await pre.close();

    const page = await ctx.newPage();
    const allMsgs = [];
    page.on('console', m => {
        const t = m.text();
        // Filter for KitWS, switchdoc, load, profile bridge messages
        if (/KitWS|switchdoc|SWITCHDOC|profile.*bridge|profile.*switch|cmd=|load .{0,80}|child-001/i.test(t)) {
            allMsgs.push(`${(Date.now() % 100000)} ${m.type()}: ${t.substring(0, 250)}`);
        }
    });
    page.on('pageerror', e => allMsgs.push(`PE: ${e.message.substring(0, 150)}`));

    const t0 = Date.now();
    await page.goto(VIEWER + '/', { waitUntil: 'domcontentloaded' });
    // Wait prewarm
    await page.waitForFunction(() => window.__viewerState && window.__viewerState.prewarmReady, { timeout: 120000 });
    console.log(`Prewarm at ${Date.now() - t0}ms`);

    // Click file
    await page.evaluate(() => document.querySelector('.file[data-name="trace-doc.docx"]').click());

    // Wait for switch
    await new Promise(r => setTimeout(r, 30000));

    console.log(`\n--- ALL TRACED MESSAGES (${allMsgs.length}) ---`);
    allMsgs.forEach(m => console.log('  ' + m));

    await browser.close();
})();
