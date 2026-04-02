// Test: WASM split loading logic
// Verifies document type detection and correct binary selection.
// Currently uses monolithic fallback (split binaries not yet built).
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE = 'https://wasm.atgpartners.info:6932';
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); }

let allPassed = true;
function check(label, condition) {
    if (condition) { log(`✓ ${label}`); }
    else { log(`✗ FAIL: ${label}`); allPassed = false; }
}

const TEST_FILES = [
    { name: 'test document.docx', src: path.join(__dirname, '..', 'test', 'data', 'test document.docx'), expectedType: 'writer', readySelector: '#StateWordCount', readyText: 'word' },
    { name: 'testdoc.xlsx', src: path.join(__dirname, '..', 'test', 'data', 'testdoc.xlsx'), expectedType: 'calc', readySelector: '#StatusDocPos', readyText: 'Sheet' },
    // pptx not supported yet (sd module not linked)
];

(async () => {
    log('=== WASM Split Loading Test ===');

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    for (const tf of TEST_FILES) {
        log(`\n--- Testing: ${tf.name} (expected: ${tf.expectedType}) ---`);

        // Upload
        if (fs.existsSync(tf.src)) {
            const up = await browser.newPage();
            await up.goto(`${BASE}/editor.html`, { waitUntil: 'networkidle0' });
            const bytes = fs.readFileSync(tf.src);
            await up.evaluate(async (url, name, arr) => {
                await fetch(url + '/wasm/' + encodeURIComponent(name), {
                    method: 'POST', body: new Blob([new Uint8Array(arr)])
                });
            }, BASE, tf.name, Array.from(bytes));
            await up.close();
        }

        const page = await browser.newPage();
        let loaderMsg = '';
        page.on('console', m => {
            if (m.text().includes('wasm-loader')) loaderMsg = m.text();
        });

        const t0 = Date.now();
        await page.goto(`${BASE}/browser/cool.html?WOPISrc=${encodeURIComponent(tf.name)}&access_token=test`, {
            waitUntil: 'domcontentloaded', timeout: 300000,
        });

        // Check document type detection
        const detectedType = await page.evaluate(() => window.__wasmDocType);
        check(`${tf.name}: detected as ${tf.expectedType}`, detectedType === tf.expectedType);

        // Check split/fallback status
        const isSplit = await page.evaluate(() => window.__wasmSplit);
        log(`  split=${isSplit} (fallback to monolithic expected for now)`);

        // Wait for document to load
        try {
            await page.waitForFunction((sel, text) => {
                const el = document.querySelector(sel);
                return el && el.textContent && el.textContent.includes(text);
            }, { timeout: 120000 }, tf.readySelector, tf.readyText);
            const dur = ((Date.now() - t0) / 1000).toFixed(1);
            check(`${tf.name}: loaded in ${dur}s`, true);
        } catch (e) {
            check(`${tf.name}: loaded`, false);
        }

        await page.close();
    }

    await browser.close();
    log('\n' + (allPassed ? '✓ ALL SPLIT LOADING TESTS PASSED' : '✗ SOME TESTS FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
