// Profile the switchdocument pipeline: capture EVERY iframe console message
// during the hot-switch window to build a timing waterfall.
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const env = require('./lib/test-env');

const VIEWER = env.FILE_STORAGE_URL;

(async () => {
    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox','--ignore-certificate-errors','--enable-features=SharedArrayBuffer'],
    });
    const ctx = await browser.createBrowserContext();

    const DOC = 'switchprofile.odt';
    const up = await ctx.newPage();
    await up.goto(VIEWER + '/');
    const bytes = fs.readFileSync(path.join(__dirname, '..', 'test', 'data', '3pages.odt'));
    await up.evaluate(async (n, a) => {
        await fetch('/api/files/' + encodeURIComponent(n), {
            method: 'POST', body: new Blob([new Uint8Array(a)]),
        });
    }, DOC, Array.from(bytes));
    await up.close();

    const page = await ctx.newPage();

    // Capture ALL iframe console output (LOG_INF goes through emscripten print → console.log/warn)
    let recording = false;
    const allMsgs = [];
    page.on('console', m => {
        if (!recording) return;
        allMsgs.push({ t: Date.now(), type: m.type(), text: m.text().substring(0, 300) });
    });

    await page.goto(VIEWER + '/');
    while (true) {
        await sleep(500);
        const fr = page.frames().find(f => f.url().includes('cool.html'));
        if (fr && await fr.evaluate(() => !!window.__wasmPrewarmReady).catch(() => false)) break;
    }
    console.log('Prewarm done.');

    // Start recording, click file
    recording = true;
    const clickT = Date.now();
    await page.evaluate(n => {
        document.querySelector(`.file[data-name="${n}"]`).click();
    }, DOC);

    // Wait 12s
    await sleep(12000);
    recording = false;

    // Print all messages with timestamps
    console.log(`\n=== All messages during switch (${allMsgs.length} lines) ===`);
    const switchDoc = allMsgs.filter(m =>
        /SWITCHDOC|switchdoc|handle_cool_message|KitWS|bridge:|profile|doc:|loaded|status:|prewarm/i.test(m.text));
    if (switchDoc.length > 0) {
        console.log(`\nFiltered SWITCHDOC/bridge/message lines (${switchDoc.length}):`);
        for (const m of switchDoc) {
            console.log(`  +${(m.t - clickT)}ms [${m.type}] ${m.text}`);
        }
    } else {
        console.log('No SWITCHDOC lines found. Showing ALL messages:');
        for (const m of allMsgs.slice(0, 100)) {
            console.log(`  +${(m.t - clickT)}ms [${m.type}] ${m.text}`);
        }
    }

    // Also print the JS-side profile events
    const fr = page.frames().find(f => f.url().includes('cool.html'));
    if (fr) {
        const events = await fr.evaluate(() => window.__prewarmTimings?.events || []).catch(() => []);
        const sw = events.find(e => e.name === 'bridge:switchdoc_sent');
        if (sw) {
            console.log('\n=== JS-side profile ===');
            for (const e of events.filter(e => e.t >= sw.t - 200)) {
                console.log(`  ${String(Math.round(e.t - sw.t)).padStart(6)}ms  ${e.name}  ${e.detail || ''}`);
            }
        }
    }

    await browser.close();
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
