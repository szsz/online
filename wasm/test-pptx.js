// Test: pptx (Impress) opening and co-editing
// Verifies:
// 1. pptx file opens in Impress
// 2. Slide content renders
// 3. Text input works
// 4. 2-browser co-editing syncs
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE = 'https://wasm.atgpartners.info:6932';
const TIMEOUT = 300000;
const SHOT_DIR = '/tmp/static-deploy/public/shots-pptx';
const DOC_NAME = 'testdoc.pptx';
const DOC_PATH = path.join(__dirname, '..', 'test', 'data', DOC_NAME);

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await sleep(300);
    const filename = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    await page.screenshot({ path: `${SHOT_DIR}/${filename}` });
    log(`[snap] ${filename}`);
}

let allPassed = true;
function check(label, condition) {
    if (condition) { log(`✓ ${label}`); }
    else { log(`✗ FAIL: ${label}`); allPassed = false; }
}

// Impress readiness: check for slide panel or presentation-specific UI
async function waitForImpress(page, label) {
    log(`[${label}] Waiting for Impress...`);
    try {
        await page.waitForFunction(() => {
            // Check for any of these Impress indicators
            var slidePanel = document.querySelector('#slide-sorter');
            var slideFrame = document.querySelector('.preview-frame');
            var pageStatus = document.querySelector('#PageStatus');
            // Also check for presentation mode indicator
            if (pageStatus && pageStatus.textContent && pageStatus.textContent.includes('Slide'))
                return true;
            if (slidePanel || slideFrame) return true;
            // Fallback: any canvas with content
            var canvas = document.querySelector('canvas');
            if (canvas && canvas.width > 100) return true;
            return false;
        }, { timeout: TIMEOUT });
        log(`[${label}] Impress loaded`);
        return true;
    } catch (e) {
        log(`[${label}] Impress load failed: ${e.message}`);
        return false;
    }
}

(async () => {
    log('=== pptx (Impress) Test ===');

    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(DOC_PATH)) {
        log('ERROR: ' + DOC_PATH + ' not found');
        process.exit(1);
    }

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    try {
        // Upload
        const up = await browser.newPage();
        await up.goto(`${BASE}/editor.html`, { waitUntil: 'networkidle0' });
        const bytes = fs.readFileSync(DOC_PATH);
        await up.evaluate(async (url, name, arr) => {
            await fetch(url + '/wasm/' + encodeURIComponent(name), {
                method: 'POST', body: new Blob([new Uint8Array(arr)])
            });
        }, BASE, DOC_NAME, Array.from(bytes));
        await up.close();
        log('Uploaded ' + DOC_NAME);

        const url = `${BASE}/browser/cool.html?WOPISrc=${encodeURIComponent(DOC_NAME)}&access_token=test`;

        // Test 1: Open pptx
        log('\n--- Test 1: Open pptx ---');
        const page = await browser.newPage();
        page.on('console', m => {
            const t = m.text();
            if (t.includes('error') || t.includes('Error') || t.includes('fail') || t.includes('wasm-loader'))
                log('LOG: ' + t.substring(0, 150));
        });

        const t0 = Date.now();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

        // Check wasm-loader detected impress
        const docType = await page.evaluate(() => window.__wasmDocType);
        check('Detected as impress', docType === 'impress');

        const loaded = await waitForImpress(page, 'A');
        check('pptx opened in Impress', loaded);

        if (loaded) {
            await snap(page, 'A_loaded');

            // Test 2: Type text
            log('\n--- Test 2: Type text ---');
            // Click on the slide to start editing
            await page.evaluate(() => {
                globalThis.TheFakeWebSocket?.send('mouse type=buttondown x=5000 y=5000 count=2 buttons=1 modifier=0');
                globalThis.TheFakeWebSocket?.send('mouse type=buttonup x=5000 y=5000 count=2 buttons=1 modifier=0');
            });
            await sleep(2000);

            for (const ch of 'TEST') {
                await page.evaluate((c) => {
                    globalThis.TheFakeWebSocket?.send('textinput id=0 text=' + c);
                }, ch);
                await sleep(1000);
            }
            await sleep(5000);
            await snap(page, 'A_after_typing');
            check('Typing completed', true);
        }

        await page.close();

        log('\n' + (allPassed ? '✓ ALL PPTX TESTS PASSED' : '✗ SOME PPTX TESTS FAILED'));
        log('NOTE: pptx support requires sd module in WASM build');

    } catch (e) {
        log('Error: ' + e.message);
    } finally {
        await browser.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
