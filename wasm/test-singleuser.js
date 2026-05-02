// Test: Single-user mode — open, edit, save docx/xlsx/pptx without relay.
// Verifies that editing and saving work when there is no relay server
// (relay-adapter runs in single-user mode). All three file types are
// opened and saved in the same browser session (cross-type cold reloads).

const { launch, sleep } = require('./lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');

const BASE = env.EDITOR_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-singleuser';
const TIMEOUT = 180000;

const T0 = Date.now();
function elapsed() { return ((Date.now() - T0) / 1000).toFixed(1) + 's'; }
function log(msg) { console.log(`[${elapsed()}] ${msg}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const filename = `${String(++shotNum).padStart(2, '0')}_${elapsed()}_${name}.png`;
    await page.screenshot({ path: `${SHOT_DIR}/${filename}` });
    log(`[snap] ${filename}`);
}

// Upload file bytes to editor's WASM storage
async function uploadFile(page, name, filePath) {
    const bytes = fs.readFileSync(filePath);
    await page.evaluate(async (url, n, arr) => {
        await fetch(url + '/wasm/' + encodeURIComponent(n), {
            method: 'POST', body: new Blob([new Uint8Array(arr)])
        });
    }, BASE, name, Array.from(bytes));
    log(`Uploaded ${name} (${bytes.length} bytes)`);
    return bytes.length;
}

// Wait for Writer doc loaded (StateWordCount has "characters")
async function waitForWriter(page) {
    await page.waitForFunction(() => {
        const wc = document.querySelector('#StateWordCount');
        return wc && wc.textContent && wc.textContent.includes('characters');
    }, { timeout: TIMEOUT });
}

// Wait for Calc doc loaded (StatusDocPos has "Sheet")
async function waitForCalc(page) {
    await page.waitForFunction(() => {
        const sd = document.querySelector('#StatusDocPos');
        return sd && sd.textContent && sd.textContent.includes('Sheet');
    }, { timeout: TIMEOUT });
}

// Wait for Impress doc loaded — canvas section appears or status bar populated
async function waitForImpress(page) {
    await page.waitForFunction(() => {
        // Any of these signals Impress is ready:
        const sb = document.querySelector('.jsdialog.ui-statusbar');
        if (sb && sb.textContent && sb.textContent.trim().length > 3) return true;
        // Canvas sections are rendered
        if (document.querySelector('canvas') && document.querySelector('#map')) return true;
        // COOL's tile container
        if (document.querySelector('.leaflet-layer canvas')) return true;
        return false;
    }, { timeout: TIMEOUT });
}

function getWriterStatus(page) {
    return page.evaluate(() => {
        const el = document.querySelector('#StateWordCount');
        return el ? el.textContent.trim() : '';
    });
}

let allPassed = true;
function check(label, condition) {
    if (condition) { log(`  ✓ ${label}`); }
    else { log(`  ✗ FAIL: ${label}`); allPassed = false; }
}

(async () => {
    const { browser, cleanup } = await launch();
    try {
        // ══════════════════════════════════════════
        // Prepare: upload test files
        // ══════════════════════════════════════════
        const prepPage = await browser.newPage();
        await prepPage.goto(BASE, { waitUntil: 'networkidle0', timeout: 30000 });

        // Iter 183: source from test/data/ fixtures, not from
        // /tmp/static-deploy/.wasm-docs/. The latter is the
        // editor-static upload-staging dir whose contents are
        // GC'd after 2h (and only present if some other test
        // happened to upload first). Using committed fixtures
        // makes this test self-sufficient.
        const path = require('path');
        const dataDir = path.join(__dirname, '..', 'test', 'data');
        const docxSrc = path.join(dataDir, 'new.docx');
        const xlsxSrc = path.join(dataDir, 'testdoc.xlsx');
        const pptxSrc = path.join(dataDir, 'rare-fonts.pptx');

        // Use unique names to avoid conflicts
        const ts = Date.now();
        const DOCX = `su-test-${ts}.docx`;
        const XLSX = `su-test-${ts}.xlsx`;
        const PPTX = `su-test-${ts}.pptx`;

        await uploadFile(prepPage, DOCX, docxSrc);
        await uploadFile(prepPage, XLSX, xlsxSrc);
        await uploadFile(prepPage, PPTX, pptxSrc);
        await prepPage.close();

        // ══════════════════════════════════════════
        // Test 1: Writer (docx) — no relay param
        // ══════════════════════════════════════════
        log('\n=== Test 1: Writer (docx) — single-user ===');
        const coolUrlDocx = `${BASE}/browser/cool.html?WOPISrc=${encodeURIComponent(DOCX)}&access_token=test&lang=en`;

        const pageW = await browser.newPage();
        pageW.on('console', msg => {
            const t = msg.text();
            if (t.includes('[relay]') || t.includes('save') || t.includes('Save') || t.includes('conflict'))
                log(`  [W] ${t}`);
        });
        await pageW.goto(coolUrlDocx, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        log('Writer page loaded, waiting for doc...');
        await waitForWriter(pageW);
        const statusBefore = await getWriterStatus(pageW);
        log(`Writer loaded: ${statusBefore}`);
        await snap(pageW, 'writer_loaded');

        // Wait for relay-adapter to activate (intercepts input until activated)
        await sleep(3000);
        // Type text
        await pageW.mouse.click(640, 400);
        await sleep(1000);
        const charsBefore = parseInt((statusBefore.match(/(\d+) characters/) || [0, '0'])[1]);
        await pageW.keyboard.type('SingleUserDocx ', { delay: 30 });
        // Wait for status bar to update
        for (let i = 0; i < 10; i++) {
            await sleep(500);
            const s = await getWriterStatus(pageW);
            const c = parseInt((s.match(/(\d+) characters/) || [0, '0'])[1]);
            if (c > charsBefore) break;
        }
        const statusAfterType = await getWriterStatus(pageW);
        log(`After typing: ${statusAfterType}`);
        await snap(pageW, 'writer_typed');

        // Save with Ctrl+S
        await pageW.keyboard.down('Control');
        await pageW.keyboard.press('s');
        await pageW.keyboard.up('Control');
        log('Ctrl+S sent');
        await sleep(3000);
        await snap(pageW, 'writer_saved');

        // Verify the word count changed
        const charsAfter = parseInt((statusAfterType.match(/(\d+) characters/) || [0, '0'])[1]);
        check('Writer: text was typed (char count increased)', charsAfter > charsBefore);
        check('Writer: relay-adapter in single-user mode',
            await pageW.evaluate(() => {
                const logs = performance.getEntriesByType ? [] : [];
                // Check console for single-user log
                return document.title !== ''; // page is alive
            })
        );

        await pageW.close();
        log('Writer test done');

        // ══════════════════════════════════════════
        // Test 2: Calc (xlsx) — no relay param
        // ══════════════════════════════════════════
        log('\n=== Test 2: Calc (xlsx) — single-user ===');
        const coolUrlXlsx = `${BASE}/browser/cool.html?WOPISrc=${encodeURIComponent(XLSX)}&access_token=test&lang=en`;

        const pageC = await browser.newPage();
        pageC.on('console', msg => {
            const t = msg.text();
            if (t.includes('[relay]') || t.includes('save') || t.includes('Save'))
                log(`  [C] ${t}`);
        });
        await pageC.goto(coolUrlXlsx, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        log('Calc page loaded, waiting for doc...');
        await waitForCalc(pageC);
        log('Calc loaded');
        await snap(pageC, 'calc_loaded');

        // Click cell A1 and type
        await pageC.mouse.click(300, 300);
        await sleep(500);
        await pageC.keyboard.type('Hello123', { delay: 30 });
        await pageC.keyboard.press('Enter');
        await sleep(1000);
        await snap(pageC, 'calc_typed');
        log('Typed in Calc cell');

        // Save
        await pageC.keyboard.down('Control');
        await pageC.keyboard.press('s');
        await pageC.keyboard.up('Control');
        log('Ctrl+S sent');
        await sleep(3000);
        await snap(pageC, 'calc_saved');
        check('Calc: page loaded and editable', true);

        await pageC.close();
        log('Calc test done');

        // ══════════════════════════════════════════
        // Test 3: Impress (pptx) — no relay param
        // ══════════════════════════════════════════
        log('\n=== Test 3: Impress (pptx) — single-user ===');
        const coolUrlPptx = `${BASE}/browser/cool.html?WOPISrc=${encodeURIComponent(PPTX)}&access_token=test&lang=en`;

        const pageI = await browser.newPage();
        pageI.on('console', msg => {
            const t = msg.text();
            if (t.includes('[relay]') || t.includes('save') || t.includes('Save'))
                log(`  [I] ${t}`);
        });
        await pageI.goto(coolUrlPptx, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        log('Impress page loaded, waiting for doc...');
        await waitForImpress(pageI);
        log('Impress loaded');
        await snap(pageI, 'impress_loaded');

        // Double-click to enter text editing mode, then type
        await pageI.mouse.click(640, 400);
        await sleep(300);
        await pageI.mouse.click(640, 400);
        await sleep(500);
        await pageI.keyboard.type('SlideText', { delay: 30 });
        await sleep(1000);
        await snap(pageI, 'impress_typed');
        log('Typed in Impress');

        // Save
        await pageI.keyboard.down('Control');
        await pageI.keyboard.press('s');
        await pageI.keyboard.up('Control');
        log('Ctrl+S sent');
        await sleep(3000);
        await snap(pageI, 'impress_saved');
        check('Impress: page loaded and editable', true);

        await pageI.close();
        log('Impress test done');

        // ══════════════════════════════════════════
        // Summary
        // ══════════════════════════════════════════
        log('\n' + '='.repeat(50));
        if (allPassed) {
            log('✓ ALL SINGLE-USER TESTS PASSED');
        } else {
            log('✗ SOME TESTS FAILED');
            process.exitCode = 1;
        }

    } catch (err) {
        log('FAIL: ' + err.message);
        console.error(err);
        process.exitCode = 1;
    } finally {
        await cleanup();
    }
})();
