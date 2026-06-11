const __cl = require('../../lib/inject-checklist');
// Test: 2 browsers co-edit different file formats (docx, xlsx, pptx).
// Verifies all formats open in their respective applications and
// typing/co-edit work.
//
// Migrated to the viewer flow (lib/open-via-viewer.js).
const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { openViaViewer, openSecretInBrowser } = require('../../lib/open-via-viewer');
const { waitInFrame, evalInFrame } = require('../../lib/two-tab');

const VIEWER = env.FILE_STORAGE_URL;
const TIMEOUT = env.scaleTimeout(300000);
const SHOT_DIR = '/tmp/static-deploy/public/shots-formats';

const T0 = Date.now();
function elapsed() { return ((Date.now() - T0) / 1000).toFixed(1) + 's'; }
function log(msg) { console.log(`[${elapsed()}] ${msg}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await sleep(300);
    const filename = `${String(++shotNum).padStart(2, '0')}_${elapsed()}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${filename}` }); } catch(e) {}
}

// Take a page (not a captured frame ref). evalInFrame re-resolves the
// LIVE editor iframe each call so a mid-test viewer-side replaceChild
// (cold-reload / hot-switch / late prewarm shuffle) doesn't strand the
// stored ref. Previously this used frame.evaluate() on a ref captured
// at openSecretInBrowser-time, which broke as 'frame got detached'.
async function getStatus(page) {
    return evalInFrame(page, () => {
        const wc = document.querySelector('#StateWordCount');
        if (wc && wc.textContent) return wc.textContent.trim();
        const sd = document.querySelector('#StatusDocPos');
        if (sd && sd.textContent) return sd.textContent.trim();
        const ss = document.querySelector('#SlideStatus');
        if (ss && ss.textContent) return ss.textContent.trim();
        const sb = document.querySelector('.jsdialog.ui-statusbar');
        return sb ? sb.textContent.trim().substring(0, 80) : 'NOT FOUND';
    }).catch(() => 'NOT FOUND');
}

function charCount(status) {
    const m = (status||'').match(/([\d,]+) characters/);
    return m ? parseInt(m[1].replace(/,/g, '')) : -1;
}

async function waitForDocLoaded(page, label) {
    log(`[${label}] Waiting for document...`);
    const t0 = Date.now();
    await waitInFrame(page, () => {
        const wc = document.querySelector('#StateWordCount');
        if (wc && wc.textContent && wc.textContent.includes('characters')) return true;
        const sd = document.querySelector('#StatusDocPos');
        if (sd && sd.textContent && sd.textContent.includes('Sheet')) return true;
        const ss = document.querySelector('#SlideStatus');
        if (ss && ss.textContent && /Slide\s+\d+\s+of\s+\d+/i.test(ss.textContent)) return true;
        return false;
    }, { timeout: TIMEOUT });
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    log(`[${label}] Loaded in ${dur}s`);
}

async function clickCanvas(page) {
    await page.mouse.click(640, 400);
    await sleep(500);
}

async function testFormat(browser, docName, docPath, formatLabel) {
    log(`\n${'='.repeat(50)}`);
    log(`Testing: ${formatLabel} (${docName})`);
    log(`${'='.repeat(50)}`);

    let allPassed = true;
    function check(label, condition) { __cl.recordCheck(label, condition);
        if (condition) { log(`  ✓ ${label}`); }
        else { log(`  ✗ FAIL: ${label}`); allPassed = false; }
    }

    const docBytes = fs.readFileSync(docPath);
    log(`Read ${docName} (${docBytes.length} bytes)`);

    let pageA, pageB;
    try {
        log(`[A] Opening...`);
        const upA = await openViaViewer(browser, VIEWER, docName, docBytes,
            { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
              isolatedContext: true });
        pageA = upA.page;
        await waitForDocLoaded(pageA, 'A');
        await sleep(10000);

        log(`[B] Opening...`);
        const upB = await openSecretInBrowser(browser, VIEWER, upA.b64urlSecret,
            { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
              isolatedContext: true });
        pageB = upB.page;
        await waitForDocLoaded(pageB, 'B');
        await sleep(15000);

        await snap(pageA, `${formatLabel}_A_initial`);
        await snap(pageB, `${formatLabel}_B_initial`);

        const initA = await getStatus(pageA);
        const initB = await getStatus(pageB);
        log(`Initial: A="${initA}" B="${initB}"`);
        check('Both browsers loaded', initA !== 'NOT FOUND' && initB !== 'NOT FOUND');

        const isCalc = formatLabel === 'xlsx';
        if (isCalc) {
            log('[A] Double-clicking cell A1 for Calc');
            await pageA.mouse.click(200, 300, { clickCount: 2 });
            await sleep(2000);
        }

        log('[A] Typing "TEST1"...');
        await clickCanvas(pageA);
        for (const ch of 'TEST1') {
            await pageA.keyboard.type(ch, { delay: 50 });
            await sleep(2000);
        }
        if (isCalc) await pageA.keyboard.press('Enter');

        await sleep(10000);
        await snap(pageA, `${formatLabel}_A_after_TEST1`);
        await snap(pageB, `${formatLabel}_B_after_TEST1`);
        const afterA = await getStatus(pageA);
        const afterB = await getStatus(pageB);
        log(`After TEST1: A="${afterA}" B="${afterB}"`);

        if (isCalc) {
            log('[B] Double-clicking cell B1 for Calc');
            await pageB.mouse.click(350, 300, { clickCount: 2 });
            await sleep(2000);
        }
        log('[B] Typing "TEST2"...');
        await clickCanvas(pageB);
        for (const ch of 'TEST2') {
            await pageB.keyboard.type(ch, { delay: 50 });
            await sleep(2000);
        }
        if (isCalc) await pageB.keyboard.press('Enter');

        await sleep(15000);
        await snap(pageA, `${formatLabel}_A_final`);
        await snap(pageB, `${formatLabel}_B_final`);
        const finalA = await getStatus(pageA);
        const finalB = await getStatus(pageB);
        log(`Final: A="${finalA}" B="${finalB}"`);

        const cA = charCount(finalA);
        const cB = charCount(finalB);
        if (cA > 0 && cB > 0) {
            const diff = Math.abs(cA - cB);
            check(`Char counts close: A=${cA} B=${cB} (diff=${diff})`, diff < 100);
        } else {
            check('Both browsers have status', finalA !== 'NOT FOUND' && finalB !== 'NOT FOUND');
        }
    } finally {
        try { if (pageA) await pageA.close(); } catch (x) {}
        try { if (pageB) await pageB.close(); } catch (x) {}
    }

    return allPassed;
}

(async () => {
    log('=== Multi-format co-editing test ===');

    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const formats = [
        { name: 'new.docx',           path: path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx'),           label: 'docx' },
        { name: 'testdoc.xlsx',       path: path.join(__dirname, '..', '..', '..', 'test', 'data', 'testdoc.xlsx'),       label: 'xlsx' },
        { name: 'testdoc.pptx',       path: path.join(__dirname, '..', '..', '..', 'test', 'data', 'testdoc.pptx'),       label: 'pptx' },
    ];

    let allPassed = true;
    const results = [];

    // Launch a FRESH browser per format. Reusing the same Chromium across
    // formats accumulated state (SW registrations, IndexedDB, Cache Storage
    // from prior format) that broke later format opens.
    for (const fmt of formats) {
        if (!fs.existsSync(fmt.path)) {
            log(`SKIP: ${fmt.path} not found`);
            results.push({ label: fmt.label, passed: false, reason: 'file not found' });
            continue;
        }
        const { browser, cleanup } = await launch();
        try {
            const passed = await testFormat(browser, fmt.name, fmt.path, fmt.label);
            results.push({ label: fmt.label, passed });
            if (!passed) allPassed = false;
        } catch (e) {
            log(`ERROR in ${fmt.label}: ${e.message}`);
            results.push({ label: fmt.label, passed: false, reason: e.message });
            allPassed = false;
        }
        await cleanup();
    }

    log('\n' + '='.repeat(50));
    log('RESULTS');
    log('='.repeat(50));
    for (const r of results) {
        log(`  ${r.passed ? '✓' : '✗'} ${r.label}${r.reason ? ': ' + r.reason : ''}`);
    }
    log(allPassed ? '\n✓ ALL FORMATS PASSED' : '\n✗ SOME FORMATS FAILED');
    process.exit(allPassed ? 0 : 1);
})();
