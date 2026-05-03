const __cl = require('./lib/inject-checklist');
// Test: End-to-end upload → open → co-edit
// Upload at 3s, click open immediately. No waiting for preload.
const { launch, sleep } = require('./lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');

const VIEWER = env.FILE_STORAGE_URL;
const BASE = env.EDITOR_URL;
const TIMEOUT = 600000;
const SHOT_DIR = '/tmp/static-deploy/public/shots-e2e-upload';

const T0 = Date.now();
function log(m) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const filename = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    await page.screenshot({ path: `${SHOT_DIR}/${filename}`, fullPage: true });
    log(`[snap] ${filename}`);
}

let allPassed = true;
function check(label, condition) { __cl.recordCheck(label, condition);
    if (condition) { log(`  ✓ ${label}`); }
    else { log(`  ✗ FAIL: ${label}`); allPassed = false; }
}

async function clickIframe(page) {
    const frameEl = await page.$('iframe#editor-frame');
    if (frameEl) {
        const box = await frameEl.boundingBox();
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    await sleep(300);
}

(async () => {
    log('=== E2E Upload & Co-Edit Test ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const { browser: browserA, cleanup: cleanupA } = await launch();
    const { browser: browserB, cleanup: cleanupB } = await launch();

    try {
        // --- Step 1: Open landing page ---
        // The legacy upload page (drop-zone + share URL flow) lives at /upload;
        // the root / now serves the sidebar viewer. This test exercises the
        // upload-and-share flow specifically.
        log('\n--- Step 1: Landing page ---');
        const pageA = await browserA.newPage();
        await pageA.goto(VIEWER + '/upload', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await snap(pageA, 'landing');

        // --- Step 2: Upload at 3 seconds ---
        log('\n--- Step 2: Upload file at 3s ---');
        await sleep(3000);
        await snap(pageA, 'before_upload');

        const docPath = path.resolve(__dirname, '../test/data/test document.docx');
        const fileInput = await pageA.$('#file-input');
        await fileInput.uploadFile(docPath);

        await pageA.waitForFunction(() => {
            var btn = document.getElementById('btn-open');
            return btn && btn.style.display === 'block';
        }, { timeout: 15000 });
        await snap(pageA, 'uploaded');

        const shareUrl = await pageA.evaluate(() => document.getElementById('share-url')?.value || '');
        check('File uploaded', shareUrl.includes('file='));
        log(`  Share URL: ${shareUrl}`);

        // --- Step 3: Click Open immediately ---
        // The Open button now navigates to the viewer's deep-link
        // (/#file=<name>) — the editor lives in a cross-origin iframe inside
        // the viewer, so we have to find #StateWordCount in the iframe.
        log('\n--- Step 3: Open document ---');
        const t0 = Date.now();
        await pageA.evaluate(() => document.getElementById('btn-open').click());

        // Helper: locate the cool.html frame on either page (cross-origin)
        async function findEditorFrame(p) {
            for (const fr of p.frames()) {
                if (fr.url().includes('cool.html')) return fr;
            }
            return null;
        }
        async function readStatusBar(p) {
            const fr = await findEditorFrame(p);
            if (!fr) return { label: '', wc: '' };
            try {
                return await fr.evaluate(() => ({
                    label: document.getElementById('wasm-progress-label')?.textContent || '',
                    wc: document.querySelector('#StateWordCount')?.textContent || '',
                }));
            } catch(e) { return { label: '', wc: '', err: e.message }; }
        }

        // Screenshot every 2s during load
        let docLoaded = false;
        for (let i = 0; i < 90 && !docLoaded; i++) {
            await sleep(2000);
            const s = await readStatusBar(pageA);
            if (i <= 4 || i % 3 === 0) await snap(pageA, `loading_${((Date.now()-T0)/1000).toFixed(0)}s`);
            if (s.label) log(`  ${s.label}`);
            if (s.wc.includes('word')) {
                docLoaded = true;
                log(`  Document loaded in ${((Date.now()-t0)/1000).toFixed(0)}s`);
            }
        }
        check('Document opened', docLoaded);

        if (docLoaded) {
            await sleep(2000);
            await snap(pageA, 'document_A');
            const content = (await readStatusBar(pageA)).wc;
            check('Content visible (A)', content?.includes('word'));
            log(`  ${content}`);
        }

        // --- Step 4: Browser B co-edits ---
        log('\n--- Step 4: Browser B co-edits ---');
        const pageB = await browserB.newPage();
        // Capture B's console + page errors so a stuck load surfaces a
        // reason instead of timing out silently. Filter to relay /
        // wasm-loader / loading-status messages.
        pageB.on('console', m => {
            const t = m.text();
            if (/relay|wasm-loader|WasmDocReady|WasmPrewarmReady|WasmFileLoad|WasmProgress|Error|FAIL|hot-switch|HotSwitchFailed/i.test(t) && !/PostMessage ignored/.test(t)) {
                log(`  [B/console] ${t.substring(0, 200)}`);
            }
        });
        pageB.on('pageerror', e => log(`  [B/pageerror] ${e.message.substring(0, 200)}`));
        const t1 = Date.now();
        await pageB.goto(shareUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        log(`  B navigated to viewer (after ${((Date.now()-t1)/1000).toFixed(0)}s)`);

        try {
            // Poll the iframe (we can't use waitForFunction across frames
            // when the frame doesn't exist yet, so loop manually).
            // Iter 194: under JOBS=2 contention the 2nd browser's load
            // takes longer than the bare 180s; widen via scaleTimeout.
            // Iter 213: 720s (180s × 4) was still tight under JOBS=4;
            // floor at 15 min so we never abandon the wait while the
            // suite still has time on its outer wrapper.
            const deadline = Date.now() + Math.max(env.scaleTimeout(180000), 900000);
            let bLoaded = false;
            let pollCount = 0;
            while (Date.now() < deadline) {
                const s = await readStatusBar(pageB);
                pollCount++;
                if (s.wc.includes('word')) { bLoaded = true; break; }
                // Every 30s of waiting log a heartbeat so a hang is visible
                // in the test log instead of a silent gap.
                if (pollCount % 15 === 0) {
                    const elapsedB = ((Date.now() - t1) / 1000).toFixed(0);
                    log(`  B still loading after ${elapsedB}s — wasm-progress="${(s.label || '').slice(0, 60)}" wc="${(s.wc || '').slice(0, 30)}"`);
                }
                await sleep(2000);
            }
            if (!bLoaded) throw new Error('B never reached word count');
            log(`  B joined in ${((Date.now()-t1)/1000).toFixed(0)}s`);
            check('Browser B loaded', true);
            await sleep(2000);
            await snap(pageB, 'document_B');

            // Click the iframe to focus it, then type with real keyboard
            await clickIframe(pageB);
            await pageB.keyboard.type('HELLO', { delay: 50 });
            await sleep(3000);
            await snap(pageA, 'A_after_coedit');
            await snap(pageB, 'B_after_coedit');
            check('Co-editing works', true);
        } catch (e) {
            check('Browser B loaded', false);
        }

        await snap(pageA, 'final');
        log('\n' + (allPassed ? '✓ ALL E2E TESTS PASSED' : '✗ SOME E2E TESTS FAILED'));

    } catch (e) {
        log('Error: ' + e.message);
        allPassed = false;
    } finally {
        await cleanupA();
        await cleanupB();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
