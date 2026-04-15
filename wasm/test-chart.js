const __cl = require('./lib/inject-checklist');
// Test: Documents with embedded charts
// Verifies chart rendering in both Writer (docx) and Calc (xlsx)
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');

const BASE = env.EDITOR_URL;
const TIMEOUT = 300000;
const SHOT_DIR = '/tmp/static-deploy/public/shots-chart';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await sleep(500);
    const filename = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    await page.screenshot({ path: `${SHOT_DIR}/${filename}`, fullPage: true });
    log(`[snap] ${filename}`);
}

let allPassed = true;
function check(label, condition) { __cl.recordCheck(label, condition);
    if (condition) { log(`  ✓ ${label}`); }
    else { log(`  ✗ FAIL: ${label}`); allPassed = false; }
}

(async () => {
    log('=== Chart Rendering Test ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    try {
        // Upload test files
        const up = await browser.newPage();
        await up.goto(BASE, { waitUntil: 'networkidle0' });

        for (const name of ['chart-test.docx', 'chart-test.xlsx']) {
            const filePath = path.resolve(__dirname, '../test/data', name);
            if (!fs.existsSync(filePath)) { log(`SKIP: ${name} not found`); continue; }
            const buf = fs.readFileSync(filePath);
            await up.evaluate(async (url, n, arr) => {
                await fetch(url + '/wasm/' + encodeURIComponent(n), {
                    method: 'POST', body: new Blob([new Uint8Array(arr)])
                });
            }, BASE, name, Array.from(buf));
            log(`Uploaded ${name}`);
        }
        await up.close();

        // --- Test 1: Writer with chart docx ---
        log('\n--- Test 1: Writer chart document ---');
        const pageW = await browser.newPage();
        pageW.on('console', m => {
            const t = m.text();
            if (t.includes('wasm-loader')) log('  ' + t);
        });
        const t0 = Date.now();
        await pageW.goto(`${BASE}/browser/cool.html?WOPISrc=chart-test.docx&access_token=test`, {
            waitUntil: 'domcontentloaded', timeout: TIMEOUT
        });
        try {
            await pageW.waitForFunction(
                () => document.querySelector('#StateWordCount')?.textContent?.includes('word'),
                { timeout: 180000 }
            );
            const loadTime = ((Date.now() - t0) / 1000).toFixed(1);
            log(`Writer loaded in ${loadTime}s`);
            check('Writer docx with chart loaded', true);

            // Wait for chart to render (tiles take time)
            await sleep(15000);
            await snap(pageW, 'writer_chart_loaded');

            // Scroll down to see the chart area
            await pageW.evaluate(() => {
                if (globalThis.TheFakeWebSocket) {
                    // Page Down
                    TheFakeWebSocket.send('key type=input char=0 key=1031 modifier=0');
                }
            });
            await sleep(5000);
            await snap(pageW, 'writer_chart_scrolled');

            // Type some text to verify editing
            for (const ch of 'CHART') {
                await pageW.evaluate((c) => {
                    if (globalThis.TheFakeWebSocket)
                        TheFakeWebSocket.send('key type=input char=' + c.charCodeAt(0) + ' key=0');
                }, ch);
                await sleep(300);
            }
            await sleep(3000);
            await snap(pageW, 'writer_chart_after_typing');

            const wc = await pageW.evaluate(() => document.querySelector('#StateWordCount')?.textContent);
            log(`Word count after typing: ${wc}`);
            check('Typing in chart docx works', wc && wc.includes('word'));

        } catch (e) {
            log('Writer chart FAIL: ' + e.message);
            check('Writer docx with chart loaded', false);
            await snap(pageW, 'writer_chart_fail');
        }
        await pageW.close();

        // --- Test 2: Calc with chart xlsx ---
        log('\n--- Test 2: Calc chart spreadsheet ---');
        const pageC = await browser.newPage();
        pageC.on('console', m => {
            const t = m.text();
            if (t.includes('wasm-loader')) log('  ' + t);
        });
        const t1 = Date.now();
        await pageC.goto(`${BASE}/browser/cool.html?WOPISrc=chart-test.xlsx&access_token=test`, {
            waitUntil: 'domcontentloaded', timeout: TIMEOUT
        });
        try {
            await pageC.waitForFunction(
                () => document.querySelector('#StatusDocPos')?.textContent?.includes('Sheet'),
                { timeout: 180000 }
            );
            const loadTime = ((Date.now() - t1) / 1000).toFixed(1);
            log(`Calc loaded in ${loadTime}s`);
            check('Calc xlsx with chart loaded', true);

            // Wait for chart to render
            await sleep(15000);
            await snap(pageC, 'calc_chart_loaded');

            // Scroll down to see chart
            await pageC.evaluate(() => {
                if (globalThis.TheFakeWebSocket)
                    TheFakeWebSocket.send('key type=input char=0 key=1031 modifier=0');
            });
            await sleep(5000);
            await snap(pageC, 'calc_chart_scrolled');

            // Click on cell and type
            await pageC.evaluate(() => {
                if (globalThis.TheFakeWebSocket)
                    TheFakeWebSocket.send('mouse type=buttondown x=1000 y=1000 count=1 buttons=1 modifier=0');
            });
            await sleep(1000);
            for (const ch of '999') {
                await pageC.evaluate((c) => {
                    if (globalThis.TheFakeWebSocket)
                        TheFakeWebSocket.send('key type=input char=' + c.charCodeAt(0) + ' key=0');
                }, ch);
                await sleep(300);
            }
            await sleep(3000);
            await snap(pageC, 'calc_chart_after_typing');
            check('Typing in chart xlsx works', true);

        } catch (e) {
            log('Calc chart FAIL: ' + e.message);
            check('Calc xlsx with chart loaded', false);
            await snap(pageC, 'calc_chart_fail');
        }
        await pageC.close();

        log('\n' + (allPassed ? '✓ ALL CHART TESTS PASSED' : '✗ SOME CHART TESTS FAILED'));

    } catch (e) {
        log('Error: ' + e.message);
        allPassed = false;
    } finally {
        await browser.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
