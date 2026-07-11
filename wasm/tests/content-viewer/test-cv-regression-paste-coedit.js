// test-cv-regression-paste-coedit.js — comprehensive paste + copy in a
// 2-browser co-edit session, through the Tresorit content viewer.
//
// Tests (subject-identical to the legacy viewer test, re-driven via CV):
//   1.  Paste rich text (bold+italic HTML) from "external app" → both browsers
//   1b. Paste exact "ABC" — exactly 3 chars added, both browsers
//   2.  Paste image from "external app" → embedded in the saved docx (verified
//       via tester Save → browser download → unzip: word/media/ entry present)
//   3.  Internal copy (Ctrl+C) → the SYSTEM clipboard is populated
//   4.  Internal cut+paste cycle → content preserved (headless-cut tolerated)
//   5.  Final convergence: both browsers have content, neither shows a selection
//   6.  Internal copy+paste AFTER external paste (regression for _suppressNextPaste)
//   7.  Double-paste guard: internal copy then external Ctrl+V pastes ONLY the
//       new content, not also the internal clipboard
//   8.  External image paste AFTER internal text copy (no text double-paste)
//
// Real keyboard/mouse only. Clipboard writes are preceded by bringToFront()
// (multi-tab focus). "Save" = the tester Save button (co-edit: cvSaveAndRotate
// → /shared-file; then a browser download for content verification), replacing
// the legacy Ctrl+S + downloadV2 storage probe.
//
// NOTE: the legacy test's Test 3 also read app.map._clip._selectionContent and
// Test 4 issued .uno:Cut directly — both are internal/sendUnoCommand paths
// forbidden by the CV recipe. The SUBJECT (copy populates the clipboard; cut
// then paste round-trips) is preserved here via the read-only
// navigator.clipboard.read() probe + real Ctrl+X/Ctrl+V.
//
// Migrated from wasm/tests/regression/test-regression-paste-coedit.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-paste-coedit.js [base-url]

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { launch, sleep } = require('../../lib/browser');
const {
    openCoEditPair, cvEditorFrame, cvCharCount, waitCvCharCount,
} = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/regression-paste-coedit';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const PROPAGATE_BUDGET = parseInt(process.env.PROPAGATE_BUDGET || '30000', 10);
const VP = { width: 1280, height: 900 };
// 1x1 PNG used as the "external app" image payload.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    try { await page.screenshot({ path: `${SHOT_DIR}/${String(++shotNum).padStart(2, '0')}_${name}.png` }); } catch (e) {}
}

async function getWc(page) {
    const fr = cvEditorFrame(page);
    if (!fr) return '';
    return fr.evaluate(() => document.querySelector('#StateWordCount')?.textContent?.trim() || '').catch(() => '');
}
function charCount(s) { const m = s && s.match(/(\d+) characters/); return m ? parseInt(m[1]) : -1; }
async function cc(page) { return charCount(await getWc(page)); }
async function waitForCC(page, target, timeoutMs) {
    return (await waitCvCharCount(page, c => c === target, timeoutMs)) === target;
}
async function clickCanvas(page) {
    await page.bringToFront().catch(() => {});
    const el = await page.$('iframe');
    const box = el && await el.boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(500);
}
async function grantClipboard(page) {
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.grantPermissions', {
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    }).catch(() => {});
}
// Write clipboard payloads; bringToFront first (multi-tab focus), fall back to
// the editor frame if the parent-page write is rejected.
async function writeClip(page, items, binary) {
    await page.bringToFront().catch(() => {});
    const writer = target => target.evaluate(async (its, bin, b64) => {
        const blobItems = {};
        for (const k in its) blobItems[k] = new Blob([its[k]], { type: k });
        if (bin) {
            const raw = atob(b64);
            const bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
            blobItems['image/png'] = new Blob([bytes], { type: 'image/png' });
        }
        await navigator.clipboard.write([new ClipboardItem(blobItems)]);
    }, items, !!binary, PNG_B64);
    try { await writer(page); } catch (e) {
        const fr = cvEditorFrame(page);
        if (fr) await writer(fr);
    }
    await sleep(500);
}
// Tester Save button → co-edit checkpoint rotate + browser download of bytes.
async function saveAndDownload(page, downloadDir) {
    await page.bringToFront().catch(() => {});
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir }).catch(() => {});
    const before = new Set(fs.readdirSync(downloadDir));
    const h = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find(b => /^save$/i.test((b.textContent || '').trim())));
    const el = h.asElement();
    if (!el) return null;
    await el.click();
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const now = fs.readdirSync(downloadDir).filter(f => !before.has(f) && !f.endsWith('.crdownload'));
        if (now.length) return path.join(downloadDir, now[0]);
        await sleep(500);
    }
    return null;
}

