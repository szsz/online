const __cl = require('./lib/inject-checklist');
// Late-join + copy/paste: Browser A types, copies, pastes (text + image),
// saves. Browser B late-joins and must receive all of A's content.
// ALL input via real keyboard/mouse.
const { launch, sleep } = require('./lib/browser');
const fs = require('fs'), path = require('path');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');
const { evalInFrame: _evalInFrame } = require('./lib/two-tab');
const VIEWER = env.FILE_STORAGE_URL;
const SHOTS = '/tmp/static-deploy/public/shots-latejoin-copypaste';

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) console.log(`  ✓ ${label}`);
    else { console.log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

function charCount(s) { const m = s && s.match(/(\d+) characters/); return m ? parseInt(m[1]) : -1; }

(async () => {
    fs.rmSync(SHOTS, { recursive: true, force: true });
    fs.mkdirSync(SHOTS, { recursive: true });

    const { browser, cleanup } = await launch();
    let stepNum = 0;
    async function snap(page, name) {
        stepNum++;
        const f = `${String(stepNum).padStart(2, '0')}_${name}.png`;
        await page.screenshot({ path: `${SHOTS}/${f}` });
    }

    try {
        // Upload fresh doc (v2 encrypted upload)
        const docName = 'ljcp-' + Date.now() + '.docx';
        const bytes = fs.readFileSync(path.join(__dirname, '..', 'test', 'data', 'new.docx'));
        const { b64urlSecret, fileId } = await uploadV2(VIEWER, docName, bytes);
        console.log('[setup] Uploaded v2 ' + docName + ' as ' + fileId.substring(0,8) + '…');

        // ═══ Browser A: type + paste + save ═══
        console.log('\n=== Phase A: type, copy, paste, save ===');
        const pageA = await browser.newPage();
        const cdpA = await pageA.createCDPSession();
        await cdpA.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
        await pageA.setViewport({ width: 1280, height: 900 });
        await pageA.goto(VIEWER + '/#file=' + b64urlSecret, { waitUntil: 'domcontentloaded' });

        // Wait for editor — require target fileId in frame URL so we
        // don't latch onto the prewarm blank frame (whose statusbar shows
        // template-text chars instead of the uploaded doc's content).
        // In v2, the WOPISrc is the fileId (the server never sees the
        // plaintext name).
        let frameA;
        for (let i = 0; i < 300; i++) {
            await sleep(500);
            frameA = pageA.frames().find(f =>
                f.url().includes('cool.html') && f.url().includes(fileId));
            if (frameA) {
                const state = await frameA.evaluate(() => {
                    const wc = document.querySelector('#StateWordCount')?.textContent || '';
                    return {
                        wc,
                        loadedDoc: window.__wasmLoadedDocName || null,
                        ws: typeof globalThis.TheFakeWebSocket !== 'undefined',
                    };
                }).catch(() => null);
                if (state && state.loadedDoc === fileId
                    && /\d+\s+character/i.test(state.wc)
                    && state.ws) break;
            }
        }
        if (!frameA) throw new Error('Editor A did not load');
        await sleep(5000);

        // Take a page, not a frame. Re-resolves the active editor frame
        // each call so a viewer-side iframe replaceChild mid-test
        // doesn't poison the read with `frame got detached`.
        async function getWc(page) {
            return _evalInFrame(page, () =>
                document.querySelector('#StateWordCount')?.textContent?.trim() || '').catch(() => '');
        }
        async function clickA() {
            const el = await pageA.$('iframe#editor-frame');
            if (el) { const b = await el.boundingBox(); if (b) await pageA.mouse.click(b.x + b.width/2, b.y + b.height/2); }
            await sleep(300);
        }

        await clickA();
        const cc0 = charCount(await getWc(pageA));
        console.log('  Initial: ' + cc0 + ' chars');

        // Type "HELLO "
        await clickA();
        await pageA.keyboard.type('HELLO ', { delay: 80 });
        await sleep(3000);
        const cc1 = charCount(await getWc(pageA));
        check('A typed +6', cc1 - cc0 === 6, 'delta=' + (cc1 - cc0));

        // Select all + copy + move to end + paste (internal)
        await clickA();
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('a'); await pageA.keyboard.up('Control');
        await sleep(500);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('c'); await pageA.keyboard.up('Control');
        await sleep(3000);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('End'); await pageA.keyboard.up('Control');
        await sleep(300);
        await pageA.keyboard.press('End'); // deselect
        await sleep(300);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('v'); await pageA.keyboard.up('Control');
        await sleep(8000);
        const cc2 = charCount(await getWc(pageA));
        check('A internal paste: delta > 0', cc2 > cc1, 'delta=' + (cc2 - cc1));

        // External text paste
        await pageA.evaluate(async () => {
            await navigator.clipboard.write([new ClipboardItem({
                'text/plain': new Blob(['EXTPASTE'], { type: 'text/plain' }),
            })]);
        });
        await sleep(300);
        await clickA();
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('End'); await pageA.keyboard.up('Control');
        await sleep(300);
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('v'); await pageA.keyboard.up('Control');
        await sleep(8000);
        const cc3 = charCount(await getWc(pageA));
        check('A external text paste: +8', cc3 - cc2 === 8, 'delta=' + (cc3 - cc2));

        // External image paste
        await pageA.evaluate(async () => {
            var b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
            var raw = atob(b64); var bytes = new Uint8Array(raw.length);
            for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
            await navigator.clipboard.write([new ClipboardItem({
                'image/png': new Blob([bytes], { type: 'image/png' }),
                'text/plain': new Blob([''], { type: 'text/plain' }),
            })]);
        });
        await sleep(300);
        await clickA();
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('v'); await pageA.keyboard.up('Control');
        await sleep(8000);
        const cc4 = charCount(await getWc(pageA));
        check('A image paste: no text change (|delta| <= 2)', Math.abs(cc4 - cc3) <= 2, 'delta=' + (cc4 - cc3));
        const ccAfinal = cc4;

        await snap(pageA, 'A_after_all_edits');
        console.log('  A final: ' + ccAfinal + ' chars');

        // Save (Ctrl+S) and wait for checkpoint
        await clickA();
        await pageA.keyboard.down('Control'); await pageA.keyboard.press('s'); await pageA.keyboard.up('Control');
        console.log('  [A] Ctrl+S — waiting for checkpoint...');
        await sleep(15000); // generous wait for save + upload + relay

        // ═══ Browser B: late join ═══
        console.log('\n=== Phase B: late join ===');
        const ctxB = await browser.createBrowserContext();
        const pageB = await ctxB.newPage();
        await pageB.setViewport({ width: 1280, height: 900 });
        await pageB.goto(VIEWER + '/#file=' + b64urlSecret, { waitUntil: 'domcontentloaded' });

        let frameB;
        for (let i = 0; i < 300; i++) {
            await sleep(500);
            // Match the iframe that actually loaded the TARGET doc.
            //  - URL filter catches 1st-level mismatch (prewarm blank
            //    frame with no target name)
            //  - Title-bar (#document-name-input, set by wasm-loader on
            //    switchdoc) catches 2nd-level: the prewarm iframe has
            //    #switchdoc=<name> in its URL fragment, so URL match
            //    is true, but the statusbar still shows the prewarm
            //    blank's ~900 chars of accumulated template text until
            //    the LO-side switch actually completes.
            // In v2, WOPISrc is the fileId.
            frameB = pageB.frames().find(f =>
                f.url().includes('cool.html') && f.url().includes(fileId));
            if (frameB) {
                const state = await frameB.evaluate(() => {
                    const wc = document.querySelector('#StateWordCount')?.textContent || '';
                    return {
                        wc,
                        loadedDoc: window.__wasmLoadedDocName || null,
                        ws: typeof globalThis.TheFakeWebSocket !== 'undefined',
                    };
                }).catch(() => null);
                if (state && state.loadedDoc === fileId
                    && /\d+\s+character/i.test(state.wc)
                    && state.ws) break;
            }
        }
        if (!frameB) throw new Error('Editor B did not load');
        await sleep(10000); // settle for message replay

        // Final convergence wait — A's late-save and B's replay can
        // land up to ~60s apart on Azure (save RTT + upload + blob
        // fetch + decrypt + LO apply chain).
        let ccB = charCount(await getWc(pageB));
        const convDeadline = Date.now() + 60000;
        while (Math.abs(ccB - ccAfinal) > 5 && Date.now() < convDeadline) {
            await sleep(500);
            ccB = charCount(await getWc(pageB));
        }
        await snap(pageB, 'B_after_join');
        console.log('  B after join: ' + ccB + ' chars (A had ' + ccAfinal + ')');
        check('B catches up to A (within ±5)', Math.abs(ccB - ccAfinal) <= 5,
            'B=' + ccB + ' A=' + ccAfinal + ' diff=' + Math.abs(ccB - ccAfinal));

        // B types "EXTRA" to prove co-edit works post-join
        async function clickB() {
            const el = await pageB.$('iframe#editor-frame');
            if (el) { const b = await el.boundingBox(); if (b) await pageB.mouse.click(b.x + b.width/2, b.y + b.height/2); }
            await sleep(300);
        }
        await clickB();
        await pageB.keyboard.down('Control'); await pageB.keyboard.press('End'); await pageB.keyboard.up('Control');
        await sleep(500);
        await pageB.keyboard.type('EXTRA', { delay: 80 });
        await sleep(5000);
        const ccBafter = charCount(await getWc(pageB));
        check('B typed +5', ccBafter - ccB === 5, 'delta=' + (ccBafter - ccB));

        // Check A sees B's edit
        await sleep(5000);
        const ccAend = charCount(await getWc(pageA));
        check('A sees B edit (A grew by ~5)', Math.abs(ccAend - ccAfinal - 5) <= 2,
            'A=' + ccAend + ' expected~' + (ccAfinal + 5));

        await snap(pageA, 'A_final');
        await snap(pageB, 'B_final');
        console.log('\n' + (allPassed ? '✓ ALL PASSED' : '✗ SOME FAILED'));

    } catch (e) {
        console.error('Error:', e.message);
        allPassed = false;
    } finally {
        await cleanup();
        process.exit(allPassed ? 0 : 1);
    }
})();
