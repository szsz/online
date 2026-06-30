// Test: Single-user mode — open, edit, save docx/xlsx/pptx without relay.
// Drives the viewer at `?singleuser` so the iframe URL has no `&relay=`.
// All three file types are opened in fresh tabs (no hot-switch).
//
// Migrated to the viewer flow (lib/open-via-viewer.js) — previously the
// test POSTed plaintext to <EDITOR>/wasm/<name> and opened cool.html
// directly. That worked when the editor App Service hosted /wasm/; with
// the FD-static editor + SW-bridge architecture the only way Kit can
// reach the document bytes is through the viewer.

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { openViaViewer } = require('../../lib/open-via-viewer');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-singleuser';
const TIMEOUT = env.scaleTimeout(180000);

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

// Wait for doc-type-specific readiness via the editor iframe DOM.
function waitForWriter(frame) {
    return frame.waitForFunction(() => {
        const wc = document.querySelector('#StateWordCount');
        return wc && wc.textContent && wc.textContent.includes('characters');
    }, { timeout: TIMEOUT });
}
function waitForCalc(frame) {
    return frame.waitForFunction(() => {
        const sd = document.querySelector('#StatusDocPos');
        return sd && sd.textContent && sd.textContent.includes('Sheet');
    }, { timeout: TIMEOUT });
}
function waitForImpress(frame) {
    return frame.waitForFunction(() => {
        const sb = document.querySelector('.jsdialog.ui-statusbar');
        if (sb && sb.textContent && sb.textContent.trim().length > 3) return true;
        if (document.querySelector('canvas') && document.querySelector('#map')) return true;
        if (document.querySelector('.leaflet-layer canvas')) return true;
        return false;
    }, { timeout: TIMEOUT });
}

function getWriterStatus(frame) {
    return frame.evaluate(() => {
        const el = document.querySelector('#StateWordCount');
        return el ? el.textContent.trim() : '';
    });
}

let allPassed = true;
function check(label, condition) {
    if (condition) { log(`  ✓ ${label}`); }
    else { log(`  ✗ FAIL: ${label}`); allPassed = false; }
}

// One open-edit-save cycle.
//   doctype: 'writer' | 'calc' | 'impress'
async function runOne(browser, doctype, fixturePath, typeText) {
    const fixtureName = path.basename(fixturePath);
    log(`\n=== ${doctype} (${fixtureName}) — single-user ===`);
    const bytes = fs.readFileSync(fixturePath);

    const { page, editorFrame } = await openViaViewer(browser, VIEWER,
        fixtureName, bytes,
        { singleUser: true,
          gotoTimeout: 30000,
          iframeTimeout: TIMEOUT,
          onPage: p => p.on('console', msg => {
              const t = msg.text();
              if (t.includes('[relay]') || /save/i.test(t) || t.includes('conflict'))
                  log(`  [${doctype}] ${t}`);
          }),
        });

    log(`${doctype} iframe attached, waiting for doc ready...`);
    if (doctype === 'writer')   await waitForWriter(editorFrame);
    if (doctype === 'calc')     await waitForCalc(editorFrame);
    if (doctype === 'impress')  await waitForImpress(editorFrame);
    log(`${doctype} doc ready`);
    await snap(page, `${doctype}_loaded`);

    // Relay-adapter activation gates input even in single-user mode.
    await sleep(3000);

    let statusBefore = '';
    let charsBefore = 0;
    if (doctype === 'writer') {
        statusBefore = await getWriterStatus(editorFrame);
        charsBefore = parseInt((statusBefore.match(/(\d+) characters/) || [0, '0'])[1]);
    }

    // Type. Mouse + keyboard go to `page` (the viewer iframes the editor
    // fullscreen once the loading shield drops, so page coords work).
    // Impress needs a double-click to enter text-editing mode.
    if (doctype === 'impress') {
        await page.mouse.click(640, 400);
        await sleep(300);
    }
    await page.mouse.click(640, 400);
    await sleep(800);
    await page.keyboard.type(typeText, { delay: 30 });

    if (doctype === 'writer') {
        // Watch the status bar update from the iframe side.
        for (let i = 0; i < 10; i++) {
            await sleep(500);
            const s = await getWriterStatus(editorFrame);
            const c = parseInt((s.match(/(\d+) characters/) || [0, '0'])[1]);
            if (c > charsBefore) break;
        }
        const statusAfterType = await getWriterStatus(editorFrame);
        log(`After typing: ${statusAfterType}`);
        const charsAfter = parseInt((statusAfterType.match(/(\d+) characters/) || [0, '0'])[1]);
        check(`${doctype}: text typed (char count increased)`, charsAfter > charsBefore);
    } else {
        // Calc/Impress: confirm the editor is still alive after the input.
        if (doctype === 'calc') await page.keyboard.press('Enter');
        await sleep(1000);
        check(`${doctype}: page still responsive after typing`,
            await editorFrame.evaluate(() => document.title !== ''));
    }
    await snap(page, `${doctype}_typed`);

    // Save with Ctrl+S. relay-adapter's single-user branch will hash the
    // doc + send WasmFileSave to the parent (the viewer), which then
    // re-encrypts and PUTs to /api/v2/file/<fileId>.
    await page.keyboard.down('Control');
    await page.keyboard.press('s');
    await page.keyboard.up('Control');
    log('Ctrl+S sent');
    await sleep(3000);
    await snap(page, `${doctype}_saved`);
    check(`${doctype}: page survived save round-trip`,
        await editorFrame.evaluate(() => document.title !== ''));

    await page.close();
    log(`${doctype} test done`);
}

(async () => {
    const { browser, cleanup } = await launch();
    try {
        const dataDir = path.join(__dirname, '..', '..', '..', 'test', 'data');
        await runOne(browser, 'writer',  path.join(dataDir, 'new.docx'),         'SingleUserDocx ');
        await runOne(browser, 'calc',    path.join(dataDir, 'testdoc.xlsx'),      'Hello123');
        await runOne(browser, 'impress', path.join(dataDir, 'rare-fonts.pptx'),   'SlideText');

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
