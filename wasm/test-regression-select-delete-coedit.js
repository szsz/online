const __cl = require('./lib/inject-checklist');
// Regression test: selecting a word in one browser and pressing Delete must
// propagate the deletion to the other browser.
//
// User-reported bug: in browser A, double-click a word to select it, then
// press Delete. Browser A removes the word; browser B still shows the word
// (the deletion never propagates).
//
// Method matches the user's actual repro path:
//   - Open the viewer at /#file=<name> in two separate browser contexts
//     (so each gets its own SAB / iframe / SW)
//   - The doc is a real .docx (matters: docx parsing/save path is heavier
//     than .txt and was where the user actually saw the divergence)
//   - A double-clicks inside the doc to select a word
//   - A presses Delete via real keyboard events (same path as a real user)
//   - Both browsers deselect (Right arrow) so #StateWordCount reports
//     doc-char-count not selection-char-count
//   - Both must converge to the same shorter doc
const { launch, sleep } = require('./lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-select-delete';
const DOC_NAME = 'Simple small document.docx';
const DOC_PATH = path.join(__dirname, '..', 'test', 'data', DOC_NAME);

const T0 = Date.now();
function log(m) { console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await sleep(300);
    const f = `${String(++shotNum).padStart(2,'0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch(e) {}
    log(`[snap] ${f}`);
}

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}${ev?' ['+ev+']':''}`); allPassed = false; }
}

async function getEditorFrame(page) {
    return page.frames().find(f => f.url().includes('cool.html'));
}
// COOL formats #StateWordCount as either:
//   "N words, M characters"             (no selection — M is doc size)
//   "Selected: N words, M characters"   (selection active — M is selection size)
// We always deselect first, so callers can rely on M == doc size.
async function getStatus(page) {
    const fr = await getEditorFrame(page);
    if (!fr) return '';
    try {
        return await fr.evaluate(() =>
            document.querySelector('#StateWordCount')?.textContent?.trim() || '');
    } catch (e) { return ''; }
}
function charCount(status) {
    const m = status && status.match(/(\d+) characters/);
    return m ? parseInt(m[1]) : -1;
}
function isSelectionStatus(status) {
    return /^Selected:/i.test((status || '').trim());
}
async function clickCanvas(page) {
    const frameEl = await page.$('iframe#editor-frame');
    if (frameEl) {
        const box = await frameEl.boundingBox();
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    await sleep(300);
}
async function clearSelection(page) {
    // ArrowRight without modifier collapses any selection to the caret
    // in writer.
    await clickCanvas(page);
    await page.keyboard.press('ArrowRight');
    await sleep(800);
}
async function waitForCharCount(page, expected, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (charCount(await getStatus(page)) === expected) return Date.now() - t0;
        await sleep(250);
    }
    return -1;
}

