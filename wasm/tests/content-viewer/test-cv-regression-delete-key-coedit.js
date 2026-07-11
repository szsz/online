// test-cv-regression-delete-key-coedit.js — Delete-key edits in browser A
// must reach browser B, through the Tresorit content viewer.
//
// User-reported bug: pressing Delete in one browser does not propagate to the
// other browser. The Delete key generates a `removetextcontext` message (not
// a `key`); the relay-adapter must recognize it as user-input and forward it
// to peers.
//
//   A + B open "Hello World" (11 chars) in a CV co-edit room
//   A moves the caret to "Hello |World" and presses Delete → removes 'W'
//   B must drop to 10 chars; A and B converge
//
// ALL input via real keyboard/mouse.
//
// Migrated from wasm/tests/regression/test-regression-delete-key-coedit.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-delete-key-coedit.js [base-url]

'use strict';

const fs = require('fs');
const { launch, sleep } = require('../../lib/browser');
const {
    openCoEditPair, cvEditorFrame, waitCvCharCount,
} = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const SHOT_DIR = '/tmp/content-viewer-report/regression-delete-key';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const VP = { width: 1280, height: 900 };

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
    await sleep(300);
    try { await page.screenshot({ path: `${SHOT_DIR}/${String(++shotNum).padStart(2, '0')}_${name}.png` }); } catch (e) {}
}

async function getStatus(page) {
    const fr = cvEditorFrame(page);
    if (!fr) return '';
    return fr.evaluate(() => document.querySelector('#StateWordCount')?.textContent?.trim() || '').catch(() => '');
}
function charCount(status) { const m = status && status.match(/(\d+) characters/); return m ? parseInt(m[1]) : -1; }
async function waitForCharCount(page, expected, timeoutMs) {
    return (await waitCvCharCount(page, c => c === expected, timeoutMs)) === expected;
}
async function clickCanvas(page) {
    const el = await page.$('iframe');
    const box = el && await el.boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(500);
}

(async () => {
    log('=== CV regression: Delete key must propagate via relay ===');
    log('viewer: ' + BASE);
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    const { browser } = await launch({ headless: 'new' });
    let ctxB = null;
    try {
        const docName = 'cv-delkey-' + Date.now() + '.txt';
        const bytes = Buffer.from('Hello World', 'utf8'); // 11 chars

        const pair = await openCoEditPair(browser, BASE, docName, bytes, {
            userA: 'Alice DelKey', userB: 'Bob DelKey', viewport: VP, loadBudgetMs: LOAD_BUDGET,
        });
        const pageA = pair.A.page; const pageB = pair.B.page; ctxB = pair.contextB;
        await waitForCharCount(pageA, 11, LOAD_BUDGET);
        await waitForCharCount(pageB, 11, LOAD_BUDGET);
        await sleep(15000);

        await snap(pageA, 'A_initial'); await snap(pageB, 'B_initial');
        const initA = charCount(await getStatus(pageA));
        const initB = charCount(await getStatus(pageB));
        log(`Initial: A=${initA} B=${initB}`);
        check('Both browsers see "Hello World" (11 chars)', initA === 11 && initB === 11);

        // ── A: position cursor at position 6 and press Delete ──
        // Ctrl+Home moves to start, then Right x6 puts caret at "Hello |World".
        // Delete removes the 'W'.
        log('--- A: move cursor to position 6, press Delete ---');
        await pageA.bringToFront().catch(() => {});
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('Home'); await pageA.keyboard.up('Control');
        await sleep(800);
        for (let i = 0; i < 6; i++) { await pageA.keyboard.press('ArrowRight'); await sleep(120); }
        await sleep(800);
        await snap(pageA, 'A_at_position_6');

        await pageA.keyboard.press('Delete');
        log('A: pressed Delete key');

        // ── Wait for the delete to propagate to B ──
        const target = 10;
        log(`Waiting for B to drop to ${target} chars...`);
        const okB = await waitForCharCount(pageB, target, 30000);
        const okA = await waitForCharCount(pageA, target, 30000);
        await snap(pageA, 'A_after_delete'); await snap(pageB, 'B_after_delete');
        const finalA = charCount(await getStatus(pageA));
        const finalB = charCount(await getStatus(pageB));
        log(`Final: A=${finalA} (reached=${okA}), B=${finalB} (reached=${okB})`);

        check('A reflects the deletion locally (10 chars left)',
            finalA === target, 'expected ' + target + ' got ' + finalA);
        check('B reflects A\'s Delete-key edit (THE bug — removetextcontext must forward)',
            finalB === target,
            'expected ' + target + ' got ' + finalB +
            (finalB === 11 ? ' — peer never saw the deletion (removetextcontext bypassed the relay)' : ''));
        check('A and B converge to the same character count',
            finalA === finalB && finalA > 0, 'A=' + finalA + ' B=' + finalB);
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        if (ctxB) { try { await ctxB.close(); } catch (e) {} }
        try { await browser.close(); } catch (e) {}
    }
    log('\n' + (allPassed ? 'ALL PASS' : 'SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
