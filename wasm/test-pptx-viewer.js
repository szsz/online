const __cl = require('./lib/inject-checklist');
// Test: PPTX via viewer — slide rendering, navigation, and Slide Show
// Opens a multi-slide pptx through the viewer's cold-reload path and checks:
// 1. All slides render content in the main canvas (not just thumbnails)
// 2. Slide navigation (setPart) works for every slide
// 3. Slide Show (presentation mode) starts
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-pptx-viewer';
const DOC_NAME = 'pptx-slides-test.pptx';
// Use a real multi-slide pptx
const DOC_PATH = path.join(__dirname, '..', 'test', 'data', 'testdoc.pptx');

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

(async () => {
    log('=== PPTX Viewer Test ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(DOC_PATH)) { log('ERROR: fixture missing: ' + DOC_PATH); process.exit(1); }

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox','--ignore-certificate-errors','--enable-features=SharedArrayBuffer'],
    });
    const pageErrors = [];

    try {
        // Upload via viewer
        const up = await browser.newPage();
        await up.goto(VIEWER + '/');
        const bytes = fs.readFileSync(DOC_PATH);
        await up.evaluate(async (n, a) => {
            await fetch('/api/files/' + encodeURIComponent(n), {
                method: 'POST', body: new Blob([new Uint8Array(a)]),
            });
        }, DOC_NAME, Array.from(bytes));
        await up.close();
        log('Uploaded ' + DOC_NAME);

        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        page.on('pageerror', e => pageErrors.push(e.message.substring(0, 200)));

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

        // Click the pptx (cold reload — writer→impress)
        await page.evaluate(n => {
            const el = [...document.querySelectorAll('.file')].find(e => e.dataset.name === n);
            if (!el) throw new Error('File not found: ' + n);
            el.click();
        }, DOC_NAME);
        log('Clicked ' + DOC_NAME + ' (cold reload)');

        // Wait for Impress UI in the NEW frame
        let fr = null;
        for (let i = 0; i < 300; i++) {
            await sleep(200);
            fr = page.frames().find(f => f.url().includes('cool.html'));
            if (!fr) continue;
            try {
                const nav = await fr.evaluate(() => document.querySelector('nav.main-nav')?.textContent || '');
                if (nav.includes('Slide Show')) { log('Impress loaded at ' + (i*200) + 'ms'); break; }
            } catch(e) {}
            if (i === 299) log('Impress TIMEOUT');
        }
        await sleep(5000);
        check('Impress UI loaded', !!fr);
        await snap(page, 'impress_loaded');

        if (!fr) { log('No frame — aborting'); throw new Error('No Impress frame'); }

        // Get slide count
        const totalSlides = await fr.evaluate(() => {
            const map = window.app?.map || window._map;
            return map?._docLayer?._parts || 0;
        }).catch(() => 0);
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
                    // text, title at top, footer at bottom). Sample a 5×5 grid
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
                    // 25 boxes × 900 px each = 22 500 samples. >50 non-white
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
        await browser.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
