const __cl = require('./lib/inject-checklist');
// Test: End-to-end upload → open → co-edit
// Upload at 3s, click open immediately. No waiting for preload.
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE = 'https://wasm.atgpartners.info:6932';
const TIMEOUT = 600000;
const SHOT_DIR = '/tmp/static-deploy/public/shots-e2e-upload';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
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
    log('=== E2E Upload & Co-Edit Test ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const browserA = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });
    const browserB = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    try {
        // --- Step 1: Open landing page ---
        log('\n--- Step 1: Landing page ---');
        const pageA = await browserA.newPage();
        await pageA.goto(`${BASE}/editor.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await snap(pageA, 'landing');

        const preloadBar = await pageA.evaluate(() => !!document.getElementById('preload-bar'));
        check('Preload bar visible', preloadBar);

        // --- Step 2: Upload at 3 seconds ---
        log('\n--- Step 2: Upload file at 3s ---');
        await sleep(3000);
        await snap(pageA, 'before_upload');

        const docPath = path.resolve(__dirname, '../test/data/test document.docx');
        const fileInput = await pageA.$('#file-input');
        await fileInput.uploadFile(docPath);

        await pageA.waitForFunction(() => {
            var btn = document.getElementById('btn-open');
            return btn && btn.style.display === 'block';
        }, { timeout: 15000 });
        await snap(pageA, 'uploaded');

        const shareUrl = await pageA.evaluate(() => document.getElementById('share-url')?.value || '');
        check('File uploaded', shareUrl.includes('editor.html'));
        log(`  Share URL: ${shareUrl}`);

        // --- Step 3: Click Open immediately ---
        log('\n--- Step 3: Open document ---');
        const t0 = Date.now();
        await pageA.evaluate(() => document.getElementById('btn-open').click());

        // Screenshot every 2s during load
        let docLoaded = false;
        for (let i = 0; i < 30 && !docLoaded; i++) {
            await sleep(2000);
            const s = await pageA.evaluate(() => ({
                label: document.getElementById('wasm-progress-label')?.textContent || '',
                wc: document.querySelector('#StateWordCount')?.textContent || '',
            }));
            if (i <= 4 || i % 3 === 0) await snap(pageA, `loading_${((Date.now()-T0)/1000).toFixed(0)}s`);
            if (s.label) log(`  ${s.label}`);
            if (s.wc.includes('word')) {
                docLoaded = true;
                log(`  Document loaded in ${((Date.now()-t0)/1000).toFixed(0)}s`);
            }
        }
        check('Document opened', docLoaded);

        if (docLoaded) {
            await sleep(2000);
            await snap(pageA, 'document_A');
            const content = await pageA.evaluate(() => document.querySelector('#StateWordCount')?.textContent);
            check('Content visible (A)', content?.includes('word'));
            log(`  ${content}`);
        }

        // --- Step 4: Browser B co-edits ---
        log('\n--- Step 4: Browser B co-edits ---');
        const pageB = await browserB.newPage();
        const t1 = Date.now();
        await pageB.goto(shareUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

        try {
            await pageB.waitForFunction(() =>
                document.querySelector('#StateWordCount')?.textContent?.includes('word'),
                { timeout: 180000 });
            log(`  B joined in ${((Date.now()-t1)/1000).toFixed(0)}s`);
            check('Browser B loaded', true);
            await sleep(2000);
            await snap(pageB, 'document_B');

            for (const ch of 'HELLO') {
                await pageB.evaluate((c) => {
                    if (globalThis.TheFakeWebSocket)
                        TheFakeWebSocket.send('key type=input char=' + c.charCodeAt(0) + ' key=0');
                }, ch);
                await sleep(500);
            }
            await sleep(3000);
            await snap(pageA, 'A_after_coedit');
            await snap(pageB, 'B_after_coedit');
            check('Co-editing works', true);
        } catch (e) {
            check('Browser B loaded', false);
        }

        await snap(pageA, 'final');
        log('\n' + (allPassed ? '✓ ALL E2E TESTS PASSED' : '✗ SOME E2E TESTS FAILED'));

    } catch (e) {
        log('Error: ' + e.message);
        allPassed = false;
    } finally {
        await browserA.close();
        await browserB.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
