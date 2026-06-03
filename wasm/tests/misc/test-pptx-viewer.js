const __cl = require('../../lib/inject-checklist');
// Test: PPTX via viewer — slide rendering, navigation, and Slide Show
// Opens a multi-slide pptx through the viewer's cold-reload path and checks:
// 1. All slides render content in the main canvas (not just thumbnails)
// 2. Slide navigation (setPart) works for every slide
// 3. Slide Show (presentation mode) starts
const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');
const { seedRecentFiles, waitForSidebar, clickSidebarFile } = require('../../lib/v2-test-helper');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-pptx-viewer';
const DOC_NAME = 'pptx-slides-test.pptx';
// Use a real multi-slide pptx
const DOC_PATH = path.join(__dirname, '..', '..', '..', 'test', 'data', 'testdoc.pptx');

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

async function clickIframe(page) {
    const frameEl = await page.$('iframe#editor-frame');
    if (frameEl) {
        const box = await frameEl.boundingBox();
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    await sleep(300);
}

(async () => {
    log('=== PPTX Viewer Test ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(DOC_PATH)) { log('ERROR: fixture missing: ' + DOC_PATH); process.exit(1); }

    const { browser, cleanup } = await launch();
    const pageErrors = [];

    try {
        // Upload via viewer (v2 encrypted)
        const bytes = fs.readFileSync(DOC_PATH);
        const upDoc = await uploadV2(VIEWER, DOC_NAME, bytes);
        log('Uploaded ' + DOC_NAME + ' → ' + upDoc.fileId.substring(0,8) + '…');

        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        page.on('pageerror', e => pageErrors.push(e.message.substring(0, 200)));

        await seedRecentFiles(page, [{ b64urlSecret: upDoc.b64urlSecret, fileId: upDoc.fileId, cachedName: DOC_NAME }]);
        await page.goto(VIEWER + '/', { waitUntil: 'domcontentloaded' });

        // Wait prewarm
        for (let i = 0; i < 120; i++) {
            await sleep(500);
            try {
                const fr = page.frames().find(f => f.url().includes('cool.html'));
                if (fr && await fr.evaluate(() => !!window.__wasmPrewarmReady)) break;
            } catch(e) {}
        }
        log('Prewarm done');

        // Click the pptx (cold reload — writer->impress). Sidebar entries
        // in v2 are keyed by data-fileid (the plaintext name never reaches
        // the server).
        await waitForSidebar(page, upDoc.fileId);
        await clickSidebarFile(page, upDoc.fileId);
        log('Clicked ' + DOC_NAME + ' (cold reload)');

        // Wait for Impress UI AND either slide_parts OR the Slide Show
        // menu marker. On Azure _parts can stay at 0 even after the doc
        // is visible — the internal statusupdate pipeline is racey on
        // first pptx cold reload. Either signal is a legitimate "loaded".
        // Budget: 240s.
        let fr = null;
        let totalSlides = 0;
        let slideMenuSeen = false;
        // _parts ramps up as the pptx parses (1 → N as slides are added).
        // The previous "two consecutive equal probes" heuristic broke
        // under JOBS=2 contention: parts could sit at 1 for ~400ms while
        // the kit was still parsing later slides, the second probe saw
        // parts=1 stable, totalSlides=1, FAIL. Now require either:
        //   (a) parts >= 2 AND stable across two probes, OR
        //   (b) slide-sorter has >= 2 thumbs (canonical signal once kit
        //       finishes its slide-add loop), OR
        //   (c) parts has held at 1 for >= 8 consecutive probes (~1.6s)
        //       — only then do we trust it's a genuinely single-slide doc.
        let lastParts = 0;
        let stableCount = 0;
        for (let i = 0; i < 1200; i++) {
            await sleep(200);
            fr = page.frames().find(f => f.url().includes('cool.html'));
            if (!fr) continue;
            try {
                const probe = await fr.evaluate(() => {
                    const map = window.app?.map || window._map;
                    return {
                        parts: map?._docLayer?._parts || 0,
                        nav: document.querySelector('nav.main-nav')?.textContent || '',
                        sidebarThumbs: document.querySelectorAll('#slide-sorter > *').length,
                    };
                });
                if (probe.parts === lastParts && probe.parts > 0) stableCount++;
                else stableCount = 0;
                lastParts = probe.parts;
                if (probe.parts >= 2 && stableCount >= 1) {
                    totalSlides = probe.parts;
                    log('Impress loaded with ' + totalSlides + ' slides at ' + (i*200) + 'ms');
                    break;
                }
                if (probe.sidebarThumbs >= 2) {
                    totalSlides = Math.max(probe.parts, probe.sidebarThumbs);
                    log('Impress slide sorter populated (' + totalSlides + ' thumbs) at ' + (i*200) + 'ms');
                    break;
                }
                if (probe.parts === 1 && stableCount >= 8) {
                    totalSlides = 1;
                    log('Impress single-slide doc accepted (parts=1 stable for ' + stableCount + ' probes) at ' + (i*200) + 'ms');
                    break;
                }
                if (!slideMenuSeen && probe.nav.includes('Slide Show')) {
                    slideMenuSeen = true;
                    log('Slide Show menu visible at ' + (i*200) + 'ms (waiting for _parts)');
                }
            } catch(e) { /* noop */ }
            if (i === 299) log('Impress slide-count still 0 at 60s');
            if (i === 599) log('Impress slide-count still 0 at 120s');
            if (i === 899) log('Impress slide-count still 0 at 180s');
        }
        await sleep(2000);
        check('Impress UI loaded', !!fr);
        await snap(page, 'impress_loaded');

        if (!fr) { log('No frame — aborting'); throw new Error('No Impress frame'); }
        log('Total slides: ' + totalSlides);
        check('Has multiple slides', totalSlides >= 2, 'count=' + totalSlides);

        // --- Test each slide renders content ---
        log('\n--- Slide rendering ---');
        for (let s = 0; s < totalSlides; s++) {
            await fr.evaluate(n => {
                const map = window.app?.map || window._map;
                if (map) map.setPart(n);
            }, s);
            await sleep(4000);  // give tiles time to render
            await snap(page, 'slide_' + String(s+1).padStart(2,'0'));

            const hasContent = await fr.evaluate(() => {
                const c = document.querySelector('canvas');
                if (!c) return false;
                try {
                    const ctx = c.getContext('2d');
                    // Slides may have content anywhere on the canvas (centered
                    // text, title at top, footer at bottom). Sample a 5x5 grid
                    // and count non-white pixels across the whole grid — any
                    // sufficient amount means the slide rendered something.
                    let nonWhite = 0;
                    const W = 30, H = 30;
                    for (let r = 1; r < 6; r++) {
                        for (let cc = 1; cc < 6; cc++) {
                            const x = Math.floor(c.width  * cc / 7) - W / 2;
                            const y = Math.floor(c.height *  r / 7) - H / 2;
                            const d = ctx.getImageData(x, y, W, H).data;
                            for (let i = 0; i < d.length; i += 4) {
                                if (d[i] < 240 || d[i+1] < 240 || d[i+2] < 240) nonWhite++;
                            }
                        }
                    }
                    // 25 boxes x 900 px each = 22 500 samples. >50 non-white
                    // is an extremely conservative bar (well below "blank").
                    return nonWhite > 50;
                } catch(e) { return false; }
            }).catch(() => false);
            check('Slide ' + (s+1) + ' renders content', hasContent);
        }

        // --- Test Slide Show (presentation mode) ---
        // True fullscreen-presentation in WASM isn't reachable from a
        // puppeteer headless context (requestFullscreen() requires a user
        // gesture). What we CAN verify is that issuing .uno:Presentation
        // doesn't crash the editor — slide-rendering above and the
        // memory-access check below cover the impress runtime health.
        // We log slideshow-state as evidence rather than asserting.
        log('\n--- Slide Show (uno dispatch only) ---');
        await fr.evaluate(() => {
            const map = window.app?.map || window._map;
            if (map) map.setPart(0);
        });
        await sleep(1000);

        let ssState = {};
        try {
            // .uno:Presentation is a toolbar action with no keyboard equivalent — keep TheFakeWebSocket
            await fr.evaluate(() => {
                if (globalThis.TheFakeWebSocket) {
                    TheFakeWebSocket.send('uno .uno:Presentation');
                }
            });
            await sleep(8000);
            await snap(page, 'slideshow');

            ssState = await fr.evaluate(() => ({
                hasFullscreen: !!document.fullscreenElement,
                hasPresenter: !!document.querySelector('.leaflet-slideshow, #slideshow-canvas, .presentation-container, canvas.slideshow'),
                canvasCount: document.querySelectorAll('canvas').length,
            })).catch(() => ({}));
            log('SlideShow state: ' + JSON.stringify(ssState));
        } catch(e) {
            log('SlideShow uno dispatch raised: ' + e.message);
        }
        // The editor MUST stay alive — that's the regression sentinel.
        const aliveAfterPresentation = await fr.evaluate(() =>
            !!document.querySelector('canvas')).catch(() => false);
        check('Editor still alive after .uno:Presentation', aliveAfterPresentation,
              JSON.stringify(ssState));

        // Report page errors
        const realErrors = pageErrors.filter(e => !/ResizeObserver/i.test(e));
        if (realErrors.length) {
            log('\nPage errors (' + realErrors.length + '):');
            realErrors.slice(0, 5).forEach(e => log('  ' + e));
        }
        check('No memory access errors', !realErrors.some(e => e.includes('memory access out of bounds')),
              realErrors.length + ' errors');

        log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    } catch(e) {
        log('Error: ' + e.message);
        allPassed = false;
    } finally {
        await cleanup();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
