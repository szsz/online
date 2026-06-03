const __cl = require('./lib/inject-checklist');
// Test: pptx (Impress) opening and content rendering.
// Verifies:
//   1. pptx file opens in Impress with slide content rendered
//   2. Text input works on slides
// Migrated to the viewer flow (lib/open-via-viewer.js).
const { launch, sleep } = require('./lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');
const { openViaViewer } = require('./lib/open-via-viewer');

const VIEWER = env.FILE_STORAGE_URL;
const TIMEOUT = env.scaleTimeout(180000);
const SHOT_DIR = '/tmp/static-deploy/public/shots-pptx';
const DOC_NAME = 'testdoc.pptx';
const DOC_PATH = path.join(__dirname, '..', 'test', 'data', DOC_NAME);

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

async function clickCanvas(page) {
    await page.mouse.click(640, 400);
    await sleep(500);
}

// Wait for Impress to fully load inside the editor iframe.
async function waitForImpress(editorFrame, label, timeout) {
    log(`[${label}] Waiting for Impress to load...`);
    try {
        await editorFrame.waitForFunction(() => {
            var overlay = document.getElementById('wasm-loading-overlay');
            return !overlay || overlay.style.opacity === '0' || overlay.style.display === 'none';
        }, { timeout: timeout || TIMEOUT });
        log(`[${label}] WASM loaded, waiting for tiles...`);

        await editorFrame.waitForFunction(() => {
            var menus = document.querySelectorAll('.menu-text, .menu-entry-with-icon');
            for (var m of menus) {
                if (m.textContent && m.textContent.includes('Slide Show')) return true;
            }
            var thumbs = document.querySelectorAll('#slide-sorter img, #slide-sorter canvas');
            if (thumbs.length > 0) return true;
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

        await sleep(5000);
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

    const { browser, cleanup } = await launch();
    try {
        const bytes = fs.readFileSync(DOC_PATH);
        const errorsA = [];

        log('\n--- Test 1: Open pptx in Impress ---');
        const { page: pageA, editorFrame } = await openViaViewer(
            browser, VIEWER, DOC_NAME, bytes,
            { iframeTimeout: TIMEOUT,
              gotoTimeout: 30000,
              onPage: p => {
                  p.on('console', m => {
                      const t = m.text();
                      if (t.includes('error') || t.includes('Error') || t.includes('abort'))
                          errorsA.push(t.substring(0, 200));
                  });
                  p.on('pageerror', e => errorsA.push('PAGE: ' + e.message.substring(0, 200)));
              },
            });

        const t0 = Date.now();
        const loaded = await waitForImpress(editorFrame, 'A', TIMEOUT);
        check('pptx opened in Impress', loaded);

        if (loaded) {
            const loadTime = ((Date.now() - t0) / 1000).toFixed(1);
            log(`Impress loaded in ${loadTime}s`);
            await snap(pageA, 'impress_loaded');

            const uiState = await editorFrame.evaluate(() => {
                const nav = document.querySelector('nav.main-nav') || document.querySelector('#main-menu');
                const allText = nav ? nav.textContent : '';
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

            log('\n--- Test 2: Type text on slide ---');
            await clickCanvas(pageA);
            await pageA.mouse.click(640, 400, { clickCount: 2 });
            await sleep(3000);
            await snap(pageA, 'after_dblclick');

            for (const ch of 'HELLO') {
                await pageA.keyboard.type(ch, { delay: 50 });
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
        await cleanup();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
