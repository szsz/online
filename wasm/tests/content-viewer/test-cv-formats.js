// test-cv-formats.js — two browsers co-edit each document format (docx, xlsx,
// pptx) through the content viewer; every format opens in its application and
// typing/co-edit works in both browsers.
//
// Legacy subject (viewer): for each of new.docx / testdoc.xlsx / testdoc.pptx,
// open in two browsers on one room, confirm both loaded a status bar, type
// "TEST1" in A and "TEST2" in B, and assert both browsers still show a status
// (and, when a character count is available, that the two counts stay close).
//
// CV port: one openCoEditPair(...) per fixture (A creates the room, B joins
// the link in an isolated context), fresh browser per format so no SW /
// IndexedDB / cache state leaks between formats (a legacy requirement). A
// types, then B types; both must still report a live status and — for the
// Writer case where #StateWordCount is meaningful — converge/stay close.
// Visible-UI only; status read from #StateWordCount / #StatusDocPos /
// #SlideStatus.
//
// Migrated from wasm/tests/misc/test-formats.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-formats.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const {
    openCoEditPair, waitCvInteractive, cvEditorFrame,
} = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DATA = path.join(__dirname, '..', '..', '..', 'test', 'data');
const SHOT_DIR = '/tmp/content-viewer-report/formats';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch (e) {}
}

// Read whatever status the doctype exposes (Writer/Calc/Impress).
async function getStatus(page) {
    const fr = cvEditorFrame(page);
    if (!fr) return 'NOT FOUND';
    return fr.evaluate(() => {
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
    const m = (status || '').match(/([\d,.]+) characters/i);
    return m ? parseInt(m[1].replace(/[,.]/g, ''), 10) : -1;
}
async function clickCanvas(page) {
    const box = await (await page.$('iframe')).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
    await sleep(500);
}

async function testFormat(docName, docPath, formatLabel) {
    log(`\n${'='.repeat(50)}`);
    log(`Testing: ${formatLabel} (${docName})`);
    log(`${'='.repeat(50)}`);

    let passed = true;
    function check(label, cond, ev) {
        if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
        else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); passed = false; }
    }

    const bytes = fs.readFileSync(docPath);
    // Fresh browser per format: reusing Chromium across formats accumulated
    // SW registrations / IndexedDB / Cache Storage that broke later opens.
    const { browser } = await launch({ headless: 'new' });
    try {
        const pair = await openCoEditPair(browser, BASE, docName, bytes, {
            userA: formatLabel + ' Alice', userB: formatLabel + ' Bob',
            loadBudgetMs: LOAD_BUDGET,
        });
        const A = pair.A.page, B = pair.B.page;
        await sleep(10000);

        const initA = await getStatus(A);
        const initB = await getStatus(B);
        log(`Initial: A="${initA}" B="${initB}"`);
        check('Both browsers loaded', initA !== 'NOT FOUND' && initB !== 'NOT FOUND');
        await snap(A, `${formatLabel}_A_initial`); await snap(B, `${formatLabel}_B_initial`);

        const isCalc = formatLabel === 'xlsx';

        // A types "TEST1".
        if (isCalc) { await A.mouse.click(200, 300, { clickCount: 2 }); await sleep(2000); }
        else await clickCanvas(A);
        log('[A] Typing "TEST1"...');
        for (const ch of 'TEST1') { await A.keyboard.type(ch, { delay: 50 }); await sleep(1500); }
        if (isCalc) await A.keyboard.press('Enter');
        await sleep(10000);
        await snap(A, `${formatLabel}_A_after_TEST1`); await snap(B, `${formatLabel}_B_after_TEST1`);

        // B types "TEST2".
        if (isCalc) { await B.mouse.click(350, 300, { clickCount: 2 }); await sleep(2000); }
        else await clickCanvas(B);
        log('[B] Typing "TEST2"...');
        for (const ch of 'TEST2') { await B.keyboard.type(ch, { delay: 50 }); await sleep(1500); }
        if (isCalc) await B.keyboard.press('Enter');
        await sleep(15000);

        const finalA = await getStatus(A);
        const finalB = await getStatus(B);
        log(`Final: A="${finalA}" B="${finalB}"`);
        await snap(A, `${formatLabel}_A_final`); await snap(B, `${formatLabel}_B_final`);

        const cA = charCount(finalA);
        const cB = charCount(finalB);
        if (cA > 0 && cB > 0) {
            const diff = Math.abs(cA - cB);
            check(`Char counts close: A=${cA} B=${cB} (diff=${diff})`, diff < 100);
        } else {
            check('Both browsers have status', finalA !== 'NOT FOUND' && finalB !== 'NOT FOUND');
        }
    } catch (e) {
        check(`${formatLabel}: harness ran without exception`, false, (e && e.stack || String(e)).slice(0, 200));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    return passed;
}

(async () => {
    log('=== CV multi-format co-editing test ===');
    log('viewer: ' + BASE);
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });

    const formats = [
        { name: 'new.docx', file: 'new.docx', label: 'docx' },
        { name: 'testdoc.xlsx', file: 'testdoc.xlsx', label: 'xlsx' },
        { name: 'testdoc.pptx', file: 'testdoc.pptx', label: 'pptx' },
    ];

    let allPassed = true;
    const results = [];
    for (const fmt of formats) {
        const p = path.join(DATA, fmt.file);
        if (!fs.existsSync(p)) {
            log(`SKIP: ${p} not found`);
            results.push({ label: fmt.label, passed: false, reason: 'file not found' });
            allPassed = false;
            continue;
        }
        const uniqueName = fmt.name.replace(/(\.[^.]+)$/, '-' + Date.now() + '$1');
        const passed = await testFormat(uniqueName, p, fmt.label);
        results.push({ label: fmt.label, passed });
        if (!passed) allPassed = false;
    }

    log('\n' + '='.repeat(50));
    log('RESULTS');
    log('='.repeat(50));
    for (const r of results) log(`  ${r.passed ? '✓' : '✗'} ${r.label}${r.reason ? ': ' + r.reason : ''}`);
    log(allPassed ? '\nALL PASS' : '\nSOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
