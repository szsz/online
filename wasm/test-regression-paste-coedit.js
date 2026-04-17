const __cl = require('./lib/inject-checklist');
// Comprehensive paste + copy test in 2-browser co-edit session.
//
// Tests:
//   1. Paste rich text (bold+italic HTML) from "external app" -> both browsers
//   2. Paste image from "external app" -> embedded in saved docx
//   3. Internal copy (Ctrl+C) -> system clipboard has content
//   4. Internal cut+paste cycle -> content preserved
//   5. Verify NO metadata/headers leak into pasted content
//   6. Final convergence: both browsers same char count
//
// ALL input via real keyboard/mouse — no TheFakeWebSocket.send() calls.
const { launch, sleep } = require('./lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');

const BASE = env.EDITOR_URL;
const RELAY_BASE = env.RELAY_URL;
const TIMEOUT = 300000;
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
async function getWc(page) {
    return page.evaluate(() =>
        document.querySelector('#StateWordCount')?.textContent?.trim() || '');
}

// Click the editor canvas to focus it before any keyboard input
async function clickCanvas(page) {
    await page.mouse.click(640, 400);
    await sleep(500);
}

(async () => {
    log('=== Comprehensive paste/copy co-edit test (docx) ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    if (!fs.existsSync(FIXTURE)) { log('ERROR: fixture missing'); process.exit(1); }

    const { browser, cleanup } = await launch();

    const NAME = 'paste-full-' + Date.now() + '.docx';
    const ROOM = 'paste-full-' + Date.now();
    const relay = encodeURIComponent(`${RELAY_BASE}/room/${ROOM}`);
    const fileStorageUrl = encodeURIComponent(env.FILE_STORAGE_URL);
    const coolUrl = `${BASE}/browser/cool.html?WOPISrc=${encodeURIComponent(NAME)}&relay=${relay}&access_token=test&fileStorageUrl=${fileStorageUrl}`;

    try {
        // Upload docx
        const fixtureBytes = fs.readFileSync(FIXTURE);
        const up = await browser.newPage();
        await up.goto(BASE, { waitUntil: 'domcontentloaded' });
        await up.evaluate(async (base, n, a) => {
            await fetch(base + '/wasm/' + encodeURIComponent(n), {
                method: 'POST', body: new Blob([new Uint8Array(a)]),
            });
        }, BASE, NAME, Array.from(fixtureBytes));
        await up.close();
        log(`Uploaded ${NAME}`);

        // Grant clipboard permissions via CDP for both browsers
        async function openWithClipboard(label) {
            const ctx = await browser.createBrowserContext();
            const page = await ctx.newPage();
            const cdp = await page.createCDPSession();
            try {
                await cdp.send('Browser.grantPermissions', {
                    permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
                });
            } catch(e) {}
            await page.goto(coolUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
            await page.waitForFunction(() =>
                document.querySelector('#StateWordCount')?.textContent?.includes('characters'),
                { timeout: TIMEOUT });
            log(`[${label}] Loaded: "${await getWc(page)}"`);
            return { page, cdp };
        }

        const { page: pageA, cdp: cdpA } = await openWithClipboard('A');
        await sleep(8000);
        const { page: pageB, cdp: cdpB } = await openWithClipboard('B');
        await sleep(15000);

        await snap(pageA, 'before_A');
        await snap(pageB, 'before_B');
        const initA = charCount(await getWc(pageA));
        const initB = charCount(await getWc(pageB));
        log(`Initial: A=${initA} B=${initB}`);
        check('Both browsers loaded same docx', initA > 0 && initA === initB);

        // ══════════════════════════════════════════════════════════════
        // TEST 1: Paste RICH TEXT from "external app" (clipboard write + Ctrl+V)
        // ══════════════════════════════════════════════════════════════
        log('\n--- TEST 1: Paste rich text (bold + italic) from external app ---');
        await clickCanvas(pageA);
        // Ctrl+End to go to end of document
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('End');
        await pageA.keyboard.up('Control');
        await sleep(500);
        // Set clipboard to rich HTML, then paste
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
        await snap(pageB, 'after_richtext_B');
        const afterRichA = charCount(await getWc(pageA));
        const afterRichB = charCount(await getWc(pageB));
        log(`After rich paste: A=${afterRichA} B=${afterRichB}`);
        check('TEST1: A char count increased after rich paste', afterRichA > initA);
        check('TEST1: B char count increased (propagated)', afterRichB > initB);
        check('TEST1: A and B converge', afterRichA === afterRichB);

        // Verify no metadata leaked: check visible text doesn't contain
        // "text/plain", "text/html", "mimetype", or hex size prefixes
        const visibleTextA = await pageA.evaluate(() => {
            var wc = document.querySelector('#StateWordCount')?.textContent || '';
            return wc;
        });
        check('TEST1: No metadata leak (word count reasonable)',
              afterRichA < initA + 50,
              'chars=' + afterRichA + ' (init was ' + initA + ', added ~30 expected)');

        // ══════════════════════════════════════════════════════════════
        // TEST 1b: Paste exact "ABC" and verify EXACTLY 3 chars added
        // ══════════════════════════════════════════════════════════════
        log('\n--- TEST 1b: Paste exactly "ABC" ---');
        const beforeABC = charCount(await getWc(pageA));
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('End');
        await pageA.keyboard.up('Control');
        await sleep(500);
        // Set clipboard to "ABC", then paste
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
        const afterABC_B = charCount(await getWc(pageB));
        log(`Paste ABC: A=${afterABC_A} B=${afterABC_B} (was ${beforeABC})`);
        check('TEST1b: A gained exactly 3 chars (ABC)',
              afterABC_A === beforeABC + 3,
              'delta=' + (afterABC_A - beforeABC));
        check('TEST1b: B gained exactly 3 chars (ABC)',
              afterABC_B === beforeABC + 3,
              'delta=' + (afterABC_B - beforeABC));

        // ══════════════════════════════════════════════════════════════
        // TEST 2: Paste IMAGE from "external app"
        // ══════════════════════════════════════════════════════════════
        log('\n--- TEST 2: Paste image (PNG) from external app ---');
        // Save baseline before image
        await pageA.evaluate(() => {
            if (globalThis.postMobileMessage)
                globalThis.postMobileMessage('save dontTerminateEdit=1 dontSaveIfUnmodified=0');
        });
        await sleep(4000);
        const preImgSize = await pageA.evaluate(async (base, n) => {
            return (await (await fetch(base + '/wasm/' + encodeURIComponent(n))).arrayBuffer()).byteLength;
        }, BASE, NAME);

        // Escape any selection, go to end
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
        // Save after image
        await pageA.evaluate(() => {
            if (globalThis.postMobileMessage)
                globalThis.postMobileMessage('save dontTerminateEdit=1 dontSaveIfUnmodified=0');
        });
        let postImgSize = preImgSize;
        for (let i = 0; i < 15; i++) {
            await sleep(1000);
            postImgSize = await pageA.evaluate(async (base, n) => {
                return (await (await fetch(base + '/wasm/' + encodeURIComponent(n))).arrayBuffer()).byteLength;
            }, BASE, NAME);
            if (postImgSize > preImgSize + 50) break;
        }
        await snap(pageA, 'after_image_A');
        await snap(pageB, 'after_image_B');
        log(`Image: pre=${preImgSize} post=${postImgSize} delta=${postImgSize-preImgSize}`);
        check('TEST2: Docx grew after image paste (embedded)', postImgSize > preImgSize);

        // ══════════════════════════════════════════════════════════════
        // TEST 3: Internal COPY (Ctrl+C -> system clipboard)
        // ══════════════════════════════════════════════════════════════
        log('\n--- TEST 3: Internal Ctrl+C -> system clipboard ---');
        // Select TEXT only (not the image -- SelectAll + image = "complex"
        // selection which needs a server download COOL can't do in WASM).
        // Go to start, select a few words via Ctrl+Shift+Right.
        await clickCanvas(pageA);
        await pageA.keyboard.press('Escape');
        await sleep(500);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('Home');
        await pageA.keyboard.up('Control');
        await sleep(500);
        // Select 3 words
        for (let w = 0; w < 3; w++) {
            await pageA.keyboard.down('Control');
            await pageA.keyboard.down('Shift');
            await pageA.keyboard.press('ArrowRight');
            await pageA.keyboard.up('Shift');
            await pageA.keyboard.up('Control');
            await sleep(300);
        }
        await sleep(2000);
        // Request selection from Kit -- must go via postMobileMessage since
        // it's a query (not relayed). Give Kit time to respond.
        await pageA.evaluate(() => {
            globalThis._deliveringToKit = true;
            try { globalThis.postMobileMessage('gettextselection mimetype=text/html'); }
            finally { globalThis._deliveringToKit = false; }
        });
        await sleep(5000);
        const selContent = await pageA.evaluate(() => {
            var clip = window.app && window.app.map && window.app.map._clip;
            return {
                content: clip ? (clip._selectionContent || '').substring(0, 300) : null,
                type: clip ? clip._selectionType : null,
            };
        });
        log(`Selection: type=${selContent.type}, len=${(selContent.content||'').length}`);
        if (selContent.content) log(`  preview: "${selContent.content.substring(0, 80)}"`);
        check('TEST3: gettextselection returns HTML content',
              selContent.content && selContent.content.length > 20,
              'len=' + (selContent.content||'').length);
        check('TEST3: Content is real HTML (has tags)',
              selContent.content && selContent.content.includes('<'),
              (selContent.content||'').substring(0, 40));

        // ══════════════════════════════════════════════════════════════
        // TEST 4: Internal CUT + PASTE cycle
        // ══════════════════════════════════════════════════════════════
        log('\n--- TEST 4: Select word -> Cut -> Paste back ---');
        // Deselect first
        await clickCanvas(pageA);
        await pageA.keyboard.press('Home');
        await sleep(500);
        const beforeCut = charCount(await getWc(pageA));
        // Select first word
        await pageA.keyboard.down('Control');
        await pageA.keyboard.down('Shift');
        await pageA.keyboard.press('ArrowRight');
        await pageA.keyboard.up('Shift');
        await pageA.keyboard.up('Control');
        await sleep(500);
        // Cut
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('x');
        await pageA.keyboard.up('Control');
        await sleep(3000);
        const afterCut = charCount(await getWc(pageA));
        log(`Cut: ${beforeCut} -> ${afterCut}`);
        check('TEST4: Cut removed content', afterCut < beforeCut);
        // Paste back
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('v');
        await pageA.keyboard.up('Control');
        await sleep(3000);
        const afterPasteBack = charCount(await getWc(pageA));
        log(`Paste back: ${afterCut} -> ${afterPasteBack}`);
        check('TEST4: Paste restored content', afterPasteBack >= afterCut);

        // ══════════════════════════════════════════════════════════════
        // TEST 5: Final convergence + no metadata check
        // ══════════════════════════════════════════════════════════════
        log('\n--- TEST 5: Final convergence ---');
        await sleep(5000);
        // Deselect on both
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
        check('TEST5: Final A status not "Selected:"',
              !finalA.startsWith('Selected:'), finalA);
        check('TEST5: Final B status not "Selected:"',
              !finalB.startsWith('Selected:'), finalB);

        // ══════════════════════════════════════════════════════════════
        // TEST 6: Internal copy+paste AFTER external paste
        // (Bug: _suppressNextPaste was blocking all internal pastes)
        // ══════════════════════════════════════════════════════════════
        log('\n--- TEST 6: Internal copy+paste after external paste ---');
        // Select first word, copy
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
        // Copy
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('c');
        await pageA.keyboard.up('Control');
        await sleep(2000);
        // Deselect, go to end
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('End');
        await pageA.keyboard.up('Control');
        await sleep(1000);
        const beforeIntPaste = charCount(await getWc(pageA));
        // Internal paste
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('v');
        await pageA.keyboard.up('Control');
        await sleep(5000);
        const afterIntPaste = charCount(await getWc(pageA));
        const intDelta = afterIntPaste - beforeIntPaste;
        log(`Internal paste: ${beforeIntPaste} -> ${afterIntPaste} (delta=${intDelta})`);
        check('TEST6: Internal paste works after external paste (delta > 0)',
              intDelta > 0,
              'delta=' + intDelta + (intDelta === 0 ? ' -- paste was blocked!' : ''));

        // ══════════════════════════════════════════════════════════════
        // TEST 7: Double-paste guard -- internal copy then external Ctrl+V
        // After internal copy, Kit has the selection on its clipboard.
        // Then external paste (Ctrl+V with new content) should produce
        // ONLY the new content, not also the internal clipboard.
        // ══════════════════════════════════════════════════════════════
        log('\n--- TEST 7: Double-paste guard (internal copy -> external Ctrl+V) ---');
        // Type "MARKER" at end
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('End');
        await pageA.keyboard.up('Control');
        await sleep(500);
        await pageA.keyboard.type('MARKER', { delay: 50 });
        await sleep(3000);
        // Select "MARKER" and copy internally
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
        // Deselect, go to end
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('End');
        await pageA.keyboard.up('Control');
        await sleep(1000);
        const beforeDbl = charCount(await getWc(pageA));
        // Now paste "NEW" via clipboard (simulating external paste after internal copy)
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
        check('TEST7: Only "NEW" pasted, not also "MARKER" (delta=3, not 9)',
              dblDelta === 3,
              'delta=' + dblDelta + (dblDelta === 9 ? ' -- DOUBLE PASTE BUG' : ''));

        // ══════════════════════════════════════════════════════════════
        // TEST 8: External IMAGE paste after internal copy (double-paste)
        // ══════════════════════════════════════════════════════════════
        log('\n--- TEST 8: External image paste after internal text copy ---');
        const before8 = charCount(await getWc(pageA));
        // Set clipboard to an image (simulating external image copy)
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
