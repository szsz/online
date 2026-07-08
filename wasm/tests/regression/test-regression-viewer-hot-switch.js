// End-to-end test: upload 3 files via viewer's UI, switch between them
// by CLICKING on file entries (no direct JS calls). Captures timings,
// console output, network requests, and which path the viewer uses
// (hot-switch vs cold-reload) for each switch.
const __cl = require('../../lib/inject-checklist');
const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');

const VIEWER = env.VIEWER_URL || 'https://viewer.atgpartners.info';
const FIXTURES = [
    { label: 'writer',  name: 'test document.docx', src: '/home/localadmin/online/test/data/test document.docx' },
    { label: 'calc',    name: 'testdoc.xlsx',       src: '/home/localadmin/online/test/data/testdoc.xlsx' },
    { label: 'impress', name: 'testdoc.pptx',       src: '/home/localadmin/online/test/data/testdoc.pptx' },
];

const T0 = Date.now();
function elapsed() { return ((Date.now() - T0) / 1000).toFixed(1) + 's'; }
function log(msg) { console.log(`[${elapsed()}] ${msg}`); }

(async () => {
    log('=== End-to-end viewer hot-switch test ===');

    const { browser, cleanup } = await launch();
    let allPassed = true;

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 900 });

        // Capture viewer console (don't capture iframe — we do that separately)
        page.on('console', msg => {
            const t = msg.text();
            if (t.includes('PostMessage ignored')) return;
            if (/^\s*$/.test(t)) return;
            if (t.includes('viewerLog') || t.includes('Opening file') ||
                t.includes('Hot') || t.includes('cold') || t.includes('switch') ||
                t.includes('Editor iframe') || t.includes('error') || t.includes('Error') ||
                t.includes('lastOpenMode') || t.includes('Document ready') ||
                t.includes('shield')) {
                console.log('[v]', t.substring(0, 200));
            }
        });
        page.on('pageerror', e => console.log('[v-err]', e.message.substring(0, 200)));
        page.on('framenavigated', f => {
            if (f.url().includes('cool.html')) log('IFRAME NAV: ' + f.url().substring(0, 120));
        });

        log('Navigating to ' + VIEWER);
        await page.goto(VIEWER, { waitUntil: 'domcontentloaded', timeout: 60000 });
        // Wait briefly for the file UI to render, then for prewarm to settle.
        await page.waitForSelector('#upload', { timeout: 30000 });

        // Set up iframe console capture once iframe exists
        const collectFromIframes = async () => {
            for (const fr of page.frames()) {
                if (!fr.url().includes('cool.html')) continue;
                if (fr._loggerAttached) continue;
                fr._loggerAttached = true;
                // Puppeteer auto-captures iframe console via page.on('console')
                // already, but we can also evaluate to verify connectivity
            }
        };

        // Upload all 3 files via the file input
        log('Uploading 3 fixtures via #upload input');
        const fileInput = await page.$('#upload');
        if (!fileInput) throw new Error('#upload input not found');
        const filePaths = FIXTURES.map(f => f.src);
        await fileInput.uploadFile(...filePaths);

        // Wait for files to appear in the file list (data-name attribute or
        // similar). Each file appears as <div class="file" data-name="..."/>
        log('Waiting for file list to populate');
        await page.waitForFunction(
            (count) => document.querySelectorAll('#list .file').length >= count,
            { timeout: 60000 }, FIXTURES.length
        );
        const fileListing = await page.$$eval('#list .file',
            els => els.map(e => ({ text: e.textContent.substring(0, 100), dataName: e.dataset.name, dataFileid: e.dataset.fileid })));
        log('File list (' + fileListing.length + ' entries): ' + JSON.stringify(fileListing, null, 2));

        // Click each file and wait for editor to load
        const clickAndWait = async (label, expectedFile) => {
            log(`---- CLICK file: ${label} (${expectedFile}) ----`);
            const t0 = Date.now();

            // Find and click the file by label/name. Files in #list have
            // data-name attribute. Some may have v2 IDs as data-name; we
            // match by displayName text instead.
            const clicked = await page.evaluate((label, fixture) => {
                const els = document.querySelectorAll('#list .file');
                for (const el of els) {
                    const txt = el.textContent || '';
                    // match by display name (the filename without path)
                    if (txt.includes(fixture)) {
                        el.click();
                        return el.outerHTML.substring(0, 200);
                    }
                }
                return null;
            }, label, expectedFile);
            if (!clicked) throw new Error('No file matched: ' + expectedFile);
            log(`clicked ${expectedFile}: ${clicked}`);

            // Wait for the viewer to FIRST raise the shield (signaling new
            // load started) and THEN drop it (signaling doc fully loaded).
            // Without the rising-edge detection we get false-positives from
            // a still-down shield from the previous load.
            //
            // Iter 196: cross-revive same-file opens hideShield within
            // microseconds (no awaits between showShield and hideShield),
            // faster than 100 ms poll cadence. The viewer exposes a
            // monotonic __shieldDropCount; observe its increment as
            // proxy for a complete up→down cycle.
            const baselineDropCount = await page.evaluate(() =>
                window.__shieldDropCount || 0);
            const ready = await page.evaluate(async (expected, timeoutMs, baseline) => {
                const t0 = Date.now();
                let sawShieldUp = false;
                let lastStatus = '';
                while (Date.now() - t0 < timeoutMs) {
                    const shield = document.getElementById('editor-shield');
                    const shieldVisible = shield && !shield.classList.contains('hidden') &&
                        getComputedStyle(shield).display !== 'none';
                    const status = document.getElementById('status-bar')?.textContent || '';
                    if (status !== lastStatus) lastStatus = status;
                    if (shieldVisible) sawShieldUp = true;
                    const dropCount = window.__shieldDropCount || 0;
                    // Need to first see shield UP, then DOWN.
                    if (sawShieldUp && !shieldVisible) {
                        return { ok: true, ms: Date.now() - t0, status: lastStatus, sawShieldUp };
                    }
                    // Cross-revive same-file: shield up→down faster than
                    // poll cadence. Detect via the monotonic counter.
                    if (dropCount > baseline && !shieldVisible) {
                        return { ok: true, ms: Date.now() - t0, status: lastStatus,
                                 sawShieldUp: 'inferred-from-counter' };
                    }
                    await new Promise(r => setTimeout(r, 100));
                }
                return { ok: false, ms: Date.now() - t0, status: lastStatus, sawShieldUp };
            }, expectedFile, 90000, baselineDropCount);

            const dt = Date.now() - t0;
            const mode = await page.evaluate(() =>
                window.__viewerState && window.__viewerState.lastOpenMode);
            log(`${label} loaded in ${dt}ms (mode: ${mode || '?'}, shield-drop: ${ready.ms}ms ${ready.ok ? 'ok' : 'TIMEOUT'})`);

            // Verify iframe contains the right doc-type indicator
            const docState = await page.evaluate(() => {
                for (const f of document.querySelectorAll('iframe')) {
                    if (!f.src.includes('cool.html')) continue;
                    try {
                        const doc = f.contentDocument;
                        if (!doc) return { iframeSrc: f.src.slice(-80), reason: 'no contentDocument (cross-origin)' };
                        return {
                            iframeSrc: f.src.slice(-80),
                            wc: doc.querySelector('#StateWordCount')?.textContent.trim(),
                            sd: doc.querySelector('#StatusDocPos')?.textContent.trim(),
                            ss: doc.querySelector('#SlideStatus')?.textContent.trim(),
                            docType: f.contentWindow.app?.map?._docLayer?._docType,
                        };
                    } catch (e) { return { err: e.message }; }
                }
                return null;
            });
            log(`docState: ${JSON.stringify(docState)}`);
            return { dt, mode, ready, docState };
        };

        // Open in order: writer → calc → impress → writer (4 clicks total)
        const sequence = ['writer', 'calc', 'impress', 'writer'];
        const results = [];
        for (const label of sequence) {
            const fix = FIXTURES.find(f => f.label === label);
            const r = await clickAndWait(label, fix.name);
            results.push({ label, ...r });
            __cl.recordCheck(`open ${label}`, r.ready.ok);
            if (!r.ready.ok) allPassed = false;
            await sleep(2000);
        }

        log('\n=========== RESULTS ===========');
        for (const r of results) {
            log(`  ${r.ready.ok ? '✓' : '✗'} ${r.label}: ${r.dt}ms (mode: ${r.mode})`);
        }

        // Take screenshot of final state
        await page.screenshot({ path: '/tmp/viewer-hot-switch-final.png' });

    } catch (e) {
        log('ERROR: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        await cleanup();
    }

    log(allPassed ? '\n✓ ALL CLICKS LOADED' : '\n✗ SOME LOADS FAILED');
    process.exit(allPassed ? 0 : 1);
})();
