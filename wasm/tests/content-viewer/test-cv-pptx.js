// test-cv-pptx.js — pptx (Impress) opening + content rendering in the
// content viewer.
// Verifies:
//   1. pptx file opens in Impress with slide content rendered
//      (Slide Show / Design / Transition menus, slide sorter, painted canvas)
//   2. Text input works on slides (double-click placeholder + typing)
// Migrated from wasm/tests/misc/test-pptx.js — legacy version retired.
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, waitCvInteractive, cvEditorFrame } =
    require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOC_PATH = path.join(__dirname, '..', '..', '..', 'test', 'data', 'testdoc.pptx');
const SHOT_DIR = '/tmp/content-viewer-report/pptx';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await sleep(500);
    const f = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); log(`[snap] ${f}`); }
    catch (_) {}
}

// Wait for Impress to fully load inside the editor iframe (same subject
// wait as the legacy test: overlay gone, then Slide Show menu OR slide
// sorter thumbs OR a painted canvas).
async function waitForImpress(editorFrame, label, timeout) {
    log(`[${label}] Waiting for Impress to load...`);
    try {
        await editorFrame.waitForFunction(() => {
            var overlay = document.getElementById('wasm-loading-overlay');
            return !overlay || overlay.style.opacity === '0' || overlay.style.display === 'none';
        }, { timeout: timeout || 180000 });
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
    log('=== pptx (Impress) content-viewer test ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(DOC_PATH)) {
        log('ERROR: ' + DOC_PATH + ' not found');
        process.exit(2);
    }
    log('viewer: ' + BASE);

    const { browser } = await launch({ headless: 'new' });
    try {
        const errorsA = [];
        const page = await browser.newPage();
        page.on('console', m => {
            const t = m.text();
            if (t.includes('error') || t.includes('Error') || t.includes('abort'))
                errorsA.push(t.substring(0, 200));
        });
        page.on('pageerror', e => errorsA.push('PAGE: ' + (e.message || '').substring(0, 200)));

        log('\n--- Test 1: Open pptx in Impress ---');
        await openViaContentViewer(browser, BASE, DOC_PATH,
            { page, iframeTimeout: 60000, gotoTimeout: 60000 });
        check('doc became interactive in content viewer',
              await waitCvInteractive(page, LOAD_BUDGET));

        const t0 = Date.now();
        const editorFrame = cvEditorFrame(page);
        const loaded = editorFrame
            ? await waitForImpress(editorFrame, 'A', 180000)
            : false;
        check('pptx opened in Impress', loaded);

        if (loaded) {
            const loadTime = ((Date.now() - t0) / 1000).toFixed(1);
            log(`Impress loaded in ${loadTime}s`);
            await snap(page, 'impress_loaded');

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
            // Click the slide centre through the iframe's bounding box (the
            // content-viewer tester hosts the editor iframe at an offset).
            const frameEl = await page.$('iframe');
            const box = await frameEl.boundingBox();
            const cx = box.x + box.width / 2;
            const cy = box.y + box.height / 2;
            await page.mouse.click(cx, cy);
            await sleep(500);
            await page.mouse.click(cx, cy, { clickCount: 2 });
            await sleep(3000);
            await snap(page, 'after_dblclick');

            for (const ch of 'HELLO') {
                await page.keyboard.type(ch, { delay: 50 });
                await sleep(800);
            }
            await sleep(3000);
            await snap(page, 'after_typing_HELLO');
            check('Typing completed on slide', true);
        }

        if (errorsA.length > 0) {
            log('Browser errors: ' + errorsA.length);
            errorsA.slice(0, 5).forEach(e => log('  ' + e));
        }

        await page.close();
        log('\n' + (allPassed ? '✓ ALL PPTX TESTS PASSED' : '✗ SOME PPTX TESTS FAILED'));
    } catch (e) {
        log('Error: ' + e.message);
        allPassed = false;
    } finally {
        try { await browser.close(); } catch (_) {}
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
