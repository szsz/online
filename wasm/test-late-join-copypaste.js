const __cl = require('./lib/inject-checklist');
// Late-join + copy/paste: Browser A types, copies, pastes (text + image),
// saves. Browser B late-joins and must receive all of A's content.
// ALL input via real keyboard/mouse.
const { launch, sleep } = require('./lib/browser');
const fs = require('fs'), path = require('path');
const env = require('./lib/test-env');
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
        // Upload fresh doc
        const docName = 'ljcp-' + Date.now() + '.docx';
        const up = await browser.newPage();
        await up.goto(VIEWER + '/');
        await up.evaluate(async (name, a) => {
            await fetch('/api/files/' + name, { method: 'POST', body: new Blob([new Uint8Array(a)]) });
        }, docName, Array.from(fs.readFileSync(path.join(__dirname, '..', 'test', 'data', 'new.docx'))));
        await up.close();
        console.log('[setup] Uploaded ' + docName);

        // ═══ Browser A: type + paste + save ═══
        console.log('\n=== Phase A: type, copy, paste, save ===');
        const pageA = await browser.newPage();
        const cdpA = await pageA.createCDPSession();
        await cdpA.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
        await pageA.setViewport({ width: 1280, height: 900 });
        await pageA.goto(VIEWER + '/#file=' + docName, { waitUntil: 'domcontentloaded' });

        // Wait for editor
        let frameA;
        for (let i = 0; i < 300; i++) {
            await sleep(500);
            frameA = pageA.frames().find(f => f.url().includes('cool.html'));
            if (frameA) {
                const wc = await frameA.evaluate(() =>
                    document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
                if (/\d+\s+character/i.test(wc)) {
                    const ws = await frameA.evaluate(() =>
                        typeof globalThis.TheFakeWebSocket !== 'undefined').catch(() => false);
                    if (ws) break;
                }
            }
        }
        if (!frameA) throw new Error('Editor A did not load');
        await sleep(5000);

        async function getWc(frame) {
            return frame.evaluate(() =>
                document.querySelector('#StateWordCount')?.textContent?.trim() || '').catch(() => '');
        }
        async function clickA() {
            const el = await pageA.$('iframe#editor-frame');
            if (el) { const b = await el.boundingBox(); if (b) await pageA.mouse.click(b.x + b.width/2, b.y + b.height/2); }
            await sleep(300);
        }

        await clickA();
        const cc0 = charCount(await getWc(frameA));
        console.log('  Initial: ' + cc0 + ' chars');

        // Type "HELLO "
        await clickA();
        await pageA.keyboard.type('HELLO ', { delay: 80 });
        await sleep(3000);
        const cc1 = charCount(await getWc(frameA));
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
        const cc2 = charCount(await getWc(frameA));
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
        const cc3 = charCount(await getWc(frameA));
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
        const cc4 = charCount(await getWc(frameA));
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
        await pageB.goto(VIEWER + '/#file=' + docName, { waitUntil: 'domcontentloaded' });

        let frameB;
        for (let i = 0; i < 300; i++) {
            await sleep(500);
            frameB = pageB.frames().find(f => f.url().includes('cool.html'));
            if (frameB) {
                const wc = await frameB.evaluate(() =>
                    document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
                if (/\d+\s+character/i.test(wc)) {
                    const ws = await frameB.evaluate(() =>
                        typeof globalThis.TheFakeWebSocket !== 'undefined').catch(() => false);
                    if (ws) break;
                }
            }
        }
        if (!frameB) throw new Error('Editor B did not load');
        await sleep(10000); // settle for message replay

        const ccB = charCount(await getWc(frameB));
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
        const ccBafter = charCount(await getWc(frameB));
        check('B typed +5', ccBafter - ccB === 5, 'delta=' + (ccBafter - ccB));

        // Check A sees B's edit
        await sleep(5000);
        const ccAend = charCount(await getWc(frameA));
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
