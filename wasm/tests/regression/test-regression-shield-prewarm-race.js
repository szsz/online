const __cl = require('../../lib/inject-checklist');
// Regression test: the loading shield must stay up when the user clicks a
// file while prewarm is still finishing.
//
// The bug: prewarm's App_LoadingStatus=Initialized arrived after openFile()
// had already shown its own "Opening document…" shield. The handler set
// prewarmReady=true and called hideShield() — exposing the prewarm blank
// document to the user until the real document painted.
//
// Fix: App_LoadingStatus only hides the shield when currentFile is null
// (no document open in progress). With currentFile set, the shield is
// owned by openFile() and will be hidden on WasmDocReady.
//
// The same race occurs on /#file=<name> deep-link loads (openFile runs
// from init(), then the prewarm iframe — about to be replaced — fires
// Initialized).
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');
const { seedRecentFiles, waitForSidebar, clickSidebarFile } = require('../../lib/v2-test-helper');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-shield-prewarm-race';
const DOC_NAME = 'shield-race-test.docx';
const FIXTURE = path.join(__dirname, '..', 'test', 'data', 'new.docx');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2,'0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch(e) {}
}

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}${ev?' ['+ev+']':''}`); allPassed = false; }
}

// Sample the shield's display state at high frequency. Returns the array
// of {t, visible} samples.
async function startShieldSampler(page) {
    await page.evaluate(() => {
        window.__shieldSamples = [];
        window.__shieldStart = performance.now();
        window.__shieldInterval = setInterval(() => {
            const sh = document.getElementById('editor-shield');
            const visible = !!sh && getComputedStyle(sh).display !== 'none';
            window.__shieldSamples.push({
                t: performance.now() - window.__shieldStart,
                visible: visible,
            });
        }, 25);
    });
}
async function stopShieldSampler(page) {
    return page.evaluate(() => {
        if (window.__shieldInterval) {
            clearInterval(window.__shieldInterval);
            window.__shieldInterval = null;
        }
        return window.__shieldSamples || [];
    });
}

(async () => {
    log('=== Regression: shield stays up across prewarm/click race ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(FIXTURE)) { log('ERROR: fixture missing: ' + FIXTURE); process.exit(1); }

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-features=SharedArrayBuffer'],
    });

    try {
        // Upload fixture via v2 (encrypted)
        const bytes = fs.readFileSync(FIXTURE);
        const up = await uploadV2(VIEWER, DOC_NAME, bytes);
        log(`Uploaded ${DOC_NAME} → ${up.fileId.substring(0,8)}…`);
        const recentList = [{ b64urlSecret: up.b64urlSecret, fileId: up.fileId, cachedName: DOC_NAME }];

        // ── Case 1: deep-link load /#file=X — shield must stay up
        // continuously from page load until WasmDocReady.
        log('\n--- Case 1: deep-link load /#file=X ---');
        const p1 = await browser.newPage();
        await p1.setCacheEnabled(false);
        await p1.setViewport({ width: 1280, height: 900 });
        await p1.goto(VIEWER + '/#file=' + up.b64urlSecret,
            { waitUntil: 'domcontentloaded' });
        await startShieldSampler(p1);

        // Wait for openFile to finish (currentFile set + WasmDocReady fires).
        // The shield drop-time is when the editor would actually be visible.
        const dropDeadline = Date.now() + 120000;
        let shieldDropped = false;
        while (Date.now() < dropDeadline) {
            const visible = await p1.evaluate(() => {
                const sh = document.getElementById('editor-shield');
                return !!sh && getComputedStyle(sh).display !== 'none';
            });
            if (!visible) { shieldDropped = true; break; }
            await sleep(500);
        }
        const samples1 = await stopShieldSampler(p1);
        await snap(p1, 'deeplink_after_drop');

        // Look for any GAP in shield visibility before the final drop.
        // Find the last sample where visible=true; everything before must
        // also have been visible. A gap (visible=false followed by
        // visible=true) is the regression — shield flickered off then on.
        let firstHidden = -1;
        let resurrected = false;
        for (let i = 0; i < samples1.length; i++) {
            if (!samples1[i].visible && firstHidden < 0) firstHidden = i;
            if (firstHidden >= 0 && samples1[i].visible) { resurrected = true; break; }
        }
        const totalSamples = samples1.length;
        const visibleSamples = samples1.filter(s => s.visible).length;
        log(`Deep-link: ${totalSamples} samples, ${visibleSamples} visible, ` +
            `first-hidden=${firstHidden}, resurrected=${resurrected}`);

        check('Deep-link: shield reaches dropped state', shieldDropped);
        check('Deep-link: no shield flicker (continuous up then final drop)',
              !resurrected, 'resurrected after first hidden = regression');
        check('Deep-link: shield was up for most of load',
              visibleSamples >= totalSamples * 0.5,
              `${visibleSamples}/${totalSamples} visible`);

        await p1.close();

        // ── Case 2: click during prewarm window. Race the click against
        // the prewarm-completion postMessage.
        log('\n--- Case 2: click while prewarm is still finishing ---');
        const p2 = await browser.newPage();
        await p2.setCacheEnabled(false);
        await p2.setViewport({ width: 1280, height: 900 });
        await seedRecentFiles(p2, recentList);
        await p2.goto(VIEWER + '/', { waitUntil: 'domcontentloaded' });
        await waitForSidebar(p2, up.fileId, 15000);
        // Wait for prewarm to be NEARLY done (iframe loaded cool.html and
        // started initializing) but click before it posts Initialized.
        // We approximate this by clicking a few seconds after page load —
        // the goal is to reproduce the race where click happens during
        // the prewarm-finishing window. Even if we miss the window in a
        // particular run, the assertion (shield never resurrects) must
        // hold whether or not the race fires.
        await sleep(1000);
        await startShieldSampler(p2);
        await clickSidebarFile(p2, up.fileId);

        // 180s: click-during-prewarm forces a cold-reload of the target
        // iframe, which on Azure is 40-90s for WASM fetch+compile+LO+doc.
        // 120s was tight; 180s matches our Pre-Warm budget.
        const dropDeadline2 = Date.now() + 180000;
        let shieldDropped2 = false;
        while (Date.now() < dropDeadline2) {
            const visible = await p2.evaluate(() => {
                const sh = document.getElementById('editor-shield');
                return !!sh && getComputedStyle(sh).display !== 'none';
            });
            if (!visible) { shieldDropped2 = true; break; }
            await sleep(500);
        }
        const samples2 = await stopShieldSampler(p2);
        await snap(p2, 'click_after_drop');

        let firstHidden2 = -1;
        let resurrected2 = false;
        for (let i = 0; i < samples2.length; i++) {
            if (!samples2[i].visible && firstHidden2 < 0) firstHidden2 = i;
            if (firstHidden2 >= 0 && samples2[i].visible) { resurrected2 = true; break; }
        }
        const visible2 = samples2.filter(s => s.visible).length;
        log(`Click: ${samples2.length} samples, ${visible2} visible, ` +
            `first-hidden=${firstHidden2}, resurrected=${resurrected2}`);

        check('Click: shield reaches dropped state', shieldDropped2);
        check('Click: no shield flicker (no hide → show resurrect)',
              !resurrected2, 'resurrected after first hidden = regression');

        await p2.close();

        log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    } catch(e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        await browser.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
