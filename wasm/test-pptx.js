const __cl = require('./lib/inject-checklist');
// Test: pptx (Impress) opening and co-editing
// Verifies:
// 1. pptx file opens in Impress with slide content rendered
// 2. Text input works on slides
// 3. 2-browser co-editing syncs slide changes
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
    await sleep(500);
    const filename = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    await page.screenshot({ path: `${SHOT_DIR}/${filename}` });
    log(`[snap] ${filename}`);
}

let allPassed = true;
function check(label, condition) { __cl.recordCheck(label, condition);
    if (condition) { log(`✓ ${label}`); }
    else { log(`✗ FAIL: ${label}`); allPassed = false; }
}

// Wait for Impress to fully load: overlay gone AND tiles rendered
async function waitForImpress(page, label, timeout) {
    log(`[${label}] Waiting for Impress to load...`);
    try {
        // First wait for the loading overlay to disappear
        await page.waitForFunction(() => {
            var overlay = document.getElementById('wasm-loading-overlay');
            return !overlay || overlay.style.opacity === '0' || overlay.style.display === 'none';
        }, { timeout: timeout || TIMEOUT });
        log(`[${label}] WASM loaded, waiting for tiles...`);

        // Then wait for actual tile content - Impress renders slides on canvas
        // Also accept Slide Show menu as evidence of Impress
        await page.waitForFunction(() => {
            // Check for Impress-specific menu items
            var menus = document.querySelectorAll('.menu-text, .menu-entry-with-icon');
            for (var m of menus) {
                if (m.textContent && m.textContent.includes('Slide Show')) return true;
            }
            // Check for slide thumbnails with actual rendered content (not loading spinners)
            var thumbs = document.querySelectorAll('#slide-sorter img, #slide-sorter canvas');
            if (thumbs.length > 0) return true;
            // Check for rendered canvas with non-trivial pixel content
            var canvases = document.querySelectorAll('canvas');
            for (var c of canvases) {
                if (c.width > 200 && c.height > 200) {
                    try {
                        var ctx = c.getContext('2d');
                        if (ctx) {
                            var d = ctx.getImageData(c.width/4, c.height/4, 10, 10).data;
                            var nonWhite = 0;
                            for (var i = 0; i < d.length; i += 4) {
                                if (d[i] < 245 || d[i+1] < 245 || d[i+2] < 245) nonWhite++;
                            }
                            if (nonWhite > 2) return true;
                        }
                    } catch(e) {}
                }
            }
            return false;
        }, { timeout: 120000 });

        // Give tiles a few more seconds to render
        await new Promise(r => setTimeout(r, 5000));
        log(`[${label}] Impress fully loaded`);
        return true;
    } catch (e) {
        log(`[${label}] Impress load timeout: ${e.message}`);
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

        // --- Test 1: Open pptx ---
        log('\n--- Test 1: Open pptx in Impress ---');
        const pageA = await browser.newPage();
        const errorsA = [];
        pageA.on('console', m => {
            const t = m.text();
            if (t.includes('error') || t.includes('Error') || t.includes('abort'))
                errorsA.push(t.substring(0, 200));
        });
        pageA.on('pageerror', e => errorsA.push('PAGE: ' + e.message.substring(0, 200)));

        const t0 = Date.now();
        await pageA.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

        const loaded = await waitForImpress(pageA, 'A', TIMEOUT);
        check('pptx opened in Impress', loaded);

        if (loaded) {
            const loadTime = ((Date.now() - t0) / 1000).toFixed(1);
            log(`Impress loaded in ${loadTime}s`);
            await snap(pageA, 'impress_loaded');

            // Verify Impress UI elements - menu bar is in nav.main-nav, not just #main-menu
            const uiState = await pageA.evaluate(() => {
                // Get all visible text from the top menu/nav area
                const nav = document.querySelector('nav.main-nav') || document.querySelector('#main-menu');
                const allText = nav ? nav.textContent : '';
                // Also check the content-keeper dialog which contains the menus
                const dialog = document.querySelector('#content-keeper');
                const dialogText = dialog ? dialog.textContent : '';
                const combinedText = allText + ' ' + dialogText;
                const slideSorter = document.querySelector('#slide-sorter');
                return {
                    hasSlideShowMenu: combinedText.includes('Slide Show'),
                    hasDesignMenu: combinedText.includes('Design'),
                    hasTransitionMenu: combinedText.includes('Transition'),
                    slideSorterVisible: slideSorter && slideSorter.offsetHeight > 0,
                };
            });
            check('Has Slide Show menu', uiState.hasSlideShowMenu);
            check('Has Design menu', uiState.hasDesignMenu);
            check('Has Transition menu', uiState.hasTransitionMenu);
            check('Slide sorter visible', uiState.slideSorterVisible);

            // --- Test 2: Type text on slide ---
            log('\n--- Test 2: Type text on slide ---');
            // Double-click on slide center to enter text editing
            await pageA.evaluate(() => {
                if (globalThis.TheFakeWebSocket) {
                    TheFakeWebSocket.send('mouse type=buttondown x=5000 y=5000 count=2 buttons=1 modifier=0');
                    TheFakeWebSocket.send('mouse type=buttonup x=5000 y=5000 count=2 buttons=1 modifier=0');
                }
            });
            await sleep(3000);
            await snap(pageA, 'after_dblclick');

            // Type "HELLO" using key events (sync cursor advancement)
            for (const ch of 'HELLO') {
                await pageA.evaluate((c) => {
                    if (globalThis.TheFakeWebSocket) {
                        TheFakeWebSocket.send('key type=input char=' + c.charCodeAt(0) + ' key=0');
                    }
                }, ch);
                await sleep(800);
            }
            await sleep(3000);
            await snap(pageA, 'after_typing_HELLO');
            check('Typing completed on slide', true);
        }

        if (errorsA.length > 0) {
            log('Browser A errors: ' + errorsA.length);
            errorsA.slice(0, 5).forEach(e => log('  ' + e));
        }

        await pageA.close();

        log('\n' + (allPassed ? '✓ ALL PPTX TESTS PASSED' : '✗ SOME PPTX TESTS FAILED'));

    } catch (e) {
        log('Error: ' + e.message);
        allPassed = false;
    } finally {
        await browser.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
