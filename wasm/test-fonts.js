// Test: Font rendering, browser font access, and lazy loading
// Verifies:
// 1. Documents with rare fonts open (substituted with available fonts)
// 2. Local Font Access API works (browser fonts accessible)
// 3. Fonts can be loaded from server /fonts/ endpoint
// 4. Fonts can be injected into Emscripten VFS at runtime
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
    log('=== Font Rendering & Lazy Loading Test ===');
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

        // --- Test 1: Writer with rare fonts (substitution) ---
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
            await sleep(10000);
            await snap(pageW, 'writer_rare_fonts_substituted');
        } catch (e) {
            check('Writer rare-font docx loaded', false);
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
            check('Calc rare-font xlsx loaded', false);
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
            check('Impress rare-font pptx loaded', false);
        }
        await pageI.close();

        // --- Test 4: Browser Local Font Access API ---
        log('\n--- Test 4: Browser Local Font Access ---');
        const pageF = await browser.newPage();

        // Grant local font permission via CDP
        const client = await pageF.createCDPSession();
        await client.send('Browser.grantPermissions', {
            origin: BASE,
            permissions: ['localFonts']
        });

        await pageF.goto(`${BASE}/editor.html`, { waitUntil: 'networkidle0' });

        const fontAccess = await pageF.evaluate(async () => {
            if (!('queryLocalFonts' in window)) return { api: false };
            try {
                const fonts = await window.queryLocalFonts();
                const families = [...new Set(fonts.map(f => f.family))].sort();

                // Get font blob data for one font
                let blobTest = null;
                const testFont = fonts.find(f => f.family === 'DejaVu Sans' || f.family === 'Liberation Sans');
                if (testFont) {
                    const blob = await testFont.blob();
                    blobTest = {
                        family: testFont.family,
                        fullName: testFont.fullName,
                        size: blob.size,
                    };
                }

                return {
                    api: true,
                    count: fonts.length,
                    familyCount: families.length,
                    families: families.slice(0, 20),
                    blobTest,
                };
            } catch (e) {
                return { api: true, error: e.message };
            }
        });

        check('Local Font Access API available', fontAccess.api);
        check('Browser fonts enumerated', fontAccess.count > 0);
        check('Font blob data accessible', fontAccess.blobTest && fontAccess.blobTest.size > 0);
        log(`  Browser has ${fontAccess.count} fonts in ${fontAccess.familyCount} families`);
        if (fontAccess.blobTest) {
            log(`  Blob test: ${fontAccess.blobTest.fullName} = ${fontAccess.blobTest.size} bytes`);
        }
        await pageF.close();

        // --- Test 5: Server font endpoint ---
        log('\n--- Test 5: Server font lazy loading ---');
        const pageS = await browser.newPage();
        await pageS.goto(`${BASE}/editor.html`, { waitUntil: 'networkidle0' });
        const serverFonts = ['LinLibertine_R_G.ttf', 'NotoSerif-Regular.ttf', 'Amiri-Regular.ttf'];
        for (const fontFile of serverFonts) {
            const status = await pageS.evaluate(async (file) => {
                try {
                    const r = await fetch('/browser/fonts/' + file, { method: 'HEAD' });
                    return r.status;
                } catch (e) { return 0; }
            }, fontFile);
            check(`Server font ${fontFile} (${status})`, status === 200);
        }
        await pageS.close();

        // --- Test 6: VFS font injection (full round-trip) ---
        log('\n--- Test 6: Font injection into WASM VFS ---');
        const pageV = await browser.newPage();

        // Grant local font permission
        const client2 = await pageV.createCDPSession();
        await client2.send('Browser.grantPermissions', {
            origin: BASE,
            permissions: ['localFonts']
        });

        pageV.on('console', m => {
            if (m.text().includes('font-loader')) log('  ' + m.text());
        });

        const t3 = Date.now();
        await pageV.goto(`${BASE}/browser/cool.html?WOPISrc=rare-fonts.docx&access_token=test`, {
            waitUntil: 'domcontentloaded', timeout: TIMEOUT
        });
        try {
            await pageV.waitForFunction(
                () => document.querySelector('#StateWordCount')?.textContent?.includes('word'),
                { timeout: 180000 }
            );
            log(`Document loaded in ${((Date.now() - t3) / 1000).toFixed(0)}s`);
            await sleep(5000);

            // Count fonts in VFS before loading
            const before = await pageV.evaluate(() => {
                if (typeof Module !== 'undefined' && Module.FS) {
                    return Module.FS.readdir('/instdir/share/fonts/truetype/').filter(f => f !== '.' && f !== '..').length;
                }
                return -1;
            });

            // Load fonts via font-loader (browser + server)
            const loadResult = await pageV.evaluate(async () => {
                const loader = window.__fontLoader;
                if (!loader) return { error: 'no loader' };

                await loader.init();
                const results = {};

                // Try loading from browser (DejaVu Sans is on the system)
                results.browserLoad = await loader.loadFont('DejaVu Sans');
                results.browserFonts = loader._browserFonts ? loader._browserFonts.size : 0;

                // Try loading from server (Noto Serif)
                results.serverLoad = await loader.loadFont('Noto Serif');

                results.totalLoaded = loader._loaded.size;
                return results;
            });

            // Count fonts after
            const after = await pageV.evaluate(() => {
                if (typeof Module !== 'undefined' && Module.FS) {
                    return Module.FS.readdir('/instdir/share/fonts/truetype/').filter(f => f !== '.' && f !== '..').length;
                }
                return -1;
            });

            check('Browser font loaded into VFS', loadResult.browserLoad);
            check('Server font loaded into VFS', loadResult.serverLoad);
            check('VFS font count increased', after > before);
            log(`  VFS fonts: ${before} → ${after} (+${after - before})`);
            log(`  Browser font families: ${loadResult.browserFonts}`);

            await sleep(5000);
            await snap(pageV, 'writer_after_font_injection');

        } catch (e) {
            log('VFS injection test failed: ' + e.message);
            check('Font injection into VFS', false);
        }
        await pageV.close();

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
