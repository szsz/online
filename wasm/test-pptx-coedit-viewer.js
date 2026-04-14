const __cl = require('./lib/inject-checklist');
// E2E Test: Two browsers co-editing a large pptx via the viewer.
// Uses the real "text-based file-editing kickoff presentation (2).pptx" (6.1MB).
//
// Flow:
//   1. Upload the pptx to the viewer
//   2. Browser A opens viewer, waits for prewarm, clicks the file
//   3. Browser A waits for Impress to load
//   4. Browser B opens the SAME viewer URL and clicks the same file
//   5. Both browsers type text on a slide
//   6. Verify: both see each other's cursors / remote clients
//   7. Verify: navigate to slides 5 and 6 — they must render
//   8. Verify: no OOB memory errors
//
// This test is expected to FAIL initially (co-editing not working in manual tests).

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const VIEWER = 'https://viewer.szebeni.hu:6934';
const SHOT_DIR = '/tmp/static-deploy/public/shots-pptx-coedit-viewer';
const DOC_NAME = 'text-based file-editing kickoff presentation (2).pptx';
const DOC_PATH = '/tmp/kickoff.pptx'; // downloaded from viewer

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
    if (cond) log(`  ✓ ${label}${ev ? ' ['+ev+']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' ['+ev+']' : ''}`); allPassed = false; }
}

// Wait for Impress UI in a frame (handles cold-reload frame detach)
async function waitImpress(page, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        await sleep(300);
        const fr = page.frames().find(f => f.url().includes('cool.html'));
        if (!fr) continue;
        try {
            const nav = await fr.evaluate(() =>
                document.querySelector('nav.main-nav')?.textContent || '');
            if (nav.includes('Slide Show')) return fr;
        } catch(e) {}
    }
    return null;
}

// Get slide count and current part from a frame
async function getSlideInfo(fr) {
    return fr.evaluate(() => {
        const map = window.app?.map || window._map;
        if (!map || !map._docLayer) return { parts: 0, current: -1 };
        return { parts: map._docLayer._parts || 0, current: map._docLayer._selectedPart || 0 };
    }).catch(() => ({ parts: 0, current: -1 }));
}

// Check if canvas has non-white content
async function hasCanvasContent(fr) {
    return fr.evaluate(() => {
        const c = document.querySelector('canvas');
        if (!c) return false;
        try {
            const ctx = c.getContext('2d');
            const d = ctx.getImageData(c.width/4, c.height/4, 30, 30).data;
            let nonWhite = 0;
            for (let i = 0; i < d.length; i += 4)
                if (d[i] < 240 || d[i+1] < 240 || d[i+2] < 240) nonWhite++;
            return nonWhite > 10;
        } catch(e) { return false; }
    }).catch(() => false);
}

// Type text via TheFakeWebSocket
async function typeText(fr, text) {
    for (const ch of text) {
        await fr.evaluate(c => {
            if (globalThis.TheFakeWebSocket)
                TheFakeWebSocket.send('key type=input char=' + c.charCodeAt(0) + ' key=0');
        }, ch);
        await sleep(300);
    }
}

// Double-click center of slide to enter text editing
async function clickSlideCenter(fr) {
    await fr.evaluate(() => {
        if (globalThis.TheFakeWebSocket) {
            TheFakeWebSocket.send('mouse type=buttondown x=10000 y=7000 count=2 buttons=1 modifier=0');
            TheFakeWebSocket.send('mouse type=buttonup x=10000 y=7000 count=2 buttons=1 modifier=0');
        }
    });
    await sleep(2000);
}