(async () => {
    log('=== Regression: select-word + Delete co-edit (docx via viewer) ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    if (!fs.existsSync(DOC_PATH)) { log('ERROR: fixture missing: ' + DOC_PATH); process.exit(1); }

    const { browser, cleanup } = await launch();

    try {
        // Upload the docx fresh so the test is self-contained (the real
        // /api/files/<name> is whatever was uploaded last; we want
        // deterministic content per-run).
        const up = await browser.newPage();
        await up.goto(VIEWER + '/');
        const bytes = fs.readFileSync(DOC_PATH);
        await up.evaluate(async (n, a) => {
            await fetch('/api/files/' + encodeURIComponent(n), {
                method: 'POST', body: new Blob([new Uint8Array(a)]),
            });
        }, DOC_NAME, Array.from(bytes));
        await up.close();
        log(`Uploaded "${DOC_NAME}" (${(bytes.length/1024).toFixed(1)} KB)`);

        async function openInViewer(label) {
            const ctx = await browser.createBrowserContext();
            const page = await ctx.newPage();
            await page.setViewport({ width: 1280, height: 900 });
            await page.goto(VIEWER + '/#file=' + encodeURIComponent(DOC_NAME),
                { waitUntil: 'domcontentloaded' });
            // Wait for the editor iframe to load and the doc to parse.
            const deadline = Date.now() + 240000;
            while (Date.now() < deadline) {
                const fr = await getEditorFrame(page);
                if (fr) {
                    const wc = await fr.evaluate(() =>
                        document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
                    if (/\d+\s+character/i.test(wc)) {
                        log(`[${label}] Loaded: "${wc.trim()}"`);
                        return page;
                    }
                }
                await sleep(500);
            }
            throw new Error(`[${label}] never loaded`);
        }

        const pageA = await openInViewer('A');
        await sleep(8000);                     // settle, initial save
        const pageB = await openInViewer('B'); // late-joiner
        await sleep(15000);                    // B gets checkpoint + replays log

        await snap(pageA, 'A_initial');
        await snap(pageB, 'B_initial');
        const initA = charCount(await getStatus(pageA));
        const initB = charCount(await getStatus(pageB));
        log(`Initial: A=${initA} chars, B=${initB} chars`);
        check('A and B both load the same number of characters',
              initA > 0 && initA === initB,
              'A=' + initA + ' B=' + initB);

        // ── A: select the first word via REAL keyboard events ──────────
        // The user-reported bug is about the SELECT+DELETE reaching B;
        // using actual keyboard events (rather than TheFakeWebSocket)
        // matches what the user does and exercises the same dispatch path.
        log('\n--- A: Ctrl+Home, Ctrl+Shift+Right (select first word), Delete ---');
        await clickCanvas(pageA);
        // Ctrl+Home — move caret to start of document
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('Home');
        await pageA.keyboard.up('Control');
        await sleep(1200);
        // Ctrl+Shift+Right — select the first word
        await pageA.keyboard.down('Control');
        await pageA.keyboard.down('Shift');
        await pageA.keyboard.press('ArrowRight');
        await pageA.keyboard.up('Shift');
        await pageA.keyboard.up('Control');
        await sleep(1500);
        await snap(pageA, 'A_after_select');
        await snap(pageB, 'B_after_select');

        const sASel = await getStatus(pageA);
        log(`A after select: "${sASel}"`);
        const aSelectionSize = isSelectionStatus(sASel) ? charCount(sASel) : 0;
        check('A has a selection of the first word',
              isSelectionStatus(sASel) && aSelectionSize > 0,
              sASel);

        // Delete via real keyboard
        await pageA.keyboard.press('Delete');
        log(`A: pressed Delete (selection was ${aSelectionSize} chars)`);

        // Wait for propagation, then DESELECT on both before reading
        // doc-char-count.
        log('Waiting 12s for the delete to propagate to B...');
        await sleep(12000);
        await snap(pageA, 'A_after_delete');
        await snap(pageB, 'B_after_delete');

        await clearSelection(pageA);
        await clearSelection(pageB);
        await snap(pageA, 'A_after_deselect');
        await snap(pageB, 'B_after_deselect');

        const sA = await getStatus(pageA);
        const sB = await getStatus(pageB);
        const finalA = charCount(sA);
        const finalB = charCount(sB);
        log(`Final (after deselect): A="${sA}" → ${finalA} chars`);
        log(`                        B="${sB}" → ${finalB} chars`);

        check('A status no longer reports a selection', !isSelectionStatus(sA), sA);
        check('B status no longer reports a selection', !isSelectionStatus(sB), sB);
        check('A reflects the deletion locally (chars decreased)',
              finalA > 0 && finalA < initA,
              'init=' + initA + ' final=' + finalA);
        check('B reflects A\'s select+delete (THE user-reported bug)',
              finalB === finalA,
              'A=' + finalA + ' B=' + finalB +
              (finalB === initB ? ' — peer never saw the deletion' : ''));

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
