// Same-type hot-switch via the viewer UI. Upload 3 same-type files
// (3 docx variants), then click between them — should hot-switch.
const __cl = require('./lib/inject-checklist');
const { launch, sleep } = require('./lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');

const VIEWER = env.VIEWER_URL || 'https://viewer.szebeni.hu';
// 3 different docx files. We synthesize copies of test document.docx
// with different bytes so they have distinct fileIds in v2.
const FIXTURES = ['hs-A.docx', 'hs-B.docx', 'hs-C.docx'];
const SRC = '/home/localadmin/online/test/data/test document.docx';

const T0 = Date.now();
function elapsed() { return ((Date.now() - T0) / 1000).toFixed(1) + 's'; }
function log(msg) { console.log(`[${elapsed()}] ${msg}`); }

(async () => {
    log('=== Same-type hot-switch via viewer UI ===');

    // Stage 3 distinct copies in /tmp so v2 fileIds differ
    for (let i = 0; i < FIXTURES.length; i++) {
        const dst = '/tmp/' + FIXTURES[i];
        const bytes = fs.readFileSync(SRC);
        // Append byte to create distinct hash → distinct fileId
        const padded = Buffer.concat([bytes, Buffer.from([0x20 + i, 0x0a])]);
        fs.writeFileSync(dst, padded);
    }

    const { browser, cleanup } = await launch();
    let allPassed = true;

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 900 });

        page.on('console', msg => {
            const t = msg.text();
            if (t.includes('PostMessage ignored')) return;
            if (/^\s*$/.test(t)) return;
            if (t.includes('Hot') || t.includes('cold') || t.includes('switch') ||
                t.includes('Editor iframe') || t.includes('Document ready') ||
                t.includes('error') || t.includes('Error') ||
                t.includes('lastOpenMode')) {
                console.log('[v]', t.substring(0, 220));
            }
        });

        await page.goto(VIEWER, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('#upload', { timeout: 30000 });

        const fileInput = await page.$('#upload');
        await fileInput.uploadFile.apply(fileInput, FIXTURES.map(f => '/tmp/' + f));

        await page.waitForFunction(
            count => document.querySelectorAll('#list .file').length >= count,
            { timeout: 60000 }, FIXTURES.length
        );
        log('uploaded ' + (await page.$$eval('#list .file', e => e.length)) + ' files');

        const clickAndWait = async (label, fname) => {
            log(`---- click ${label} (${fname}) ----`);
            const t0 = Date.now();
            const clicked = await page.evaluate(fname => {
                for (const el of document.querySelectorAll('#list .file')) {
                    if ((el.textContent || '').includes(fname)) { el.click(); return true; }
                }
                return false;
            }, fname);
            if (!clicked) throw new Error('No element matched: ' + fname);

            const ready = await page.evaluate(async timeoutMs => {
                const t0 = Date.now();
                let sawShieldUp = false;
                while (Date.now() - t0 < timeoutMs) {
                    const shield = document.getElementById('editor-shield');
                    const visible = shield && !shield.classList.contains('hidden') &&
                        getComputedStyle(shield).display !== 'none';
                    if (visible) sawShieldUp = true;
                    if (sawShieldUp && !visible) return { ok: true, ms: Date.now() - t0 };
                    await new Promise(r => setTimeout(r, 100));
                }
                return { ok: false, ms: Date.now() - t0, sawShieldUp };
            }, 90000);

            const dt = Date.now() - t0;
            const mode = await page.evaluate(() => window.__viewerState?.lastOpenMode);
            log(`${label}: ${dt}ms (mode: ${mode}, shield-drop: ${ready.ms}ms ${ready.ok ? 'ok' : 'TIMEOUT'})`);
            __cl.recordCheck(`open ${label}`, ready.ok);
            if (!ready.ok) allPassed = false;
            return { dt, mode, ready };
        };

        // First click is hot-switch from prewarm blank (which was already a docx)
        // Subsequent clicks should ALL be hot since same docType.
        const results = [];
        for (let i = 0; i < FIXTURES.length; i++) {
            const r = await clickAndWait('open' + i, FIXTURES[i]);
            results.push(r);
            await sleep(2000);
        }
        // Repeat first one to test going back
        results.push(await clickAndWait('back-to-A', FIXTURES[0]));

        log('\n=== RESULTS ===');
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            log(`  ${r.ready.ok ? '✓' : '✗'} click${i}: ${r.dt}ms (mode=${r.mode})`);
        }
        await page.screenshot({ path: '/tmp/viewer-same-type-final.png' });
    } catch (e) {
        log('ERROR: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        await cleanup();
    }

    log(allPassed ? '\n✓ ALL CLICKS WORKED' : '\n✗ SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
