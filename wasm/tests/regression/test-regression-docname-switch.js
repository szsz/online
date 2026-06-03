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
const { uploadV2 } = require('./lib/v2-upload');
const { seedRecentFiles, waitForSidebar, clickSidebarFile } = require('./lib/v2-test-helper');

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

async function getEditorFrame(page, requireFileId) {
    // When requireFileId is set, only match the iframe whose URL references
    // that fileId — otherwise we latch onto the prewarm blank's frame and
    // read its (empty/wrong) title-bar value. In v2 the WOPISrc is the
    // opaque fileId (not the plaintext name).
    return page.frames().find(f =>
        f.url().includes('cool.html')
        && (!requireFileId || f.url().includes(requireFileId)));
}

async function getDocTitle(page, requireFileId) {
    const fr = await getEditorFrame(page, requireFileId);
    if (!fr) return { inputValue: '', baseFileName: '' };
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
        // Upload two fixtures via v2 (encrypted).
        const bytes = fs.readFileSync(FIXTURE);
        const upA = await uploadV2(VIEWER, DOC_A, bytes);
        const upB = await uploadV2(VIEWER, DOC_B, bytes);
        log(`Uploaded ${DOC_A} → ${upA.fileId.substring(0,8)}… and ${DOC_B} → ${upB.fileId.substring(0,8)}…`);

        const recentList = [
            { b64urlSecret: upA.b64urlSecret, fileId: upA.fileId, cachedName: DOC_A },
            { b64urlSecret: upB.b64urlSecret, fileId: upB.fileId, cachedName: DOC_B },
        ];

        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        await seedRecentFiles(page, recentList);
        await page.goto(VIEWER + '/#file=' + upA.b64urlSecret,
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
        await waitForSidebar(page, upB.fileId, 15000);
        await clickSidebarFile(page, upB.fileId);

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
        await seedRecentFiles(p2, recentList);
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
        await waitForSidebar(p2, upA.fileId, 15000);
        await clickSidebarFile(p2, upA.fileId);
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
        // Wait for the title bar to pick up the new doc name — can
        // lag the doc-loaded signal by several seconds on Azure.
        let titleA2 = await getDocTitle(p2, upA.fileId);
        const titleADeadline = Date.now() + 60000;
        while (!titleA2.inputValue.includes('docname-A') && Date.now() < titleADeadline) {
            await sleep(500);
            titleA2 = await getDocTitle(p2, upA.fileId);
        }
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
        await clickSidebarFile(p2, upB.fileId);
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
        let titleB2 = await getDocTitle(p2, upB.fileId);
        const titleBDeadline = Date.now() + 60000;
        while (!titleB2.inputValue.includes('docname-B') && Date.now() < titleBDeadline) {
            await sleep(500);
            titleB2 = await getDocTitle(p2, upB.fileId);
        }
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
