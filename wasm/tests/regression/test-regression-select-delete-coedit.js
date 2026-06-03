const __cl = require('../../lib/inject-checklist');
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
const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

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

const ENC_DOC_NAME = encodeURIComponent(DOC_NAME);
async function getEditorFrame(page) {
    // Require the target doc's name in the iframe URL — otherwise we latch
    // onto the prewarm blank's frame (its statusbar shows ~9.2k chars of
    // template text instead of the real 21-char doc).
    return page.frames().find(f =>
        f.url().includes('cool.html') && f.url().includes(ENC_DOC_NAME));
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
    // "9,213 characters" → 9213. Handles comma thousands-separator.
    const m = status && status.match(/([\d,]+)\s+characters/);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : -1;
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
        // Upload the docx fresh so the test is self-contained (v2 encrypted).
        const bytes = fs.readFileSync(DOC_PATH);
        const upDoc = await uploadV2(VIEWER, DOC_NAME, bytes);
        log(`Uploaded "${DOC_NAME}" (${(bytes.length/1024).toFixed(1)} KB) → ${upDoc.fileId.substring(0,8)}…`);

        async function openInViewer(label) {
            const ctx = await browser.createBrowserContext();
            const page = await ctx.newPage();
            await page.setViewport({ width: 1280, height: 900 });
            await page.goto(VIEWER + '/#file=' + upDoc.b64urlSecret,
                { waitUntil: 'domcontentloaded' });
            // Wait for the editor iframe that actually loaded the TARGET
            // doc. Two failure modes to guard against:
            //  1) Latching onto the prewarm blank frame (no target name
            //     in URL) — we filter by encName in URL to skip those.
            //  2) The hot-switch iframe has target name in its URL
            //     fragment (#switchdoc=<name>) but the actual switch
            //     hasn't completed yet — #StateWordCount still shows
            //     the prewarm's ~9200 chars of template boilerplate
            //     from accumulated Azure blob state. We detect that by
            //     also requiring the COOL title bar (#document-name-input
            //     — set by wasm-loader on switchdoc) to match DOC_NAME.
            // Strong readiness signal: the wasm-loader sets
            //   __bridgeLastSwitch = <filename> as soon as it sees the
            //   switchdoc request, and __wasmPrewarmReady flips to false
            //   on switchdoc_seen then true again only once the target
            //   doc's canvas + status-bar are populated.
            // So "target is ACTUALLY showing" = lastSwitch === DOC_NAME
            // AND prewarmReady === true. Without this gate we'd accept
            // the prewarm blank frame whose statusbar still reads ~9200
            // chars of accumulated template text from Azure's blob.
            // In v2 the WOPISrc/URL contains the opaque fileId (not the
            // plaintext name), and __wasmLoadedDocName is set to that too.
            const deadline = Date.now() + 240000;
            while (Date.now() < deadline) {
                const fr = page.frames().find(f =>
                    f.url().includes('cool.html') && f.url().includes(upDoc.fileId));
                if (fr) {
                    const state = await fr.evaluate(() => {
                        const wc = document.querySelector('#StateWordCount')?.textContent || '';
                        return {
                            wc,
                            loadedDoc: window.__wasmLoadedDocName || null,
                        };
                    }).catch(() => null);
                    if (state && state.loadedDoc === upDoc.fileId
                        && /\d+\s+character/i.test(state.wc)) {
                        log(`[${label}] Loaded: "${state.wc.trim()}"`);
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

        // On Azure, A's LO-parsed "save" of Simple small document.docx
        // lands on storage slightly after B starts loading — B sees
        // either the pre-A version or a partial replay. Wait up to 30s
        // for A and B to converge to the same char count before asserting.
        let initA = charCount(await getStatus(pageA));
        let initB = charCount(await getStatus(pageB));
        const convDeadline = Date.now() + 30000;
        while ((initA !== initB || initA <= 0) && Date.now() < convDeadline) {
            await sleep(500);
            initA = charCount(await getStatus(pageA));
            initB = charCount(await getStatus(pageB));
        }
        await snap(pageA, 'A_initial');
        await snap(pageB, 'B_initial');
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

        // Wait for B to converge with A (A deleted chars, B should receive
        // the deletion via the relay). On Azure the round-trip is slower.
        let sA = await getStatus(pageA);
        let sB = await getStatus(pageB);
        let finalA = charCount(sA);
        let finalB = charCount(sB);
        const convDeadline2 = Date.now() + 30000;
        while ((finalB !== finalA || isSelectionStatus(sA) || isSelectionStatus(sB))
               && Date.now() < convDeadline2) {
            await sleep(500);
            sA = await getStatus(pageA);
            sB = await getStatus(pageB);
            finalA = charCount(sA);
            finalB = charCount(sB);
        }
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
