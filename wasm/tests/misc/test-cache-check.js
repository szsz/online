// Test whether online.wasm + soffice.data are cached across two page loads in
// the same browser context. Pinpoints exactly why Chrome re-downloads.
const puppeteer = require('puppeteer');
const env = require('./lib/test-env');

const EDITOR = env.EDITOR_URL;
const DOC = 'cache-test.txt';

(async () => {
    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer',
               // Do NOT disable disk cache — we want to test caching
        ],
    });

    // Same browser context — so cache is shared
    const ctx = await browser.defaultBrowserContext();

    async function measureLoad(label) {
        console.log(`\n═══ ${label} ═══`);
        const page = await ctx.newPage();
        const cdp = await page.createCDPSession();
        await cdp.send('Network.enable');
        const events = [];
        cdp.on('Network.requestWillBeSent', e => events.push({ type: 'req', id: e.requestId, url: e.request.url, ts: e.timestamp }));
        cdp.on('Network.requestServedFromCache', e => {
            const ev = events.find(x => x.id === e.requestId);
            if (ev) ev.fromCache = true;
        });
        cdp.on('Network.responseReceived', e => {
            const ev = events.find(x => x.id === e.requestId);
            if (ev) {
                ev.status = e.response.status;
                ev.fromDiskCache = e.response.fromDiskCache;
                ev.fromServiceWorker = e.response.fromServiceWorker;
                ev.encodedDataLength = e.response.encodedDataLength;
                ev.contentEncoding = e.response.headers['content-encoding'];
                ev.contentLength = e.response.headers['content-length'];
                ev.cacheControl = e.response.headers['cache-control'];
                ev.etag = e.response.headers['etag'];
                ev.lastModified = e.response.headers['last-modified'];
            }
        });
        cdp.on('Network.loadingFinished', e => {
            const ev = events.find(x => x.id === e.requestId);
            if (ev) ev.actualBytes = e.encodedDataLength;
        });

        // Upload tiny doc first pass
        if (label.includes('FIRST')) {
            await page.goto(EDITOR, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
            await page.evaluate(async (u, n) => {
                await fetch(u + '/wasm/' + encodeURIComponent(n), { method: 'POST', body: new Blob(['hello']) });
            }, EDITOR, DOC);
        }

        const t0 = Date.now();
        await page.goto(EDITOR + '/browser/cool.html?WOPISrc=' + encodeURIComponent(DOC) + '&access_token=test',
            { waitUntil: 'domcontentloaded', timeout: 30000 });
        // Wait for wasm to at least start
        await page.waitForFunction(() => typeof Module !== 'undefined', { timeout: 60000 }).catch(()=>{});
        // Let downloads settle
        await new Promise(r => setTimeout(r, 8000));
        const elapsed = Date.now() - t0;
        console.log(`  Page ready (module defined) in ~${elapsed}ms of wall clock`);

        // Print interesting resources
        const interesting = events.filter(e =>
            /online\.wasm|soffice\.data|bundle\.js|online\.js$/.test(e.url || '')
        );
        for (const ev of interesting) {
            const name = (ev.url || '').substring((ev.url || '').lastIndexOf('/')+1).split('?')[0];
            console.log(`   ${name}`);
            console.log(`     status=${ev.status}  fromDiskCache=${ev.fromDiskCache}  fromServiceWorker=${ev.fromServiceWorker}  servedFromCache=${ev.fromCache}`);
            console.log(`     bytes=${ev.actualBytes}  encoding=${ev.contentEncoding || '-'}`);
            console.log(`     cache-control=${ev.cacheControl}  etag=${ev.etag || '-'}  last-modified=${ev.lastModified || '-'}`);
        }
        await page.close();
        return { events };
    }

    try {
        await measureLoad('FIRST load (cold cache)');
        await measureLoad('SECOND load (should hit cache)');
    } finally {
        await browser.close();
    }
})();
