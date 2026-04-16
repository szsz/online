const __cl = require('./lib/inject-checklist');
// Regression test: inserting an image into a Writer document.
//
// In WASM mode (ThisIsTheEmscriptenApp), COOL's Map.FileInserter uses
// the mobile path: reads the file, base64-encodes it, and sends
//   postMobileMessage('insertfile name=<n> type=graphic data=<base64>')
// to the Kit. If this works, the Kit embeds the image and the saved
// document is larger than the original.
//
// This test:
//   1. Opens a minimal Writer doc (Hello World, ~9 KB).
//   2. Dispatches `insertfile` with a tiny 1×1 red PNG via
//      postMobileMessage (the same path the real UI would use).
//   3. Waits for the Kit to process, then saves + downloads.
//   4. Checks: saved doc is larger than original (image embedded).
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');

const BASE = env.EDITOR_URL;
const RELAY_BASE = env.RELAY_URL;
const TIMEOUT = 300000;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-image-insert';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`); }

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}${ev?' ['+ev+']':''}`); allPassed = false; }
}

// Minimal valid 1×1 red PNG (67 bytes).
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

(async () => {
    log('=== Regression: image insertion into Writer doc ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    const NAME = 'imgtest-' + Date.now() + '.docx';
    const FIXTURE = path.join(__dirname, '..', 'test', 'data', 'new.docx');

    try {
        // Upload a real .docx (which can embed images, unlike .txt)
        if (!fs.existsSync(FIXTURE)) { log('ERROR: fixture missing: ' + FIXTURE); process.exit(1); }
        const fixtureBytes = fs.readFileSync(FIXTURE);
        const up = await browser.newPage();
        await up.goto(BASE, { waitUntil: 'domcontentloaded' });
        await up.evaluate(async (base, n, a) => {
            await fetch(base + '/wasm/' + encodeURIComponent(n), {
                method: 'POST', body: new Blob([new Uint8Array(a)]),
            });
        }, BASE, NAME, Array.from(fixtureBytes));
        await up.close();
        log(`Uploaded ${NAME} (${(fixtureBytes.length/1024).toFixed(1)} KB .docx)`);

        const ROOM = 'imgtest-' + Date.now();
        const relay = encodeURIComponent(`${RELAY_BASE}/room/${ROOM}`);
        const coolUrl = `${BASE}/browser/cool.html?WOPISrc=${encodeURIComponent(NAME)}&relay=${relay}&access_token=test`;

        const page = await browser.newPage();
        page.on('console', m => {
            if (/insertfile|image|graphic|mobile/i.test(m.text()))
                log(`[console] ${m.text().substring(0, 200)}`);
        });
        await page.goto(coolUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await page.waitForFunction(() =>
            document.querySelector('#StateWordCount')?.textContent?.includes('characters'),
            { timeout: TIMEOUT });
        log('Editor loaded');
        await sleep(5000);
        await page.screenshot({ path: `${SHOT_DIR}/01_before_insert.png` });

        // Get initial doc size via /wasm/<name>
        const initialSize = await page.evaluate(async (base, n) => {
            const r = await fetch(base + '/wasm/' + encodeURIComponent(n));
            const buf = await r.arrayBuffer();
            return buf.byteLength;
        }, BASE, NAME);
        log(`Initial doc size: ${initialSize} bytes`);

        // ── Insert image via postMobileMessage ──────────────────────
        log('\n--- Inserting 1×1 PNG via postMobileMessage ---');
        const inserted = await page.evaluate((b64) => {
            if (typeof globalThis.postMobileMessage !== 'function') {
                return { error: 'postMobileMessage not available' };
            }
            try {
                globalThis.postMobileMessage(
                    'insertfile name=test-image.png type=graphic data=' + b64);
                return { ok: true };
            } catch (e) {
                return { error: e.message };
            }
        }, TINY_PNG_B64);
        log(`insertfile result: ${JSON.stringify(inserted)}`);
        check('postMobileMessage is available', !inserted.error, inserted.error);

        // Wait for the Kit to process the insertion
        await sleep(5000);
        await page.screenshot({ path: `${SHOT_DIR}/02_after_insert.png` });

        // ── Save and re-check size ──────────────────────────────────
        // The WASM build's C++ DocumentBroker rejects `uno .uno:Save`
        // (assertion: !message.starts_with("uno .uno:Save") unless
        // SaveGraphic). The correct save path in WASM is the `save`
        // command (lowercase, no uno: prefix), which is what the
        // relay-adapter's saveAndUploadCheckpoint uses.
        log('\n--- Saving via Kit save command ---');
        // The Kit's WOPI putFile handler writes the saved bytes back to
        // /wasm/<name> on the editor server. Give generous time — the
        // Kit does the LO save + serialization + HTTP PUT.
        await page.evaluate(() => {
            if (globalThis.postMobileMessage) {
                globalThis.postMobileMessage('save dontTerminateEdit=1 dontSaveIfUnmodified=0');
            }
        });
        // Poll /wasm/<name> until the file size changes or 15s passes.
        const saveDeadline = Date.now() + 15000;
        let savedSize = initialSize;
        while (Date.now() < saveDeadline) {
            await sleep(1000);
            savedSize = await page.evaluate(async (base, n) => {
                const r = await fetch(base + '/wasm/' + encodeURIComponent(n));
                const buf = await r.arrayBuffer();
                return buf.byteLength;
            }, BASE, NAME);
            if (savedSize > initialSize + 50) break;
        }

        log(`Saved doc size: ${savedSize} bytes (initial was ${initialSize})`);
        await page.screenshot({ path: `${SHOT_DIR}/03_after_save.png` });

        check('Doc size increased after image insertion',
              savedSize > initialSize + 50,
              `initial=${initialSize} saved=${savedSize} delta=${savedSize - initialSize}`);

        // Also check: was any canvas invalidation triggered?
        // (The Kit should have repainted tiles after the insertion.)
        const canvasCount = await page.evaluate(() =>
            document.querySelectorAll('canvas').length);
        check('Canvas exists (editor rendered)',
              canvasCount >= 1,
              'canvasCount=' + canvasCount);

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
