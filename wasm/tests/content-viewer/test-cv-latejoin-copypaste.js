// test-cv-latejoin-copypaste.js — late-join + copy/paste. A types, copies,
// pastes (internal, external text, external image), saves; B late-joins and
// must receive ALL of A's content, then the session is live both ways.
//
// Legacy subject (viewer): A typed "HELLO ", Ctrl+A/C, internal paste,
// external text paste (+8), external image paste (no text change), then
// Ctrl+S; B late-joined the same doc and had to catch up to A's final char
// count (±5), then typed "EXTRA" which A had to see.
//
// CV port: A creates a co-edit room and runs the same paste ladder via real
// keyboard/mouse + system-clipboard writes; A saves with the tester Save
// button (rotates the /shared-file checkpoint). B late-joins the co-edit link
// in an isolated context and must converge to A's final count. B then types
// "EXTRA" at the end and A must see it. Visible-UI only; state read from
// #StateWordCount.
//
// Migrated from wasm/tests/misc/test-late-join-copypaste.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-latejoin-copypaste.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const {
    openBytesViaContentViewer, joinViaContentViewer,
    waitCvInteractive, cvEditorFrame, cvCharCount, waitCvCharCount,
} = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/latejoin-copypaste';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const CONVERGE_BUDGET = parseInt(process.env.CONVERGE_BUDGET || '90000', 10);

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
let shotN = 0;
async function snap(page, name) {
    try {
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${SHOT_DIR}/${String(++shotN).padStart(2, '0')}_${name}.png` });
    } catch (e) {}
}

async function clickEditor(page) {
    const el = await page.$('iframe');
    const box = el && await el.boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(500);
}
async function ctrl(page, key) {
    await page.keyboard.down('Control');
    await page.keyboard.press(key);
    await page.keyboard.up('Control');
    await sleep(200);
}
async function settleCc(page, pred, budgetMs = 40000) {
    return waitCvCharCount(page, pred, budgetMs);
}
async function writeClipItems(page, items) {
    const writer = target => target.evaluate(async (its) => {
        const blobItems = {};
        for (const k in its) blobItems[k] = new Blob([its[k]], { type: k });
        await navigator.clipboard.write([new ClipboardItem(blobItems)]);
    }, items);
    try { await writer(page); } catch (e) {
        const fr = cvEditorFrame(page);
        if (!fr) throw e;
        await writer(fr);
    }
    await sleep(500);
}
async function clickSave(page) {
    const h = await page.evaluateHandle(() =>
        [...document.querySelectorAll('button')].find(b => /^save$/i.test((b.textContent || '').trim())));
    const el = h.asElement();
    if (!el) return false;
    await el.click();
    return true;
}

(async () => {
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
    log('=== CV late-join + copy/paste ===');
    log('viewer: ' + BASE);
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    const { browser } = await launch({ headless: 'new' });
    let ctxB = null;
    try {
        const bytes = fs.readFileSync(FIXTURE);
        const NAME = 'cv-ljcp-' + Date.now() + '.docx';

        // ═══ Phase A: create co-edit room, type + paste + save ═══
        log('\n=== Phase A: type, copy, paste, save ===');
        const openA = await openBytesViaContentViewer(browser, BASE, NAME, bytes, {
            userName: 'CopyPaste Alice', coEdit: true, iframeTimeout: 60000,
        });
        const A = openA.page;
        check('A: editor iframe + join link', !!openA.editorFrame && !!openA.joinLink);
        const cdpA = await A.target().createCDPSession();
        try {
            await cdpA.send('Browser.grantPermissions', {
                permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
            });
        } catch (e) {}
        check('A: editor interactive', await waitCvInteractive(A, LOAD_BUDGET));
        await waitCvCharCount(A, c => c >= 0, 60000);
        await sleep(5000);

        await clickEditor(A);
        const cc0 = await cvCharCount(A);
        log('  Initial: ' + cc0 + ' chars');

        // Type "HELLO "
        await clickEditor(A);
        await A.keyboard.type('HELLO ', { delay: 80 });
        const cc1 = await settleCc(A, cc => cc - cc0 === 6, 24000);
        check('A typed +6', cc1 - cc0 === 6, 'delta=' + (cc1 - cc0));

        // Select all + copy + move to end + internal paste
        await clickEditor(A);
        await ctrl(A, 'a');
        await sleep(500);
        await ctrl(A, 'c');
        await sleep(3000);
        await ctrl(A, 'End');
        await sleep(300);
        await A.keyboard.press('End'); // deselect, stay at end
        await sleep(300);
        const ccPreInt = await cvCharCount(A);
        await ctrl(A, 'v');
        const cc2 = await settleCc(A, cc => cc > ccPreInt);
        check('A internal paste: delta > 0', cc2 > ccPreInt, 'delta=' + (cc2 - ccPreInt));

        // External plain-text paste ("EXTPASTE" = 8 chars)
        await writeClipItems(A, { 'text/plain': 'EXTPASTE' });
        await clickEditor(A);
        await ctrl(A, 'End');
        await sleep(300);
        const ccPreExt = await cvCharCount(A);
        await ctrl(A, 'v');
        const cc3 = await settleCc(A, cc => cc - ccPreExt === 8);
        check('A external text paste: +8', cc3 - ccPreExt === 8, 'delta=' + (cc3 - ccPreExt));

        // External image paste (1x1 PNG) — must not change the text count
        const writeImage = target => target.evaluate(async () => {
            const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
            const raw = atob(b64);
            const bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
            await navigator.clipboard.write([new ClipboardItem({
                'image/png': new Blob([bytes], { type: 'image/png' }),
                'text/plain': new Blob([''], { type: 'text/plain' }),
            })]);
        });
        try { await writeImage(A); } catch (e) {
            const frI = cvEditorFrame(A);
            if (frI) await writeImage(frI);
        }
        await sleep(500);
        await clickEditor(A);
        await ctrl(A, 'End');
        await sleep(300);
        const ccPreImg = await cvCharCount(A);
        await ctrl(A, 'v');
        await sleep(16000);
        const cc4 = await cvCharCount(A);
        check('A image paste: no text change (|delta| <= 2)', Math.abs(cc4 - ccPreImg) <= 2, 'delta=' + (cc4 - ccPreImg));
        const ccAfinal = cc4;
        await snap(A, 'A_after_all_edits');
        log('  A final: ' + ccAfinal + ' chars');

        // Save via the tester Save button (rotates the /shared-file checkpoint).
        check('A: tester Save button clicked', await clickSave(A));
        log('  [A] Save clicked — waiting for checkpoint rotation...');
        await sleep(10000);

        // ═══ Phase B: late join ═══
        log('\n=== Phase B: late join ===');
        ctxB = await browser.createBrowserContext();
        const B = await ctxB.newPage();
        await joinViaContentViewer(browser, openA.joinLink, {
            page: B, userName: 'CopyPaste Bob', iframeTimeout: 90000,
        });
        check('B: editor interactive', await waitCvInteractive(B, LOAD_BUDGET));
        await sleep(6000);

        let ccB = await settleCc(B, cc => Math.abs(cc - ccAfinal) <= 5, CONVERGE_BUDGET);
        await snap(B, 'B_after_join');
        log('  B after join: ' + ccB + ' chars (A had ' + ccAfinal + ')');
        check('B catches up to A (within ±5)', Math.abs(ccB - ccAfinal) <= 5,
            'B=' + ccB + ' A=' + ccAfinal + ' diff=' + Math.abs(ccB - ccAfinal));

        // B types "EXTRA" to prove co-edit works post-join.
        await clickEditor(B);
        await ctrl(B, 'End');
        await sleep(500);
        await B.keyboard.type('EXTRA', { delay: 80 });
        const ccBafter = await settleCc(B, cc => cc - ccB === 5, CONVERGE_BUDGET);
        check('B typed +5', ccBafter - ccB === 5, 'delta=' + (ccBafter - ccB));

        // A must see B's edit.
        const ccAend = await settleCc(A, cc => Math.abs(cc - ccAfinal - 5) <= 2, CONVERGE_BUDGET);
        check('A sees B edit (A grew by ~5)', Math.abs(ccAend - ccAfinal - 5) <= 2,
            'A=' + ccAend + ' expected~' + (ccAfinal + 5));

        await snap(A, 'A_final');
        await snap(B, 'B_final');
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        if (ctxB) { try { await ctxB.close(); } catch (e) {} }
        try { await browser.close(); } catch (e) {}
    }
    log('\n' + (allPassed ? 'ALL PASS' : 'SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
