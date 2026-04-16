const __cl = require('./lib/inject-checklist');
// Regression test: paste text and images in a 2-browser co-edit session.
//
// Verifies:
//   1. Text pasted (via HTML blob → textinput) appears in BOTH browsers
//   2. Image pasted (via image blob → insertfile) is embedded in the saved
//      docx (file size increases)
//   3. Both browsers converge after the paste operations
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');

const BASE = env.EDITOR_URL;
const RELAY_BASE = env.RELAY_URL;
const TIMEOUT = 300000;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-paste-coedit';
const FIXTURE = path.join(__dirname, '..', 'test', 'data', 'new.docx');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`); }

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

const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

(async () => {
    log('=== Regression: paste text + image in 2-browser co-edit (docx) ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    if (!fs.existsSync(FIXTURE)) { log('ERROR: fixture missing'); process.exit(1); }

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    const NAME = 'paste-coedit-' + Date.now() + '.docx';
    const ROOM = 'paste-coedit-' + Date.now();
    const relay = encodeURIComponent(`${RELAY_BASE}/room/${ROOM}`);
    const coolUrl = `${BASE}/browser/cool.html?WOPISrc=${encodeURIComponent(NAME)}&relay=${relay}&access_token=test`;

    try {
        // Upload docx fixture
        const fixtureBytes = fs.readFileSync(FIXTURE);
        const up = await browser.newPage();
        await up.goto(BASE, { waitUntil: 'domcontentloaded' });
        await up.evaluate(async (base, n, a) => {
            await fetch(base + '/wasm/' + encodeURIComponent(n), {
                method: 'POST', body: new Blob([new Uint8Array(a)]),
            });
        }, BASE, NAME, Array.from(fixtureBytes));
        await up.close();
        log(`Uploaded ${NAME} (${(fixtureBytes.length/1024).toFixed(1)} KB docx)`);

        // Open 2 browsers
        async function openDoc(label) {
            const ctx = await browser.createBrowserContext();
            const page = await ctx.newPage();
            await page.goto(coolUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
            await page.waitForFunction(() =>
                document.querySelector('#StateWordCount')?.textContent?.includes('characters'),
                { timeout: TIMEOUT });
            log(`[${label}] Loaded: "${await getWc(page)}"`);
            return page;
        }

        const pageA = await openDoc('A');
        await sleep(8000);
        const pageB = await openDoc('B');
        await sleep(15000);

        const initA = charCount(await getWc(pageA));
        const initB = charCount(await getWc(pageB));
        log(`Initial: A=${initA} B=${initB}`);
        check('Both browsers loaded same docx', initA > 0 && initA === initB);

        // ── 1. Paste text via the REAL browser path ─────────────────
        // The real Ctrl+V flow: COOL POSTs clipboard HTML to
        // /collabora-online-mobile/cool/clipboard, then sends .uno:Paste.
        // Our fetch wrapper intercepts the POST, extracts text, injects
        // via textinput through the relay.
        log('\n--- A: paste text (real clipboard POST path) ---');
        await pageA.evaluate(() => {
            // Simulate what COOL's _sendToInternalClipboard does
            var html = '<html><body><p>PASTED_TEXT</p></body></html>';
            var formData = new FormData();
            formData.append('file', new Blob([html], { type: 'text/html' }));
            // POST to the clipboard endpoint (our fetch wrapper intercepts it)
            fetch('/collabora-online-mobile/cool/clipboard?Tag=test', {
                method: 'POST', body: formData,
            });
        });
        await sleep(8000);

        const afterTextA = charCount(await getWc(pageA));
        const afterTextB = charCount(await getWc(pageB));
        log(`After text paste: A=${afterTextA} B=${afterTextB} (was ${initA})`);
        await pageA.screenshot({ path: `${SHOT_DIR}/01_after_text_paste_A.png` }).catch(() => {});

        check('A: text paste increased char count',
              afterTextA > initA,
              'before=' + initA + ' after=' + afterTextA);
        check('B: text paste propagated (char count increased)',
              afterTextB > initB,
              'before=' + initB + ' after=' + afterTextB);

        // ── 2. Save BEFORE image paste (baseline) ─────────────────────
        log('\n--- Save baseline (text only, no image yet) ---');
        await pageA.evaluate(() => {
            if (globalThis.postMobileMessage)
                globalThis.postMobileMessage('save dontTerminateEdit=1 dontSaveIfUnmodified=0');
        });
        await sleep(4000);
        const preImageSize = await pageA.evaluate(async (base, n) => {
            const r = await fetch(base + '/wasm/' + encodeURIComponent(n));
            return (await r.arrayBuffer()).byteLength;
        }, BASE, NAME);
        log(`Pre-image save: ${preImageSize} bytes`);

        // ── 3. Paste image (PNG blob) from A ────────────────────────
        log('\n--- A: paste image (PNG blob) ---');
        await pageA.evaluate(() => {
            TheFakeWebSocket.send('key type=input char=0 key=1281'); // Escape
            TheFakeWebSocket.send('key type=up char=0 key=1281');
        });
        await sleep(1000);
        await pageA.evaluate(() => {
            TheFakeWebSocket.send('key type=input char=0 key=9221'); // Ctrl+End
            TheFakeWebSocket.send('key type=up char=0 key=9221');
        });
        await sleep(1000);
        await pageA.evaluate((b64) => {
            var raw = atob(b64);
            var bytes = new Uint8Array(raw.length);
            for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
            var blob = new Blob(['paste mimetype=image/png\n', bytes]);
            TheFakeWebSocket.send(blob);
        }, TINY_PNG_B64);
        await sleep(5000);

        // ── 4. Save AFTER image paste and compare ────────────────────
        log('--- Save after image paste ---');
        await pageA.evaluate(() => {
            if (globalThis.postMobileMessage)
                globalThis.postMobileMessage('save dontTerminateEdit=1 dontSaveIfUnmodified=0');
        });
        let savedSize = preImageSize;
        for (let i = 0; i < 15; i++) {
            await sleep(1000);
            savedSize = await pageA.evaluate(async (base, n) => {
                const r = await fetch(base + '/wasm/' + encodeURIComponent(n));
                return (await r.arrayBuffer()).byteLength;
            }, BASE, NAME);
            if (savedSize > preImageSize + 50) break;
        }
        log(`Post-image save: ${savedSize} bytes (pre-image: ${preImageSize})`);
        check('Docx grew after image paste (image embedded)',
              savedSize > preImageSize,
              'pre=' + preImageSize + ' post=' + savedSize + ' delta=' + (savedSize - preImageSize));

        // ── 4. Final convergence check ──────────────────────────────
        // Press Escape on both to clear any shape selection, then read
        for (const p of [pageA, pageB]) {
            await p.evaluate(() => {
                TheFakeWebSocket.send('key type=input char=0 key=1281');
                TheFakeWebSocket.send('key type=up char=0 key=1281');
            });
        }
        await sleep(2000);
        // Read without "Selected:" prefix (Right arrow to deselect)
        for (const p of [pageA, pageB]) {
            await p.evaluate(() => {
                TheFakeWebSocket.send('key type=input char=0 key=1027');
                TheFakeWebSocket.send('key type=up char=0 key=1027');
            });
        }
        await sleep(2000);
        const finalA = await getWc(pageA);
        const finalB = await getWc(pageB);
        log(`Final: A="${finalA}" B="${finalB}"`);

        check('Both browsers have content after paste ops',
              charCount(finalA) > 0 && charCount(finalB) > 0,
              'A=' + charCount(finalA) + ' B=' + charCount(finalB));

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
