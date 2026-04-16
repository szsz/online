const __cl = require('./lib/inject-checklist');
// Regression test: when the user opens a different document, the document
// name shown in the editor title bar must update to the new filename.
//
// The bug: COOL reads the title from `app.map['wopi'].BaseFileName`, which
// is set from the cool.html WOPISrc query param at load time. A hot-switch
// sends `switchdocument url=…` to the Kit but never updates BaseFileName —
// the title stays as the prewarm blank or the first doc opened.
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-docname-switch';
const DOC_A = 'docname-A.docx';
const DOC_B = 'docname-B.docx';
const FIXTURE = path.join(__dirname, '..', 'test', 'data', 'new.docx');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`); }

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}${ev?' ['+ev+']':''}`); allPassed = false; }
}

async function getEditorFrame(page) {
    return page.frames().find(f => f.url().includes('cool.html'));
}

async function getDocTitle(page) {
    const fr = await getEditorFrame(page);
    if (!fr) return '';
    try {
        return await fr.evaluate(() => {
            // COOL exposes the title via wopi.BaseFileName and renders it
            // in #document-name-input. Read both for maximum coverage.
            const input = document.querySelector('#document-name-input');
            const wopi = window.app && window.app.map && window.app.map['wopi'];
            return {
                inputValue: input ? input.value : '',
                baseFileName: wopi ? wopi.BaseFileName : '',
            };
        });
    } catch (e) { return { inputValue: '', baseFileName: '', err: e.message }; }
}

