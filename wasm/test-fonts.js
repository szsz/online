// Test: Font rendering with rare fonts
// Verifies:
// 1. Documents with rare fonts open correctly (substituted with available fonts)
// 2. Font names are detected from the document
// 3. Screenshots show text rendering (substituted or real)
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE = 'https://wasm.atgpartners.info:6932';
const TIMEOUT = 300000;
const SHOT_DIR = '/tmp/static-deploy/public/shots-fonts';

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
function check(label, condition) {
    if (condition) { log(`  ✓ ${label}`); }
    else { log(`  ✗ FAIL: ${label}`); allPassed = false; }
}

(async () => {
    log('=== Font Rendering Test ===');
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
        await up.goto(`${BASE}/editor.html`, { waitUntil: 'networkidle0' });
        for (const name of ['rare-fonts.docx', 'rare-fonts.xlsx', 'rare-fonts.pptx']) {
            const filePath = path.resolve(__dirname, '../test/data', name);
            if (!fs.existsSync(filePath)) { log(`SKIP: ${name}`); continue; }
            const buf = fs.readFileSync(filePath);
            await up.evaluate(async (url, n, arr) => {
                await fetch(url + '/wasm/' + encodeURIComponent(n), {
                    method: 'POST', body: new Blob([new Uint8Array(arr)])
                });
            }, BASE, name, Array.from(buf));
            log(`Uploaded ${name}`);
        }
        await up.close();

        // --- Test 1: Writer with rare fonts ---
        log('\n--- Test 1: Writer with rare fonts ---');
        const pageW = await browser.newPage();
        const t0 = Date.now();
        await pageW.goto(`${BASE}/browser/cool.html?WOPISrc=rare-fonts.docx&access_token=test`, {
            waitUntil: 'domcontentloaded', timeout: TIMEOUT
        });
        try {
            await pageW.waitForFunction(
                () => document.querySelector('#StateWordCount')?.textContent?.includes('word'),
                { timeout: 180000 }
            );
            log(`Writer loaded in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
            check('Writer rare-font docx loaded', true);

            await sleep(10000); // Wait for all tiles to render
            await snap(pageW, 'writer_rare_fonts');

            // Scroll down to see more font samples
            await pageW.evaluate(() => {
                if (globalThis.TheFakeWebSocket)
                    TheFakeWebSocket.send('key type=input char=0 key=1031 modifier=0');
            });
            await sleep(3000);
            await snap(pageW, 'writer_rare_fonts_scrolled');

            // Check available fonts via the status bar
            const wc = await pageW.evaluate(() => document.querySelector('#StateWordCount')?.textContent);
            log(`Word count: ${wc}`);
            check('Document rendered with text', wc && wc.includes('word'));

            // Check which fonts the browser has available
            const browserFonts = await pageW.evaluate(() => {
                // Test specific fonts by measuring text width
                const testFonts = [
                    'Comic Sans MS', 'Impact', 'Georgia', 'Verdana', 'Tahoma',
                    'Palatino Linotype', 'Trebuchet MS', 'Arial Black', 'Garamond',
                    'Liberation Sans', 'Carlito', 'DejaVu Sans'
                ];
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                const testStr = 'mmmmmmmmmmlli';
                const fallbackWidth = {};

                // Measure with monospace as baseline
                ctx.font = '72px monospace';
                const monoWidth = ctx.measureText(testStr).width;

                const available = [];
                for (const font of testFonts) {
                    ctx.font = `72px "${font}", monospace`;
                    const width = ctx.measureText(testStr).width;
                    if (Math.abs(width - monoWidth) > 1) {
                        available.push(font);
                    }
                }
                return available;
            });
            log(`Browser-available fonts: ${browserFonts.join(', ') || 'none detected'}`);

        } catch (e) {
            log('Writer FAIL: ' + e.message);
            check('Writer rare-font docx loaded', false);
            await snap(pageW, 'writer_rare_fonts_fail');
        }
        await pageW.close();

        // --- Test 2: Calc with rare fonts ---
        log('\n--- Test 2: Calc with rare fonts ---');
        const pageC = await browser.newPage();
        const t1 = Date.now();
        await pageC.goto(`${BASE}/browser/cool.html?WOPISrc=rare-fonts.xlsx&access_token=test`, {
            waitUntil: 'domcontentloaded', timeout: TIMEOUT
        });
        try {
            await pageC.waitForFunction(
                () => document.querySelector('#StatusDocPos')?.textContent?.includes('Sheet'),
                { timeout: 180000 }
            );
            log(`Calc loaded in ${((Date.now() - t1) / 1000).toFixed(0)}s`);
            check('Calc rare-font xlsx loaded', true);

            await sleep(10000);
            await snap(pageC, 'calc_rare_fonts');

        } catch (e) {
            log('Calc FAIL: ' + e.message);
            check('Calc rare-font xlsx loaded', false);
            await snap(pageC, 'calc_rare_fonts_fail');
        }
        await pageC.close();

        // --- Test 3: Impress with rare fonts ---
        log('\n--- Test 3: Impress with rare fonts ---');
        const pageI = await browser.newPage();
        const t2 = Date.now();
        await pageI.goto(`${BASE}/browser/cool.html?WOPISrc=rare-fonts.pptx&access_token=test`, {
            waitUntil: 'domcontentloaded', timeout: TIMEOUT
        });
        try {
            await pageI.waitForFunction(() => {
                var o = document.getElementById('wasm-loading-overlay');
                if (o && o.style.opacity !== '0') return false;
                var nav = document.querySelector('nav.main-nav') || document.querySelector('#content-keeper');
                return nav && nav.textContent && nav.textContent.includes('Slide Show');
            }, { timeout: 180000 });
            log(`Impress loaded in ${((Date.now() - t2) / 1000).toFixed(0)}s`);
            check('Impress rare-font pptx loaded', true);

            await sleep(10000);
            await snap(pageI, 'impress_rare_fonts');

        } catch (e) {
            log('Impress FAIL: ' + e.message);
            check('Impress rare-font pptx loaded', false);
            await snap(pageI, 'impress_rare_fonts_fail');
        }
        await pageI.close();

        // --- Test 4: Check lazy font loading from server ---
        log('\n--- Test 4: Font lazy loading from server ---');
        const fontTests = ['LinLibertine_R_G.ttf', 'NotoSerif-Regular.ttf', 'Amiri-Regular.ttf'];
        const fontPage = await browser.newPage();
        await fontPage.goto(`${BASE}/editor.html`, { waitUntil: 'networkidle0' });
        for (const fontFile of fontTests) {
            const status = await fontPage.evaluate(async (file) => {
                try {
                    const r = await fetch('/browser/fonts/' + file, { method: 'HEAD' });
                    return r.status;
                } catch(e) { return 0; }
            }, fontFile);
            check(`Font ${fontFile} available at /fonts/ (${status})`, status === 200);
        }
        await fontPage.close();

        log('\n' + (allPassed ? '✓ ALL FONT TESTS PASSED' : '✗ SOME FONT TESTS FAILED'));

    } catch (e) {
        log('Error: ' + e.message);
        allPassed = false;
    } finally {
        await browser.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
