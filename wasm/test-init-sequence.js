// Capture the init message sequence sent by COOL JS to WASM
const puppeteer = require('puppeteer');
const URL = 'https://wasm.atgpartners.info:6932';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    const page = await browser.newPage();

    // Capture ALL postMobileMessage calls (before relay-adapter overrides it)
    await page.evaluateOnNewDocument(() => {
        window._initMessages = [];
        // Wrap at the earliest point
        var _origPost = null;
        Object.defineProperty(window, 'postMobileMessage', {
            configurable: true,
            set: function(fn) {
                _origPost = fn;
                // Don't wrap — just capture
            },
            get: function() {
                return function(msg) {
                    window._initMessages.push(msg);
                    if (_origPost) _origPost(msg);
                };
            }
        });
    });

    // Load without relay (direct mode)
    const coolUrl = `${URL}/browser/cool.html?WOPISrc=test-sync.txt&access_token=test`;
    await page.goto(coolUrl, { waitUntil: 'domcontentloaded', timeout: 180000 });

    // Wait for document to fully load
    await page.waitForFunction(() => {
        const el = document.querySelector('#StateWordCount');
        return el && el.textContent && el.textContent.includes('characters');
    }, { timeout: 180000 });

    console.log('Document loaded. Capturing init sequence...');
    await sleep(5000);

    const msgs = await page.evaluate(() => window._initMessages);
    console.log(`\nTotal messages: ${msgs.length}\n`);
    console.log('=== Init sequence (first 50 messages) ===');
    msgs.slice(0, 50).forEach((m, i) => {
        const preview = m.length > 120 ? m.substring(0, 120) + '...' : m;
        console.log(`${i}: ${preview}`);
    });

    await browser.close();
})();
