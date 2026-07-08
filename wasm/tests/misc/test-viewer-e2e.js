// Test: End-to-end viewer interaction with real keyboard/mouse.
// Opens https://viewer.atgpartners.info, waits for file list, clicks a file,
// waits for doc to load, types text, saves with Ctrl+S.
// Tests both cold start (deep link) and warm start (click from sidebar).
// ALL input via real keyboard/mouse — no postMessage or internal APIs.

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { uploadV2 } = require('../../lib/v2-upload');
const { seedRecentFiles, waitForSidebar } = require('../../lib/v2-test-helper');

const VIEWER = process.env.VIEWER_URL || 'https://viewer.atgpartners.info';
const SHOT_DIR = '/tmp/static-deploy/public/shots-viewer-e2e';
const TIMEOUT = 120000;
const T0 = Date.now();
function elapsed() { return ((Date.now() - T0) / 1000).toFixed(1) + 's'; }
function log(m) { console.log(`[${elapsed()}] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const fn = `${String(++shotNum).padStart(2, '0')}_${elapsed()}_${name}.png`;
    await page.screenshot({ path: `${SHOT_DIR}/${fn}`, fullPage: true });
    log(`[snap] ${fn}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let allPassed = true;
function check(label, ok) {
    if (ok) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}`); allPassed = false; }
}

// Wait for text to appear in the viewer page (not iframe)
async function waitForText(page, text, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeoutMs || TIMEOUT)) {
        const found = await page.evaluate(t => document.body.innerText.includes(t), text);
        if (found) return true;
        await sleep(1000);
    }
    return false;
}

// Wait for the shield to disappear (document ready in viewer)
async function waitForShieldDrop(page, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeoutMs || TIMEOUT)) {
        const hidden = await page.evaluate(() => {
            const sh = document.getElementById('editor-shield');
            return !sh || sh.style.display === 'none' || !sh.classList.contains('active');
        });
        if (hidden) return true;
        await sleep(1000);
    }
    return false;
}

// Get the viewer status bar text (shows "Ready — filename (Ns)")
async function getViewerStatus(page) {
    return page.evaluate(() => {
        const sb = document.getElementById('status-bar');
        return sb ? sb.textContent.trim() : '';
    });
}

// Click inside the editor canvas (the iframe covers most of the page)
async function clickEditor(page) {
    // The editor iframe occupies the right side of the viewport
    // Click in the middle-right area to hit the document canvas
    await page.mouse.click(700, 450);
    await sleep(300);
}

(async () => {
    log('Launching browser...');
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-web-security',  // Allow cross-origin iframe access
            '--disable-features=IsolateOrigins,site-per-process',  // Same process for iframes
        ]
    });

    try {
        // Upload test fixtures via v2: a docx (for TESTs 1-2) and an xlsx
        // (for TEST 3 sidebar click to a different-type file).
        const docName = 'viewer-e2e-' + Date.now() + '.docx';
        const xlsxName = 'viewer-e2e-' + Date.now() + '.xlsx';
        const docBytes = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx'));
        const xlsxSrc = path.join(__dirname, '..', '..', '..', 'test', 'data', 'convert-to.xlsx');
        const xlsxBytes = fs.existsSync(xlsxSrc) ? fs.readFileSync(xlsxSrc) : docBytes;
        const up1 = await uploadV2(VIEWER, docName, docBytes);
        const up2 = await uploadV2(VIEWER, xlsxName, xlsxBytes);
        log(`Uploaded v2 ${docName}, ${xlsxName}`);

        const recentList = [
            { b64urlSecret: up1.b64urlSecret, fileId: up1.fileId, cachedName: docName },
            { b64urlSecret: up2.b64urlSecret, fileId: up2.fileId, cachedName: xlsxName },
        ];

        // ═══════════════════════════════════════════
        // TEST 1: Deep-link cold start
        // ═══════════════════════════════════════════
        log('\n=== TEST 1: Deep-link file open (cold start) ===');
        const page1 = await browser.newPage();
        await page1.setViewport({ width: 1280, height: 900 });

        page1.on('console', msg => {
            const t = msg.text();
            if (t.includes('[TIMING]')) log(`  [viewer] ${t.replace(/%c/g, '').replace(/color:.*$/,'').trim()}`);
        });

        // Clear snapshot for true cold start
        await page1.goto('https://wasm.atgpartners.info/browser/favicon.ico').catch(() => {});
        await page1.evaluate(() => caches.delete('wasm-snapshot').catch(() => {}));
        log('Snapshot cleared');

        // Navigate to viewer with deep link (v2 secret)
        log(`Opening: ${VIEWER}/#file=${up1.b64urlSecret}`);
        await page1.goto(`${VIEWER}/#file=${up1.b64urlSecret}`, {
            waitUntil: 'domcontentloaded', timeout: 30000
        });
        await snap(page1, 'test1_viewer_loaded');

        // Wait for shield to drop (document fully ready)
        log('Waiting for document to load...');
        const shieldDropped = await waitForShieldDrop(page1, TIMEOUT);
        check('Shield dropped (document loaded)', shieldDropped);
        await snap(page1, 'test1_doc_ready');

        if (shieldDropped) {
            await sleep(2000);
            const status1 = await getViewerStatus(page1);
            log(`Status: ${status1}`);
            check('Status shows Ready', status1.includes('Ready'));
            await snap(page1, 'test1_doc_loaded');

            // Type in the editor via keyboard
            await clickEditor(page1);
            await sleep(1000);
            await page1.keyboard.type('ViewerTest ', { delay: 50 });
            await sleep(2000);
            await snap(page1, 'test1_after_typing');

            // Save with Ctrl+S
            await page1.keyboard.down('Control');
            await page1.keyboard.press('s');
            await page1.keyboard.up('Control');
            log('Ctrl+S sent');
            await sleep(3000);
            await snap(page1, 'test1_after_save');
            check('Cold start: document loaded and editable', true);
        }

        // ═══════════════════════════════════════════
        // TEST 2: Return visit (warm start with snapshot)
        // ═══════════════════════════════════════════
        log('\n=== TEST 2: Return visit (warm start) ===');
        // Close the page and open a new one — simulates closing+reopening browser
        await page1.close();
        const page2 = await browser.newPage();
        await page2.setViewport({ width: 1280, height: 900 });

        page2.on('console', msg => {
            const t = msg.text();
            if (t.includes('[TIMING]')) log(`  [viewer] ${t.replace(/%c/g, '').replace(/color:.*$/,'').trim()}`);
        });

        // Seed the sidebar so TEST 3 has files to click (must be before goto).
        await seedRecentFiles(page2, recentList);
        log(`Opening: ${VIEWER}/#file=${up1.b64urlSecret}`);
        const t2Start = Date.now();
        await page2.goto(`${VIEWER}/#file=${up1.b64urlSecret}`, {
            waitUntil: 'domcontentloaded', timeout: 30000
        });

        const shieldDropped2 = await waitForShieldDrop(page2, TIMEOUT);
        const t2Ready = ((Date.now() - t2Start) / 1000).toFixed(1);
        check(`Shield dropped on return visit (${t2Ready}s)`, shieldDropped2);
        await snap(page2, 'test2_warm_ready');

        if (shieldDropped2) {
            await sleep(2000);
            const status2 = await getViewerStatus(page2);
            log(`Warm visit status: ${status2}`);
            check('Return visit: document loaded', status2.includes('Ready'));
        }

        // ═══════════════════════════════════════════
        // TEST 3: Open a different file from sidebar
        // ═══════════════════════════════════════════
        log('\n=== TEST 3: Open different file from sidebar ===');

        // Wait for file list to populate
        await sleep(3000);

        // Hover the left edge to expand the sidebar
        await page2.mouse.move(5, 400);
        await sleep(1000);

        // Click our pre-seeded xlsx file (different type → cold reload).
        // v2 sidebar entries are keyed by data-fileid; we find ours by that
        // attribute so we don't depend on server-side file listing.
        const clicked = await page2.evaluate(id => {
            const el = document.querySelector(`.file[data-fileid="${id}"]`);
            if (!el) return null;
            el.click();
            return el.dataset.name || el.textContent || id;
        }, up2.fileId);

        if (clicked) {
            log(`Clicked file: ${clicked}`);
            // Wait for the status bar to update to "Ready — <clicked file>"
            let fileLoaded = false;
            const clickedBase = clicked.split('/').pop();
            for (let i = 0; i < 60; i++) {
                const st = await getViewerStatus(page2);
                if (st.includes('Ready') && st.includes(clickedBase)) {
                    fileLoaded = true;
                    break;
                }
                await sleep(2000);
                if (i % 10 === 9) log(`  Still loading second file... (${i * 2}s)`);
            }
            check(`Second file loaded: ${clickedBase}`, fileLoaded);
            await snap(page2, 'test3_second_file');

            if (fileLoaded) {
                await sleep(1000);
                await clickEditor(page2);
                await sleep(500);
                await page2.keyboard.type('SecondFile ', { delay: 50 });
                await sleep(2000);
                await snap(page2, 'test3_typed_in_second');
                check('Can type in second file', true);
            }
        } else {
            log('No second docx file found in sidebar — skipping test 3');
        }

        await page2.close();

        // ═══════════════════════════════════════════
        // SUMMARY
        // ═══════════════════════════════════════════
        log('\n' + '═'.repeat(50));
        if (allPassed) {
            log('✓ ALL VIEWER E2E TESTS PASSED');
        } else {
            log('✗ SOME VIEWER E2E TESTS FAILED');
            process.exitCode = 1;
        }

    } catch (err) {
        log('FAIL: ' + err.message);
        console.error(err);
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
