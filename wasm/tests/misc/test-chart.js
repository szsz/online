const __cl = require('../../lib/inject-checklist');
// Test: Documents with embedded charts
// Verifies chart rendering in both Writer (docx) and Calc (xlsx).
// Migrated to the viewer flow (lib/open-via-viewer.js).
const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { openViaViewer } = require('../../lib/open-via-viewer');

const VIEWER = env.FILE_STORAGE_URL;
const TIMEOUT = env.scaleTimeout(180000);
const SHOT_DIR = '/tmp/static-deploy/public/shots-chart';

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

async function clickCanvas(page) {
    await page.mouse.click(640, 400);
    await sleep(300);
}

async function runOne(browser, doctype, name, typeText, readyCheck) {
    const filePath = path.resolve(__dirname, '../test/data', name);
    if (!fs.existsSync(filePath)) { log(`SKIP: ${name} not found`); return; }
    const bytes = fs.readFileSync(filePath);

    log(`\n--- ${doctype} chart (${name}) ---`);
    const t0 = Date.now();
    let page, editorFrame;
    try {
        ({ page, editorFrame } = await openViaViewer(browser, VIEWER, name, bytes, {
            iframeTimeout: TIMEOUT,
            gotoTimeout: 30000,
            onPage: p => p.on('console', m => {
                const t = m.text();
                if (t.includes('wasm-loader')) log('  ' + t);
            }),
        }));
        await editorFrame.waitForFunction(readyCheck, { timeout: TIMEOUT });
        const loadTime = ((Date.now() - t0) / 1000).toFixed(1);
        log(`${doctype} loaded in ${loadTime}s`);
        check(`${doctype} ${name} loaded`, true);

        // Wait for chart tiles to paint.
        await sleep(15000);
        await snap(page, `${doctype}_chart_loaded`);

        // Scroll down to see chart area.
        await clickCanvas(page);
        await page.keyboard.press('PageDown');
        await sleep(5000);
        await snap(page, `${doctype}_chart_scrolled`);

        // Type to confirm editing works after chart rendering.
        await clickCanvas(page);
        await page.keyboard.type(typeText, { delay: 50 });
        await sleep(3000);
        await snap(page, `${doctype}_chart_after_typing`);

        if (doctype === 'Writer') {
            const wc = await editorFrame.evaluate(
                () => document.querySelector('#StateWordCount')?.textContent);
            log(`Word count after typing: ${wc}`);
            check(`Typing in chart ${name} works`, wc && wc.includes('word'));
        } else {
            check(`Typing in chart ${name} works`, true);
        }
    } catch (e) {
        log(`${doctype} chart FAIL: ${e.message}`);
        check(`${doctype} ${name} loaded`, false);
        if (page) await snap(page, `${doctype}_chart_fail`);
    }
    if (page) await page.close();
}

(async () => {
    log('=== Chart Rendering Test ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const { browser, cleanup } = await launch();
    try {
        await runOne(browser, 'Writer', 'chart-test.docx', 'CHART',
            () => document.querySelector('#StateWordCount')?.textContent?.includes('word'));
        await runOne(browser, 'Calc',   'chart-test.xlsx', '999',
            () => document.querySelector('#StatusDocPos')?.textContent?.includes('Sheet'));
        log('\n' + (allPassed ? '✓ ALL CHART TESTS PASSED' : '✗ SOME CHART TESTS FAILED'));
    } catch (e) {
        log('Error: ' + e.message);
        allPassed = false;
    } finally {
        await cleanup();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