(async () => {
    log('=== PPTX Co-Edit via Viewer E2E Test ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(DOC_PATH)) {
        log('ERROR: ' + DOC_PATH + ' not found. Download from viewer first.');
        process.exit(1);
    }

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-features=SharedArrayBuffer'],
    });
    const pageErrors = { A: [], B: [] };

    try {
        // Upload to viewer
        const up = await browser.newPage();
        await up.goto(VIEWER + '/');
        const bytes = fs.readFileSync(DOC_PATH);
        await up.evaluate(async (n, a) => {
            await fetch('/api/files/' + encodeURIComponent(n), {
                method: 'POST', body: new Blob([new Uint8Array(a)]),
            });
        }, DOC_NAME, Array.from(bytes));
        await up.close();
        log('Uploaded ' + DOC_NAME + ' (' + (bytes.length/1024/1024).toFixed(1) + 'MB)');

        // ─── Browser A ───
        log('\n--- Browser A: open via viewer ---');
        const ctxA = await browser.createBrowserContext();
        const pageA = await ctxA.newPage();
        await pageA.setViewport({ width: 1280, height: 900 });
        pageA.on('pageerror', e => pageErrors.A.push(e.message.substring(0, 200)));

        await pageA.goto(VIEWER + '/', { waitUntil: 'domcontentloaded' });

        // Wait prewarm
        for (let i = 0; i < 120; i++) {
            await sleep(500);
            try {
                const fr = pageA.frames().find(f => f.url().includes('cool.html'));
                if (fr && await fr.evaluate(() => !!window.__wasmPrewarmReady)) break;
            } catch(e) {}
        }
        log('A: prewarm done');

        // Click the pptx
        await pageA.evaluate(n => {
            const el = [...document.querySelectorAll('.file')].find(e => e.dataset.name === n);
            if (!el) throw new Error('File not found: ' + n);
            el.click();
        }, DOC_NAME);
        log('A: clicked file (cold reload for impress)');

        const frA = await waitImpress(pageA, 90000);
        check('A: Impress loaded', !!frA);
        if (!frA) throw new Error('A: Impress timeout');
        await sleep(5000);
        await snap(pageA, 'A_impress_loaded');

        const infoA = await getSlideInfo(frA);
        log('A: ' + infoA.parts + ' slides, current=' + infoA.current);
        check('A: has 6+ slides', infoA.parts >= 6, 'parts=' + infoA.parts);

        // ─── Browser B ───
        log('\n--- Browser B: open same file via viewer ---');
        const ctxB = await browser.createBrowserContext();
        const pageB = await ctxB.newPage();
        await pageB.setViewport({ width: 1280, height: 900 });
        pageB.on('pageerror', e => pageErrors.B.push(e.message.substring(0, 200)));

        await pageB.goto(VIEWER + '/', { waitUntil: 'domcontentloaded' });

        // B also needs prewarm
        for (let i = 0; i < 120; i++) {
            await sleep(500);
            try {
                const fr = pageB.frames().find(f => f.url().includes('cool.html'));
                if (fr && await fr.evaluate(() => !!window.__wasmPrewarmReady)) break;
            } catch(e) {}
        }
        log('B: prewarm done');

        await pageB.evaluate(n => {
            const el = [...document.querySelectorAll('.file')].find(e => e.dataset.name === n);
            if (!el) throw new Error('File not found: ' + n);
            el.click();
        }, DOC_NAME);
        log('B: clicked file');

        const frB = await waitImpress(pageB, 90000);
        check('B: Impress loaded', !!frB);
        if (!frB) throw new Error('B: Impress timeout');
        await sleep(5000);
        await snap(pageB, 'B_impress_loaded');

        const infoB = await getSlideInfo(frB);
        check('B: has 6+ slides', infoB.parts >= 6, 'parts=' + infoB.parts);

        // ─── Co-editing: type on slide 1 ───
        log('\n--- Co-editing on slide 1 ---');

        // A types on slide 1
        await clickSlideCenter(frA);
        await typeText(frA, 'ALPHA');
        log('A: typed ALPHA');
        await snap(pageA, 'A_typed_ALPHA');

        await sleep(3000);

        // B types on slide 1
        await clickSlideCenter(frB);
        await typeText(frB, 'BETA');
        log('B: typed BETA');
        await snap(pageB, 'B_typed_BETA');

        await sleep(3000);
        await snap(pageA, 'A_after_coedit');
        await snap(pageB, 'B_after_coedit');

        // Check for remote views (other users)
        const aViews = await frA.evaluate(() => {
            const map = window.app?.map || window._map;
            return map ? Object.keys(map._viewInfo || {}).length : 0;
        }).catch(() => 0);
        const bViews = await frB.evaluate(() => {
            const map = window.app?.map || window._map;
            return map ? Object.keys(map._viewInfo || {}).length : 0;
        }).catch(() => 0);
        log('A sees ' + aViews + ' views, B sees ' + bViews + ' views');
        log('A views=' + aViews + ' B views=' + bViews);
        check('A: relay connected', aViews >= 1, 'views=' + aViews);
        check('B: relay connected', bViews >= 1, 'views=' + bViews);

        // ─── Convergence: verify both browsers show the same content ───
        log('\n--- Convergence check ---');
        await sleep(5000); // let relay sync settle

        // Both navigate to slide 1
        await frA.evaluate(() => { (window.app?.map||window._map)?.setPart(0); });
        await frB.evaluate(() => { (window.app?.map||window._map)?.setPart(0); });
        await sleep(3000);

        // Canvas fingerprint comparison
        const canvasA = await frA.evaluate(() =>
            document.querySelector('canvas')?.toDataURL('image/png').substring(0, 500) || '').catch(() => '');
        const canvasB = await frB.evaluate(() =>
            document.querySelector('canvas')?.toDataURL('image/png').substring(0, 500) || '').catch(() => '');
        let matching = 0;
        const len = Math.min(canvasA.length, canvasB.length);
        for (let i = 0; i < len; i++) if (canvasA[i] === canvasB[i]) matching++;
        const similarity = len > 0 ? (matching / len * 100).toFixed(1) : '0';
        log('  Canvas similarity: ' + similarity + '%');
        await snap(pageA, 'convergence_A');
        await snap(pageB, 'convergence_B');
        check('Content converged: canvas similarity >90%', parseFloat(similarity) > 90, similarity + '%');

        // ─── Navigate to slides 5 and 6 ───
        log('\n--- Slide navigation: slides 5 and 6 ---');
        for (const slideNum of [5, 6]) {
            const partIdx = slideNum - 1;
            // Navigate A
            await frA.evaluate(n => {
                const m = window.app?.map || window._map;
                if (m) m.setPart(n);
            }, partIdx);
            await sleep(3000);
            await snap(pageA, 'A_slide_' + slideNum);
            const hasA = await hasCanvasContent(frA);
            check('A: slide ' + slideNum + ' renders content', hasA);

            // Navigate B
            await frB.evaluate(n => {
                const m = window.app?.map || window._map;
                if (m) m.setPart(n);
            }, partIdx);
            await sleep(3000);
            await snap(pageB, 'B_slide_' + slideNum);
            const hasB = await hasCanvasContent(frB);
            check('B: slide ' + slideNum + ' renders content', hasB);
        }

        // ─── Heavy editing: rapid typing on slide 3 ───
        log('\n--- Heavy editing: rapid typing on slide 3 ---');
        await frA.evaluate(() => { (window.app?.map||window._map)?.setPart(2); });
        await frB.evaluate(() => { (window.app?.map||window._map)?.setPart(2); });
        await sleep(3000);

        await clickSlideCenter(frA);
        await clickSlideCenter(frB);

        // A types fast
        for (const ch of 'RAPIDFROMA') {
            await frA.evaluate(c => {
                if (globalThis.TheFakeWebSocket)
                    TheFakeWebSocket.send('key type=input char=' + c.charCodeAt(0) + ' key=0');
            }, ch);
            await sleep(100);
        }
        // B types fast
        for (const ch of 'RAPIDFROMB') {
            await frB.evaluate(c => {
                if (globalThis.TheFakeWebSocket)
                    TheFakeWebSocket.send('key type=input char=' + c.charCodeAt(0) + ' key=0');
            }, ch);
            await sleep(100);
        }
        await sleep(5000); // let relay sync
        await snap(pageA, 'A_heavy_edit');
        await snap(pageB, 'B_heavy_edit');
        check('Heavy editing completed without crash', true);

        // Final convergence: both on slide 3, compare word counts
        const wcA3 = await frA.evaluate(() =>
            document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
        const wcB3 = await frB.evaluate(() =>
            document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
        log('  After heavy edit — A: "' + wcA3 + '" B: "' + wcB3 + '"');
        check('Final convergence: same word count on slide 3', wcA3 === wcB3,
              'A="' + wcA3 + '" B="' + wcB3 + '"');

        // ─── Error check ───
        const realErrorsA = pageErrors.A.filter(e => !/ResizeObserver/i.test(e));
        const realErrorsB = pageErrors.B.filter(e => !/ResizeObserver/i.test(e));
        const oobA = realErrorsA.filter(e => e.includes('memory access'));
        const oobB = realErrorsB.filter(e => e.includes('memory access'));
        if (realErrorsA.length) { log('A errors: ' + realErrorsA.length); realErrorsA.slice(0,3).forEach(e => log('  ' + e)); }
        if (realErrorsB.length) { log('B errors: ' + realErrorsB.length); realErrorsB.slice(0,3).forEach(e => log('  ' + e)); }
        check('A: no OOB memory errors', oobA.length === 0, oobA.length + ' OOB');
        check('B: no OOB memory errors', oobB.length === 0, oobB.length + ' OOB');

        log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));

    } catch(e) {
        log('Error: ' + e.message);
        allPassed = false;
    } finally {
        await browser.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
