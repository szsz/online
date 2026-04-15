const __cl = require('./lib/inject-checklist');
// Regression test: selecting a word in one browser and pressing Delete must
// propagate the deletion to the other browser.
//
// User-reported bug: in browser A, double-click a word to select it, then
// press Delete. Browser A removes the word; browser B still shows the word
// (the deletion never propagates).
//
// Method: open the same document in two browsers via the relay, position A
// at end of "Hello World", select the previous word ("World") with
// .uno:WordLeftSel, then dispatch .uno:Delete. Wait, then assert both
// browsers show 6 chars ("Hello ") not 11.
const puppeteer = require('puppeteer');
const fs = require('fs');
const env = require('./lib/test-env');

const BASE = env.EDITOR_URL;
const RELAY_BASE = env.RELAY_URL;
const TIMEOUT = 300000;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-select-delete';

const sleep = ms => new Promise(r => setTimeout(r, ms));
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

async function getStatus(page) {
    return page.evaluate(() => {
        const el = document.querySelector('#StateWordCount');
        return el ? el.textContent.trim() : '';
    });
}
// charCount reads the number from "N words, M characters" — but COOL also
// formats it as "Selected: N words, M characters" when a selection exists,
// in which case M is the SELECTION size, not the doc size. Caller is
// responsible for ensuring no selection before relying on the value.
function charCount(status) {
    const m = status && status.match(/(\d+) characters/);
    return m ? parseInt(m[1]) : -1;
}
function isSelectionStatus(status) {
    return /^Selected:/i.test((status || '').trim());
}
// Dispatch a Right-arrow keydown so any active selection collapses to
// the caret. Arrow keys without modifier always deselect in writer.
async function clearSelection(page) {
    // COOL key code for plain ArrowRight (no modifier). Verified against
    // the writer's keyboard handler — same shape as the End key (9221) used
    // in test-cursor-debug.js.
    await page.evaluate(() => {
        TheFakeWebSocket.send('key type=input char=0 key=1027');
        TheFakeWebSocket.send('key type=up    char=0 key=1027');
    });
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
    log('=== Regression: select-word + Delete must propagate to peer ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    try {
        // Upload "Hello World" — 11 chars, two words separated by a space.
        const up = await browser.newPage();
        await up.goto(BASE, { waitUntil: 'domcontentloaded' });
        await up.evaluate(async (base) => {
            await fetch(base + '/wasm/seldel.txt', {
                method: 'POST',
                body: new Blob(['Hello World'], { type: 'application/octet-stream' }),
            });
        }, BASE);
        await up.close();
        log('Uploaded "Hello World" (11 chars)');

        const ROOM = 'seldel-' + Date.now();
        const relay = encodeURIComponent(`${RELAY_BASE}/room/${ROOM}`);
        const coolUrl = `${BASE}/browser/cool.html?WOPISrc=seldel.txt&relay=${relay}&access_token=test`;

        async function openDoc(label) {
            const ctx = await browser.createBrowserContext();
            const page = await ctx.newPage();
            await page.goto(coolUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
            await page.waitForFunction(() =>
                document.querySelector('#StateWordCount')?.textContent?.includes('characters'),
                { timeout: TIMEOUT });
            log(`[${label}] Loaded: "${await getStatus(page)}"`);
            return page;
        }

        const pageA = await openDoc('A');
        await sleep(8000);   // settle, save initial checkpoint
        const pageB = await openDoc('B');
        await sleep(15000);  // B late-joins, replays log

        await snap(pageA, 'A_initial');
        await snap(pageB, 'B_initial');
        const initA = charCount(await getStatus(pageA));
        const initB = charCount(await getStatus(pageB));
        log(`Initial: A=${initA} B=${initB}`);
        check('Both browsers see "Hello World" (11 chars)',
              initA === 11 && initB === 11);

        // ── A: select a word by DOUBLE-CLICK (the real user path) ───
        // COOL canvas coordinates are in twips (1/15 mm). "Hello World" is
        // at the start of an empty doc — top-left of the page area. We
        // double-click somewhere on "World"; the exact x/y need only land
        // inside the word's bounding box. Twips give us a forgiving range:
        // page margin + a few words sits around (2000, 500).
        log('\n--- A: double-click "World" to select, then press Delete ---');
        await pageA.evaluate(() => {
            // Double-click = two buttondown/up at count=2
            TheFakeWebSocket.send('mouse type=buttondown x=2000 y=500 count=2 buttons=1 modifier=0');
            TheFakeWebSocket.send('mouse type=buttonup   x=2000 y=500 count=2 buttons=1 modifier=0');
        });
        await sleep(2000);
        await snap(pageA, 'A_after_doubleclick');
        await snap(pageB, 'B_after_doubleclick');

        // Dispatch Delete via the SAME path a real keyboard event takes:
        // _onKeyDown sends `key type=input char=0 key=<UNOKey.DELETE=1286>`.
        await pageA.evaluate(() => {
            TheFakeWebSocket.send('key type=input char=0 key=1286');
            TheFakeWebSocket.send('key type=up    char=0 key=1286');
        });
        log('A: pressed Delete');

        // Let the edit propagate, then deselect on BOTH browsers so the
        // status bar shows doc-char-count, not selection-char-count.
        log('Waiting 8s for the delete to propagate to B...');
        await sleep(8000);
        await snap(pageA, 'A_after_delete');
        await snap(pageB, 'B_after_delete');
        const sAraw = await getStatus(pageA);
        const sBraw = await getStatus(pageB);
        log(`Status (with selection possibly active): A="${sAraw}"  B="${sBraw}"`);

        await clearSelection(pageA);
        await clearSelection(pageB);
        await snap(pageA, 'A_after_deselect');
        await snap(pageB, 'B_after_deselect');
        const sA = await getStatus(pageA);
        const sB = await getStatus(pageB);
        log(`Status (after deselect): A="${sA}"  B="${sB}"`);
        const finalA = charCount(sA);
        const finalB = charCount(sB);

        check('A status no longer reports a selection', !isSelectionStatus(sA), sA);
        check('B status no longer reports a selection', !isSelectionStatus(sB), sB);

        // Doc started at 11, A deleted "World" (5 chars). Expected final is 6
        // ("Hello "). B MUST converge to the same value as A — that's the
        // co-edit invariant the bug breaks.
        const target = 6;
        check('A reflects the deletion locally (6 chars left)',
              finalA === target,
              'expected ' + target + ' got ' + finalA);
        check('B reflects A\'s select+delete (THIS is the user-reported bug)',
              finalB === target,
              'expected ' + target + ' got ' + finalB +
              (finalB === 11 ? ' — peer never saw the deletion' : ''));
        check('A and B converge to the same character count',
              finalA === finalB && finalA > 0,
              'A=' + finalA + ' B=' + finalB);

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
