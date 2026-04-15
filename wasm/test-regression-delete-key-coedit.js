const __cl = require('./lib/inject-checklist');
// Regression test: Delete key edits in browser A must reach browser B.
//
// User-reported bug: pressing Delete in one browser does not propagate to
// the other browser.
//
// Mechanism: COOL's Map.Keyboard.js leaves Backspace and Delete to
// TextInput.js's beforeinput handler. TextInput sends:
//
//     removetextcontext id=<windowId> before=<N> after=<N>
//
// (note the typo — "removetextcontext" not "removetextcontent" — that's
// what the wire protocol actually uses; see TextInput.js _removeTextContent).
//
// The relay-adapter's interceptedSend filter recognizes these prefixes as
// user-input that must be relayed:
//   key   mouse   textinput   windowkey   uno
//
// `removetextcontext` is not in that list, so it falls into the "not user
// input" branch and is delivered straight to the local Kit via
// postMobileMessage — bypassing the relay entirely. Browser B never sees
// the delete.
//
// This test reproduces it via the on-the-wire message TextInput would
// produce, which is the same message a real Delete keypress generates.
const puppeteer = require('puppeteer');
const fs = require('fs');
const env = require('./lib/test-env');

const BASE = env.EDITOR_URL;
const RELAY_BASE = env.RELAY_URL;
const TIMEOUT = 300000;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-delete-key';

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
function charCount(status) {
    const m = status && status.match(/(\d+) characters/);
    return m ? parseInt(m[1]) : -1;
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
    log('=== Regression: Delete key must propagate via relay ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    try {
        // Upload "Hello World" — 11 chars.
        const up = await browser.newPage();
        await up.goto(BASE, { waitUntil: 'domcontentloaded' });
        await up.evaluate(async (base) => {
            await fetch(base + '/wasm/delkey.txt', {
                method: 'POST',
                body: new Blob(['Hello World'], { type: 'application/octet-stream' }),
            });
        }, BASE);
        await up.close();
        log('Uploaded "Hello World" (11 chars)');

        const ROOM = 'delkey-' + Date.now();
        const relay = encodeURIComponent(`${RELAY_BASE}/room/${ROOM}`);
        const coolUrl = `${BASE}/browser/cool.html?WOPISrc=delkey.txt&relay=${relay}&access_token=test`;

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
        await sleep(8000);                  // settle, initial save
        const pageB = await openDoc('B');
        await sleep(15000);                 // B late-joins, replays log

        await snap(pageA, 'A_initial');
        await snap(pageB, 'B_initial');
        const initA = charCount(await getStatus(pageA));
        const initB = charCount(await getStatus(pageB));
        log(`Initial: A=${initA} B=${initB}`);
        check('Both browsers see "Hello World" (11 chars)',
              initA === 11 && initB === 11);

        // ── A: position cursor at end and press Delete ─────────────
        // We dispatch the EXACT message TextInput.js produces for the
        // Delete key — `removetextcontext id=… before=0 after=N`. With
        // before=0 after=1, COOL deletes the character to the right of
        // the cursor. From end-of-doc this deletes nothing locally; we
        // first move the cursor somewhere mid-doc (between 'Hello ' and
        // 'World') so the next-char delete actually removes a 'W'.
        log('\n--- A: move cursor to position 6, press Delete ---');
        // GoToStartOfDoc then Right×6 puts cursor at "Hello |World".
        await pageA.evaluate(() => TheFakeWebSocket.send('uno .uno:GoToStartOfDoc'));
        await sleep(800);
        for (let i = 0; i < 6; i++) {
            await pageA.evaluate(() => {
                TheFakeWebSocket.send('key type=input char=0 key=1027');  // Right
                TheFakeWebSocket.send('key type=up    char=0 key=1027');
            });
            await sleep(120);
        }
        await sleep(800);
        await snap(pageA, 'A_at_position_6');

        // The Delete key — TextInput's removetextcontext message.
        // windowId is doc-window in writer; 0 works for our purposes
        // (we're not in a sub-window dialog).
        await pageA.evaluate(() => {
            TheFakeWebSocket.send('removetextcontext id=0 before=0 after=1');
        });
        log('A: dispatched removetextcontext (Delete key)');

        // ── Wait for the delete to propagate to B ───────────────────
        // Doc was 11 chars, deleting 1 → 10 chars on both sides.
        const target = 10;
        log(`Waiting for B to drop to ${target} chars...`);
        const tookB = await waitForCharCount(pageB, target, 30000);
        const tookA = await waitForCharCount(pageA, target, 30000);
        await snap(pageA, 'A_after_delete');
        await snap(pageB, 'B_after_delete');
        const finalA = charCount(await getStatus(pageA));
        const finalB = charCount(await getStatus(pageB));
        log(`Final: A=${finalA} (took ${tookA}ms), B=${finalB} (took ${tookB}ms)`);

        check('A reflects the deletion locally (10 chars left)',
              finalA === target,
              'expected ' + target + ' got ' + finalA);
        check('B reflects A\'s Delete-key edit (THE bug — currently fails)',
              finalB === target,
              'expected ' + target + ' got ' + finalB +
              (finalB === 11 ? ' — peer never saw the deletion (removetextcontext bypassed the relay)' : ''));
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