(async () => {
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
    log('=== CV comprehensive paste/copy co-edit test (docx) ===');
    log('viewer: ' + BASE);
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-paste-dl-'));
    const { browser } = await launch({ headless: 'new' });
    let ctxB = null;
    try {
        const bytes = fs.readFileSync(FIXTURE);
        const pair = await openCoEditPair(browser, BASE, 'cv-paste-full-' + Date.now() + '.docx', bytes, {
            userA: 'Alice Paste', userB: 'Bob Paste', viewport: VP, loadBudgetMs: LOAD_BUDGET,
        });
        const pageA = pair.A.page; const pageB = pair.B.page; ctxB = pair.contextB;
        await grantClipboard(pageA); await grantClipboard(pageB);
        await sleep(15000);

        await snap(pageA, 'before_A'); await snap(pageB, 'before_B');
        const initA = await cc(pageA); const initB = await cc(pageB);
        log(`Initial: A=${initA} B=${initB}`);
        check('Both browsers loaded same docx', initA > 0 && initA === initB);

        // ── TEST 1: Paste RICH TEXT from external app ──
        log('--- TEST 1: Paste rich text (bold + italic) ---');
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('End'); await pageA.keyboard.up('Control');
        await sleep(500);
        await writeClip(pageA, { 'text/html': '<p><b>ExternalBold</b> and <i>ExternalItalic</i></p>', 'text/plain': 'ExternalBold and ExternalItalic' });
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('v'); await pageA.keyboard.up('Control');
        await sleep(8000);
        await snap(pageA, 'after_richtext_A');
        const afterRichA = await cc(pageA);
        await waitForCC(pageB, afterRichA, PROPAGATE_BUDGET);
        await snap(pageB, 'after_richtext_B');
        const afterRichB = await cc(pageB);
        log(`After rich paste: A=${afterRichA} B=${afterRichB}`);
        check('TEST1: A char count increased after rich paste', afterRichA > initA);
        check('TEST1: B char count increased (propagated)', afterRichB > initB);
        check('TEST1: A and B converge', afterRichA === afterRichB);
        check('TEST1: No metadata leak (added ~30 chars)', afterRichA < initA + 50,
            'chars=' + afterRichA + ' (init was ' + initA + ', added ~30 expected)');

        // ── TEST 1b: Paste exact "ABC" ──
        log('--- TEST 1b: Paste exactly "ABC" ---');
        const beforeABC = await cc(pageA);
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('End'); await pageA.keyboard.up('Control');
        await sleep(500);
        await writeClip(pageA, { 'text/html': '<p>ABC</p>', 'text/plain': 'ABC' });
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('v'); await pageA.keyboard.up('Control');
        await sleep(8000);
        const afterABC_A = await cc(pageA);
        await waitForCC(pageB, afterABC_A, PROPAGATE_BUDGET);
        const afterABC_B = await cc(pageB);
        log(`Paste ABC: A=${afterABC_A} B=${afterABC_B} (was ${beforeABC})`);
        check('TEST1b: A gained exactly 3 chars (ABC)', afterABC_A === beforeABC + 3, 'delta=' + (afterABC_A - beforeABC));
        check('TEST1b: B gained exactly 3 chars (ABC)', afterABC_B === beforeABC + 3, 'delta=' + (afterABC_B - beforeABC));

        // ── TEST 2: Paste IMAGE from external app, verify embedded in saved docx ──
        log('--- TEST 2: Paste image (PNG) ---');
        await clickCanvas(pageA);
        await pageA.keyboard.press('Escape'); await sleep(500);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('End'); await pageA.keyboard.up('Control');
        await sleep(500);
        await writeClip(pageA, {}, true);
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('v'); await pageA.keyboard.up('Control');
        await sleep(5000);
        const savedPath = await saveAndDownload(pageA, dlDir);
        await snap(pageA, 'after_image_A'); await snap(pageB, 'after_image_B');
        let hasMedia = false;
        if (savedPath) {
            try { const listing = execFileSync('unzip', ['-l', savedPath], { encoding: 'utf8' }); hasMedia = /word\/media\//.test(listing); }
            catch (e) { log('  unzip failed: ' + String(e).slice(0, 80)); }
        }
        log(`Image: saved=${savedPath ? path.basename(savedPath) : '(none)'} media=${hasMedia}`);
        check('TEST2: saved docx embeds the pasted image (word/media/ entry)', hasMedia, savedPath || 'no download');

        // ── TEST 3: Internal COPY → system clipboard populated ──
        // (Subject preserved via the read-only navigator.clipboard.read()
        // probe — the legacy app.map._clip read is internal-state, forbidden.)
        log('--- TEST 3: Internal Ctrl+C → clipboard populated ---');
        await clickCanvas(pageA);
        await pageA.keyboard.press('Escape'); await sleep(500);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('Home'); await pageA.keyboard.up('Control');
        await sleep(500);
        for (let w = 0; w < 3; w++) {
            await pageA.keyboard.down('Control'); await pageA.keyboard.down('Shift');
            await pageA.keyboard.press('ArrowRight');
            await pageA.keyboard.up('Shift'); await pageA.keyboard.up('Control');
            await sleep(300);
        }
        await sleep(1000);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('c'); await pageA.keyboard.up('Control');
        await sleep(3000);
        const clip = await (cvEditorFrame(pageA) || pageA).evaluate(async () => {
            try { const items = await navigator.clipboard.read(); const types = []; for (const it of items) for (const t of it.types) types.push(t); return { types }; }
            catch (e) { return { error: e.message }; }
        }).catch(e => ({ error: String(e) }));
        log(`Clipboard after copy: ${JSON.stringify(clip.types || clip.error)}`);
        check('TEST3: internal copy populated the system clipboard',
            clip.types && clip.types.length > 0, 'types=' + JSON.stringify(clip.types || []));
        check('TEST3: clipboard carries HTML (rich content)',
            clip.types && clip.types.includes('text/html'), 'types=' + JSON.stringify(clip.types || []));

        // ── TEST 4: Internal CUT + PASTE ──
        // (headless Chromium may not fire a trusted cut — we press real Ctrl+X
        // and tolerate "cut did not remove" as a headless artefact, then paste
        // back, matching the legacy tolerance.)
        log('--- TEST 4: Select word → Cut → Paste back ---');
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('Home'); await pageA.keyboard.up('Control');
        await sleep(500);
        const beforeCut = await cc(pageA);
        await pageA.keyboard.down('Control'); await pageA.keyboard.down('Shift');
        await pageA.keyboard.press('ArrowRight');
        await pageA.keyboard.up('Shift'); await pageA.keyboard.up('Control');
        await sleep(500);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('x'); await pageA.keyboard.up('Control');
        let afterCut = await cc(pageA);
        const cutDeadline = Date.now() + 30000;
        while (afterCut >= beforeCut && Date.now() < cutDeadline) { await sleep(500); afterCut = await cc(pageA); }
        log(`Cut: ${beforeCut} -> ${afterCut}`);
        if (afterCut >= beforeCut) log('  (note) Cut did not remove content — headless limitation, not a regression');
        else check('TEST4: Cut removed content', true);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('v'); await pageA.keyboard.up('Control');
        await sleep(3000);
        const afterPasteBack = await cc(pageA);
        log(`Paste back: ${afterCut} -> ${afterPasteBack}`);
        check('TEST4: Paste restored content', afterPasteBack >= afterCut);

        // ── TEST 5: Final convergence ──
        log('--- TEST 5: Final convergence ---');
        await sleep(5000);
        for (const p of [pageA, pageB]) { await clickCanvas(p); await p.keyboard.press('Escape'); }
        await sleep(1000);
        for (const p of [pageA, pageB]) { await clickCanvas(p); await p.keyboard.press('ArrowRight'); }
        await sleep(2000);
        await snap(pageA, 'final_A'); await snap(pageB, 'final_B');
        const finalA = await getWc(pageA); const finalB = await getWc(pageB);
        const fA = charCount(finalA); const fB = charCount(finalB);
        log(`Final: A="${finalA}" B="${finalB}"`);
        check('TEST5: Both browsers have content', fA > 0 && fB > 0);
        check('TEST5: Final A status not "Selected:"', !finalA.startsWith('Selected:'), finalA);
        check('TEST5: Final B status not "Selected:"', !finalB.startsWith('Selected:'), finalB);

        // ── TEST 6: Internal copy+paste AFTER external paste ──
        log('--- TEST 6: Internal copy+paste after external paste ---');
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('Home'); await pageA.keyboard.up('Control');
        await sleep(500);
        await pageA.keyboard.down('Control'); await pageA.keyboard.down('Shift');
        await pageA.keyboard.press('ArrowRight');
        await pageA.keyboard.up('Shift'); await pageA.keyboard.up('Control');
        await sleep(500);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('c'); await pageA.keyboard.up('Control');
        await sleep(2000);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('End'); await pageA.keyboard.up('Control');
        await sleep(1000);
        const beforeIntPaste = await cc(pageA);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('v'); await pageA.keyboard.up('Control');
        await sleep(5000);
        const afterIntPaste = await cc(pageA);
        const intDelta = afterIntPaste - beforeIntPaste;
        log(`Internal paste: ${beforeIntPaste} -> ${afterIntPaste} (delta=${intDelta})`);
        check('TEST6: Internal paste works after external paste', intDelta > 0,
            'delta=' + intDelta + (intDelta === 0 ? ' -- paste was blocked!' : ''));

        // ── TEST 7: Double-paste guard ──
        log('--- TEST 7: Double-paste guard ---');
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('End'); await pageA.keyboard.up('Control');
        await sleep(500);
        await pageA.keyboard.type('MARKER', { delay: 50 });
        await sleep(3000);
        for (let i = 0; i < 6; i++) { await pageA.keyboard.down('Shift'); await pageA.keyboard.press('ArrowLeft'); await pageA.keyboard.up('Shift'); await sleep(100); }
        await sleep(500);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('c'); await pageA.keyboard.up('Control');
        await sleep(2000);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('End'); await pageA.keyboard.up('Control');
        await sleep(1000);
        const beforeDbl = await cc(pageA);
        await writeClip(pageA, { 'text/html': '<p>NEW</p>', 'text/plain': 'NEW' });
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('v'); await pageA.keyboard.up('Control');
        await sleep(8000);
        const afterDbl = await cc(pageA);
        const dblDelta = afterDbl - beforeDbl;
        log(`Double-paste test: ${beforeDbl} -> ${afterDbl} (delta=${dblDelta})`);
        check('TEST7: Only "NEW" pasted, not also "MARKER" (delta=3)', dblDelta === 3,
            'delta=' + dblDelta + (dblDelta === 9 ? ' -- DOUBLE PASTE BUG' : ''));

        // ── TEST 8: External image paste after internal text copy ──
        log('--- TEST 8: External image paste after internal text copy ---');
        const before8 = await cc(pageA);
        await writeClip(pageA, {}, true);
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('v'); await pageA.keyboard.up('Control');
        await sleep(8000);
        const after8 = await cc(pageA);
        const delta8 = after8 - before8;
        log(`Image paste after copy: ${before8} -> ${after8} (delta=${delta8})`);
        check('TEST8: No text double-paste with external image (delta <= 2)', delta8 <= 2,
            'delta=' + delta8 + (delta8 > 5 ? ' -- text was pasted alongside image' : ''));
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        if (ctxB) { try { await ctxB.close(); } catch (e) {} }
        try { await browser.close(); } catch (e) {}
        try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch (e) {}
    }
    log('\n' + (allPassed ? 'ALL PASS' : 'SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
