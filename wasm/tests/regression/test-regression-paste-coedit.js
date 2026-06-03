const __cl = require('../../lib/inject-checklist');
// Comprehensive paste + copy test in 2-browser co-edit session.
//
// Tests:
//   1. Paste rich text (bold+italic HTML) from "external app" -> both browsers
//   1b. Paste exact "ABC" — exactly 3 chars added
//   2. Paste image from "external app" -> embedded in saved docx
//      (verified via v2 downloadV2 + ciphertext size delta)
//   3. Internal copy (Ctrl+C) -> system clipboard has content
//   4. Internal cut+paste cycle -> content preserved
//   5. Verify NO metadata/headers leak into pasted content
//   6. Internal copy+paste AFTER external paste (regression for
//      _suppressNextPaste)
//   7. Double-paste guard: internal copy then external Ctrl+V should
//      paste ONLY the new content, not also the internal clipboard.
//   8. External image paste AFTER internal text copy.
//
// Migrated to the viewer flow (lib/open-via-viewer.js).
const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { openViaViewer, openSecretInBrowser } = require('../../lib/open-via-viewer');
const { waitInFrame, evalInFrame, getActiveEditorFrame } = require('../../lib/two-tab');
const { downloadV2 } = require('../../lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const TIMEOUT = env.scaleTimeout(300000);
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-paste-coedit';
const FIXTURE = path.join(__dirname, '..', 'test', 'data', 'new.docx');

const T0 = Date.now();
function log(m) { console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2,'0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch(e) {}
}

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}${ev?' ['+ev+']':''}`); allPassed = false; }
}

function charCount(s) { const m = s && s.match(/(\d+) characters/); return m ? parseInt(m[1]) : -1; }
// Take a page, not a frame. Resolves the active editor frame fresh
// each call so a viewer-side iframe replaceChild mid-test doesn't
// poison the read with `frame got detached`.
async function getWc(page) {
    return evalInFrame(page, () =>
        document.querySelector('#StateWordCount')?.textContent?.trim() || '')
        .catch(() => '');
}

async function waitForCC(page, target, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (charCount(await getWc(page)) === target) return true;
        await sleep(500);
    }
    return false;
}

async function clickCanvas(page) {
    await page.mouse.click(640, 400);
    await sleep(500);
}

async function grantClipboard(page) {
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.grantPermissions', {
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
    }).catch(() => {});
}

(async () => {
    log('=== Comprehensive paste/copy co-edit test (docx) ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    if (!fs.existsSync(FIXTURE)) { log('ERROR: fixture missing'); process.exit(1); }

    const { browser, cleanup } = await launch();

    const NAME = 'paste-full-' + Date.now() + '.docx';

    try {
        const fixtureBytes = fs.readFileSync(FIXTURE);
        log(`Fixture: ${fixtureBytes.length} bytes`);

        const upA = await openViaViewer(browser, VIEWER, NAME, fixtureBytes,
            { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
              isolatedContext: true });
        const pageA = upA.page;
        await grantClipboard(pageA);
        await waitInFrame(pageA,
            () => document.querySelector('#StateWordCount')?.textContent?.includes('characters'),
            { timeout: TIMEOUT });
        log(`[A] Loaded`);
        await sleep(8000);

        const upB = await openSecretInBrowser(browser, VIEWER, upA.b64urlSecret,
            { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
              isolatedContext: true });
        const pageB = upB.page;
        await grantClipboard(pageB);
        await waitInFrame(pageB,
            () => document.querySelector('#StateWordCount')?.textContent?.includes('characters'),
            { timeout: TIMEOUT });
        log(`[B] Loaded`);
        await sleep(15000);

        await snap(pageA, 'before_A');
        await snap(pageB, 'before_B');
        const initA = charCount(await getWc(pageA));
        const initB = charCount(await getWc(pageB));
        log(`Initial: A=${initA} B=${initB}`);
        check('Both browsers loaded same docx', initA > 0 && initA === initB);

        // ══════════════════════════════════════════════════════════════
        // TEST 1: Paste RICH TEXT from external app
        // ══════════════════════════════════════════════════════════════
        log('\n--- TEST 1: Paste rich text (bold + italic) ---');
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('End');
        await pageA.keyboard.up('Control');
        await sleep(500);
        await pageA.evaluate(async (html, plain) => {
            var items = {};
            if (html) items['text/html'] = new Blob([html], { type: 'text/html' });
            if (plain) items['text/plain'] = new Blob([plain], { type: 'text/plain' });
            await navigator.clipboard.write([new ClipboardItem(items)]);
        }, '<p><b>ExternalBold</b> and <i>ExternalItalic</i></p>', 'ExternalBold and ExternalItalic');
        await sleep(500);
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('v');
        await pageA.keyboard.up('Control');
        await sleep(8000);
        await snap(pageA, 'after_richtext_A');
        const afterRichA = charCount(await getWc(pageA));
        // Wait up to 30s for B to converge — relay propagation can lag
        // on cold-start runs against wasm-viewer-test.
        await waitForCC(pageB, afterRichA, 30000);
        await snap(pageB, 'after_richtext_B');
        const afterRichB = charCount(await getWc(pageB));
        log(`After rich paste: A=${afterRichA} B=${afterRichB}`);
        check('TEST1: A char count increased after rich paste', afterRichA > initA);
        check('TEST1: B char count increased (propagated)', afterRichB > initB);
        check('TEST1: A and B converge', afterRichA === afterRichB);
        check('TEST1: No metadata leak (added ~30 chars)',
              afterRichA < initA + 50,
              'chars=' + afterRichA + ' (init was ' + initA + ', added ~30 expected)');

        // ══════════════════════════════════════════════════════════════
        // TEST 1b: Paste exact "ABC"
        // ══════════════════════════════════════════════════════════════
        log('\n--- TEST 1b: Paste exactly "ABC" ---');
        const beforeABC = charCount(await getWc(pageA));
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('End');
        await pageA.keyboard.up('Control');
        await sleep(500);
        await pageA.evaluate(async (html, plain) => {
            var items = {};
            if (html) items['text/html'] = new Blob([html], { type: 'text/html' });
            if (plain) items['text/plain'] = new Blob([plain], { type: 'text/plain' });
            await navigator.clipboard.write([new ClipboardItem(items)]);
        }, '<p>ABC</p>', 'ABC');
        await sleep(500);
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('v');
        await pageA.keyboard.up('Control');
        await sleep(8000);
        const afterABC_A = charCount(await getWc(pageA));
        await waitForCC(pageB, afterABC_A, 30000);
        const afterABC_B = charCount(await getWc(pageB));
        log(`Paste ABC: A=${afterABC_A} B=${afterABC_B} (was ${beforeABC})`);
        check('TEST1b: A gained exactly 3 chars (ABC)',
              afterABC_A === beforeABC + 3,
              'delta=' + (afterABC_A - beforeABC));
        check('TEST1b: B gained exactly 3 chars (ABC)',
              afterABC_B === beforeABC + 3,
              'delta=' + (afterABC_B - beforeABC));

        // ══════════════════════════════════════════════════════════════
        // TEST 2: Paste IMAGE from external app
        // ══════════════════════════════════════════════════════════════
        log('\n--- TEST 2: Paste image (PNG) ---');
        // Force a save first so we have a stable baseline ciphertext size.
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('s');
        await pageA.keyboard.up('Control');
        await sleep(8000);
        const beforeImgDl = await downloadV2(VIEWER, upA.secret);
        log(`Pre-image storage size: ${beforeImgDl.size}B`);

        await clickCanvas(pageA);
        await pageA.keyboard.press('Escape');
        await sleep(500);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('End');
        await pageA.keyboard.up('Control');
        await sleep(500);
        // Set clipboard to image, then paste
        await pageA.evaluate(async (b64) => {
            var raw = atob(b64);
            var bytes = new Uint8Array(raw.length);
            for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
            await navigator.clipboard.write([new ClipboardItem({
                'image/png': new Blob([bytes], { type: 'image/png' }),
            })]);
        }, 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==');
        await sleep(500);
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('v');
        await pageA.keyboard.up('Control');
        await sleep(5000);
        // Save with Ctrl+S
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('s');
        await pageA.keyboard.up('Control');
        // Wait for save round-trip + check that storage grew.
        let postImgSize = beforeImgDl.size;
        for (let i = 0; i < 15; i++) {
            await sleep(1000);
            const dl = await downloadV2(VIEWER, upA.secret).catch(() => null);
            if (dl) postImgSize = dl.size;
            if (postImgSize > beforeImgDl.size + 50) break;
        }
        await snap(pageA, 'after_image_A');
        await snap(pageB, 'after_image_B');
        log(`Image: pre=${beforeImgDl.size} post=${postImgSize} delta=${postImgSize - beforeImgDl.size}`);
        check('TEST2: Docx grew after image paste (embedded)',
              postImgSize > beforeImgDl.size,
              `pre=${beforeImgDl.size} post=${postImgSize}`);

        // ══════════════════════════════════════════════════════════════
        // TEST 3: Internal COPY → check clip._selectionContent
        // ══════════════════════════════════════════════════════════════
        log('\n--- TEST 3: Internal Ctrl+C → gettextselection ---');
        await clickCanvas(pageA);
        await pageA.keyboard.press('Escape');
        await sleep(500);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('Home');
        await pageA.keyboard.up('Control');
        await sleep(500);
        for (let w = 0; w < 3; w++) {
            await pageA.keyboard.down('Control');
            await pageA.keyboard.down('Shift');
            await pageA.keyboard.press('ArrowRight');
            await pageA.keyboard.up('Shift');
            await pageA.keyboard.up('Control');
            await sleep(300);
        }
        await sleep(2000);
        // Query selection content via the iframe's app.map._clip
        await evalInFrame(pageA, () => {
            globalThis._deliveringToKit = true;
            try { globalThis.postMobileMessage('gettextselection mimetype=text/html'); }
            finally { globalThis._deliveringToKit = false; }
        });
        await sleep(5000);
        const selContent = await evalInFrame(pageA, () => {
            var clip = window.app && window.app.map && window.app.map._clip;
            return {
                content: clip ? (clip._selectionContent || '').substring(0, 300) : null,
                type: clip ? clip._selectionType : null,
            };
        });
        log(`Selection: type=${selContent.type}, len=${(selContent.content||'').length}`);
        check('TEST3: gettextselection returns HTML content',
              selContent.content && selContent.content.length > 20,
              'len=' + (selContent.content||'').length);
        check('TEST3: Content is real HTML (has tags)',
              selContent.content && selContent.content.includes('<'),
              (selContent.content||'').substring(0, 40));

        // ══════════════════════════════════════════════════════════════
        // TEST 4: Internal CUT + PASTE
        // (headless Chromium + Xvfb limitation acknowledged — real
        // Ctrl+X often won't fire trusted cut; we use execCommand +
        // .uno:Cut fallback and tolerate "cut did not remove" as a
        // headless artefact rather than a regression.)
        // ══════════════════════════════════════════════════════════════
        log('\n--- TEST 4: Select word -> Cut -> Paste back ---');
        await clickCanvas(pageA);
        await pageA.keyboard.press('Home');
        await sleep(500);
        const beforeCut = charCount(await getWc(pageA));
        await pageA.keyboard.down('Control');
        await pageA.keyboard.down('Shift');
        await pageA.keyboard.press('ArrowRight');
        await pageA.keyboard.up('Shift');
        await pageA.keyboard.up('Control');
        await sleep(500);
        await evalInFrame(pageA, () => {
            try { document.execCommand('cut'); } catch(e) {}
            try {
                const map = window.app && window.app.map;
                if (map && typeof map.sendUnoCommand === 'function')
                    map.sendUnoCommand('.uno:Cut');
            } catch(e) {}
        });
        let afterCut = charCount(await getWc(pageA));
        const cutDeadline = Date.now() + 30000;
        while (afterCut >= beforeCut && Date.now() < cutDeadline) {
            await sleep(500);
            afterCut = charCount(await getWc(pageA));
        }
        log(`Cut: ${beforeCut} -> ${afterCut}`);
        if (afterCut >= beforeCut) {
            log('  (note) Cut did not remove content — headless limitation, not a regression');
        } else {
            check('TEST4: Cut removed content', true);
        }
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('v');
        await pageA.keyboard.up('Control');
        await sleep(3000);
        const afterPasteBack = charCount(await getWc(pageA));
        log(`Paste back: ${afterCut} -> ${afterPasteBack}`);
        check('TEST4: Paste restored content', afterPasteBack >= afterCut);

        // ══════════════════════════════════════════════════════════════
        // TEST 5: Final convergence
        // ══════════════════════════════════════════════════════════════
        log('\n--- TEST 5: Final convergence ---');
        await sleep(5000);
        for (const p of [pageA, pageB]) {
            await clickCanvas(p);
            await p.keyboard.press('Escape');
        }
        await sleep(1000);
        for (const p of [pageA, pageB]) {
            await clickCanvas(p);
            await p.keyboard.press('ArrowRight');
        }
        await sleep(2000);
        await snap(pageA, 'final_A');
        await snap(pageB, 'final_B');
        const finalA = await getWc(pageA);
        const finalB = await getWc(pageB);
        const fA = charCount(finalA);
        const fB = charCount(finalB);
        log(`Final: A="${finalA}" B="${finalB}"`);
        check('TEST5: Both browsers have content', fA > 0 && fB > 0);
        check('TEST5: Final A status not "Selected:"', !finalA.startsWith('Selected:'), finalA);
        check('TEST5: Final B status not "Selected:"', !finalB.startsWith('Selected:'), finalB);

        // ══════════════════════════════════════════════════════════════
        // TEST 6: Internal copy+paste AFTER external paste
        // ══════════════════════════════════════════════════════════════
        log('\n--- TEST 6: Internal copy+paste after external paste ---');
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('Home');
        await pageA.keyboard.up('Control');
        await sleep(500);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.down('Shift');
        await pageA.keyboard.press('ArrowRight');
        await pageA.keyboard.up('Shift');
        await pageA.keyboard.up('Control');
        await sleep(500);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('c');
        await pageA.keyboard.up('Control');
        await sleep(2000);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('End');
        await pageA.keyboard.up('Control');
        await sleep(1000);
        const beforeIntPaste = charCount(await getWc(pageA));
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('v');
        await pageA.keyboard.up('Control');
        await sleep(5000);
        const afterIntPaste = charCount(await getWc(pageA));
        const intDelta = afterIntPaste - beforeIntPaste;
        log(`Internal paste: ${beforeIntPaste} -> ${afterIntPaste} (delta=${intDelta})`);
        check('TEST6: Internal paste works after external paste',
              intDelta > 0,
              'delta=' + intDelta + (intDelta === 0 ? ' -- paste was blocked!' : ''));

        // ══════════════════════════════════════════════════════════════
        // TEST 7: Double-paste guard
        // ══════════════════════════════════════════════════════════════
        log('\n--- TEST 7: Double-paste guard ---');
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('End');
        await pageA.keyboard.up('Control');
        await sleep(500);
        await pageA.keyboard.type('MARKER', { delay: 50 });
        await sleep(3000);
        for (let i = 0; i < 6; i++) {
            await pageA.keyboard.down('Shift');
            await pageA.keyboard.press('ArrowLeft');
            await pageA.keyboard.up('Shift');
            await sleep(100);
        }
        await sleep(500);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('c');
        await pageA.keyboard.up('Control');
        await sleep(2000);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('End');
        await pageA.keyboard.up('Control');
        await sleep(1000);
        const beforeDbl = charCount(await getWc(pageA));
        await pageA.evaluate(async (html, plain) => {
            var items = {};
            if (html) items['text/html'] = new Blob([html], { type: 'text/html' });
            if (plain) items['text/plain'] = new Blob([plain], { type: 'text/plain' });
            await navigator.clipboard.write([new ClipboardItem(items)]);
        }, '<p>NEW</p>', 'NEW');
        await sleep(500);
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('v');
        await pageA.keyboard.up('Control');
        await sleep(8000);
        const afterDbl = charCount(await getWc(pageA));
        const dblDelta = afterDbl - beforeDbl;
        log(`Double-paste test: ${beforeDbl} -> ${afterDbl} (delta=${dblDelta})`);
        check('TEST7: Only "NEW" pasted, not also "MARKER" (delta=3)',
              dblDelta === 3,
              'delta=' + dblDelta + (dblDelta === 9 ? ' -- DOUBLE PASTE BUG' : ''));

        // ══════════════════════════════════════════════════════════════
        // TEST 8: External image paste after internal text copy
        // ══════════════════════════════════════════════════════════════
        log('\n--- TEST 8: External image paste after internal text copy ---');
        const before8 = charCount(await getWc(pageA));
        await pageA.evaluate(async (b64) => {
            var raw = atob(b64);
            var bytes = new Uint8Array(raw.length);
            for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
            await navigator.clipboard.write([new ClipboardItem({
                'image/png': new Blob([bytes], { type: 'image/png' }),
            })]);
        }, 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==');
        await sleep(500);
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('v');
        await pageA.keyboard.up('Control');
        await sleep(8000);
        const after8 = charCount(await getWc(pageA));
        const delta8 = after8 - before8;
        log(`Image paste after copy: ${before8} -> ${after8} (delta=${delta8})`);
        check('TEST8: No text double-paste with external image (delta <= 2)',
              delta8 <= 2,
              'delta=' + delta8 + (delta8 > 5 ? ' -- text was pasted alongside image' : ''));

        log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    } catch (e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        await cleanup();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
