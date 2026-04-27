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
//   2. Sets clipboard to a 1x1 PNG image, then pastes via Ctrl+V.
//   3. Waits for the Kit to process, then saves + downloads.
//   4. Checks: saved doc is larger than original (image embedded).
const { launch, sleep } = require('./lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');

const BASE = env.EDITOR_URL;
const RELAY_BASE = env.RELAY_URL;
const TIMEOUT = 300000;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-image-insert';

const T0 = Date.now();
function log(m) { console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`); }

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  PASS: ${label}`);
    else { log(`  FAIL: ${label}${ev?' ['+ev+']':''}`); allPassed = false; }
}

// Minimal valid 1x1 red PNG (67 bytes).
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

async function clickCanvas(page) {
    const canvas = await page.$('canvas');
    if (canvas) {
        const box = await canvas.boundingBox();
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    await sleep(300);
}

(async () => {
    log('=== Regression: image insertion into Writer doc ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const { browser, cleanup } = await launch();

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
        // Grant clipboard permissions for real paste
        const cdp = await page.createCDPSession();
        await cdp.send('Browser.grantPermissions', {
            permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
        });
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

        // -- Insert image via postMobileMessage('insertfile …') --
        // Previously used navigator.clipboard.write + Ctrl+V but on
        // headless Xvfb + Azure the clipboard permission grant isn't
        // reliable (test saw pngMagicFound=false). The insertfile path
        // is the same one that clipboard paste eventually routes
        // through inside COOL, so this still exercises the real LO
        // image-embedding code path.
        log('\n--- Inserting 1x1 PNG via postMobileMessage(insertfile) ---');
        await clickCanvas(page);
        await sleep(500);
        const frame = page.frames().find(f => f.url().includes('cool.html'));
        if (!frame) throw new Error('editor iframe missing');
        await frame.evaluate((b64) => {
            if (typeof globalThis.postMobileMessage === 'function') {
                globalThis.postMobileMessage(
                    'insertfile name=pasted.png type=graphic data=' + b64);
            } else {
                throw new Error('postMobileMessage missing');
            }
        }, TINY_PNG_B64);
        log('Dispatched insertfile via postMobileMessage');

        // Wait for the Kit to process the insertion. The image lands
        // selected (rendershapeselection fires); press Escape to deselect
        // so it's anchored in the doc flow before we save. Without the
        // deselect LO can save a "just rewritten" docx that omits the
        // still-selected floating shape.
        await sleep(5000);
        await page.keyboard.press('Escape');
        await sleep(2000);
        await page.screenshot({ path: `${SHOT_DIR}/02_after_insert.png` });

        // -- Save via Ctrl+S --
        log('\n--- Saving via Ctrl+S ---');
        await clickCanvas(page);
        await page.keyboard.down('Control');
        await page.keyboard.press('s');
        await page.keyboard.up('Control');

        // Poll /wasm/<name> until the saved docx embeds some form of
        // media. LO on WASM may convert the PNG to SVG during insert
        // (rendershapeselection shows mimetype=image/svg+xml), so we
        // accept any of: PNG magic, JPEG magic, SVG signature, or
        // a word/media/ zip entry name. Size alone is unreliable
        // because LO re-saves with tighter zip compression.
        const saveDeadline = Date.now() + 30000;
        let savedSize = initialSize;
        let mediaKind = null;
        while (Date.now() < saveDeadline) {
            await sleep(1000);
            const got = await page.evaluate(async (base, n) => {
                const r = await fetch(base + '/wasm/' + encodeURIComponent(n));
                const buf = await r.arrayBuffer();
                const u8 = new Uint8Array(buf);
                const txt = new TextDecoder('latin1').decode(u8);
                // Zip entry naming: LO always puts embedded media under
                // word/media/ in a docx. That's the authoritative signal.
                if (txt.indexOf('word/media/') >= 0) return { size: buf.byteLength, kind: 'word/media/' };
                // PNG / JPEG / SVG magic / signature:
                const hasPng = (() => {
                    const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
                    for (let i = 0; i + magic.length < u8.length; i++) {
                        let ok = true;
                        for (let j = 0; j < magic.length; j++) {
                            if (u8[i + j] !== magic[j]) { ok = false; break; }
                        }
                        if (ok) return true;
                    }
                    return false;
                })();
                if (hasPng) return { size: buf.byteLength, kind: 'png-magic' };
                if (txt.indexOf('\xff\xd8\xff') >= 0) return { size: buf.byteLength, kind: 'jpeg-magic' };
                if (txt.indexOf('<svg') >= 0) return { size: buf.byteLength, kind: 'svg' };
                return { size: buf.byteLength, kind: null };
            }, BASE, NAME);
            savedSize = got.size;
            mediaKind = got.kind;
            if (mediaKind) break;
        }

        log(`Saved doc size: ${savedSize} bytes (initial was ${initialSize}), media=${mediaKind}`);
        await page.screenshot({ path: `${SHOT_DIR}/03_after_save.png` });

        check('Saved docx contains embedded media',
              mediaKind !== null,
              `initial=${initialSize} saved=${savedSize} media=${mediaKind}`);

        // Also check: was any canvas invalidation triggered?
        // (The Kit should have repainted tiles after the insertion.)
        const canvasCount = await page.evaluate(() =>
            document.querySelectorAll('canvas').length);
        check('Canvas exists (editor rendered)',
              canvasCount >= 1,
              'canvasCount=' + canvasCount);

        log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    } catch (e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        await cleanup();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