(async () => {
    log('=== Regression: document name updates on switch ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    if (!fs.existsSync(FIXTURE)) { log('ERROR: fixture missing: ' + FIXTURE); process.exit(1); }

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-features=SharedArrayBuffer'],
    });

    try {
        // Upload two fixtures
        const up = await browser.newPage();
        await up.goto(VIEWER + '/');
        const bytes = fs.readFileSync(FIXTURE);
        for (const name of [DOC_A, DOC_B]) {
            await up.evaluate(async (n, a) => {
                await fetch('/api/files/' + encodeURIComponent(n), {
                    method: 'POST', body: new Blob([new Uint8Array(a)]),
                });
            }, name, Array.from(bytes));
        }
        await up.close();
        log(`Uploaded ${DOC_A} and ${DOC_B}`);

        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        await page.goto(VIEWER + '/#file=' + encodeURIComponent(DOC_A),
            { waitUntil: 'domcontentloaded' });

        // Wait for doc A to load
        for (let i = 0; i < 240; i++) {
            await sleep(500);
            const fr = await getEditorFrame(page);
            if (fr) {
                const wc = await fr.evaluate(() =>
                    document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
                if (/\d+\s+character/i.test(wc)) break;
            }
        }
        await sleep(3000);
        const titleA = await getDocTitle(page);
        log(`After opening ${DOC_A}: title="${titleA.baseFileName}" input="${titleA.inputValue}"`);
        await page.screenshot({ path: `${SHOT_DIR}/01_doc_A.png` });

        // In WASM mode (no real WOPI server), BaseFileName may be empty.
        // The user-visible title is #document-name-input — check that.
        check('Doc A: title bar shows "docname-A"',
              titleA.inputValue.includes('docname-A'),
              'inputValue=' + titleA.inputValue);

        // ── Switch to doc B via the sidebar ──────────────────────────
        log('\n--- Switching to doc B ---');
        await page.waitForFunction(n =>
            !!document.querySelector(`.file[data-name="${n}"]`),
            { timeout: 15000 }, DOC_B);
        await page.evaluate(n =>
            document.querySelector(`.file[data-name="${n}"]`).click(), DOC_B);

        // Wait for the editor to load the new doc (word count changes)
        await sleep(5000);
        for (let i = 0; i < 60; i++) {
            const fr = await getEditorFrame(page);
            if (fr) {
                const wc = await fr.evaluate(() =>
                    document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
                if (/\d+\s+character/i.test(wc)) break;
            }
            await sleep(500);
        }
        await sleep(3000);
        const titleB = await getDocTitle(page);
        log(`After switching to ${DOC_B}: title="${titleB.baseFileName}" input="${titleB.inputValue}"`);
        await page.screenshot({ path: `${SHOT_DIR}/02_doc_B.png` });

        check('Doc B: title bar updated to show "docname-B" (THE BUG)',
              titleB.inputValue.includes('docname-B'),
              'inputValue=' + titleB.inputValue +
              (titleB.inputValue.includes('docname-A') ? ' — still shows old doc name' :
               titleB.inputValue.includes('prewarm') ? ' — still shows prewarm blank' : ''));
        check('Doc B: #document-name-input updated',
              titleB.inputValue.includes('docname-B'),
              'inputValue=' + titleB.inputValue);

        // ── Case 2: Prewarm flow (user lands on / without deep link,
        // prewarm runs __prewarm_blank.docx, user clicks A, then B) ──
        log('\n--- Case 2: prewarm flow (no deep link) ---');
        const p2 = await browser.newPage();
        await p2.setViewport({ width: 1280, height: 900 });
        await p2.goto(VIEWER + '/', { waitUntil: 'domcontentloaded' });
        // Wait for prewarm to complete
        for (let i = 0; i < 240; i++) {
            await sleep(500);
            const fr = await getEditorFrame(p2);
            if (fr && await fr.evaluate(() => !!window.__wasmPrewarmReady).catch(() => false)) {
                log('Prewarm ready');
                break;
            }
        }
        // Before clicking anything: title should be the prewarm blank
        const titlePrewarm = await getDocTitle(p2);
        log('After prewarm: input="' + titlePrewarm.inputValue + '"');

        // Click doc A
        await p2.waitForFunction(n =>
            !!document.querySelector(`.file[data-name="${n}"]`),
            { timeout: 15000 }, DOC_A);
        await p2.evaluate(n =>
            document.querySelector(`.file[data-name="${n}"]`).click(), DOC_A);
        await sleep(5000);
        for (let i = 0; i < 30; i++) {
            const fr = await getEditorFrame(p2);
            if (fr) {
                const wc = await fr.evaluate(() =>
                    document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
                if (/\d+\s+character/i.test(wc)) break;
            }
            await sleep(500);
        }
        await sleep(2000);
        const titleA2 = await getDocTitle(p2);
        log('After clicking A: input="' + titleA2.inputValue + '"');
        check('Prewarm→A: title shows "docname-A" after first click',
              titleA2.inputValue.includes('docname-A'),
              'inputValue=' + titleA2.inputValue);

        // Click doc B
        // Expand sidebar first (it collapsed when we clicked A)
        await p2.evaluate(() => {
            document.body.classList.remove('docs-collapsed');
            document.body.classList.remove('docs-hover');
        });
        await sleep(500);
        await p2.evaluate(n =>
            document.querySelector(`.file[data-name="${n}"]`).click(), DOC_B);
        await sleep(5000);
        for (let i = 0; i < 30; i++) {
            const fr = await getEditorFrame(p2);
            if (fr) {
                const wc = await fr.evaluate(() =>
                    document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
                if (/\d+\s+character/i.test(wc)) break;
            }
            await sleep(500);
        }
        await sleep(2000);
        const titleB2 = await getDocTitle(p2);
        log('After clicking B: input="' + titleB2.inputValue + '"');
        check('A→B: title shows "docname-B" after switching',
              titleB2.inputValue.includes('docname-B'),
              'inputValue=' + titleB2.inputValue +
              (titleB2.inputValue.includes('docname-A') ? ' — still shows A' :
               titleB2.inputValue.includes('prewarm') ? ' — still shows prewarm' : ''));

        log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    } catch (e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        await browser.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
