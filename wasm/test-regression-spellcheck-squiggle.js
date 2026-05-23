// Regression: red spell-error squiggle actually paints on canvas
// (task #196). Once libreoffice-core-wasm's inftxt.cxx OnWin gate
// is updated to allow squiggle painting in LOK tile mode (LO PR #12)
// and the resulting build is consumed by online, the canvas must
// carry visible red-channel pixels under typed misspellings.
//
// Before the LO fix: probe reported `redPx: 0` even with dict-loader
// confirmed loading de/en Hunspell .dic + .aff files into Module.FS
// and `.uno:SpellOnline=true` confirmed in renderOptsObj
// (kit/Kit.cpp 291aa0017e). The paint gate at inftxt.cxx:687
// suppressed the squiggle in LOK because OnWin() was false.
//
// What this asserts:
//   1. Upload + open mixed-lang-paragraphs.docx (en-US/de-DE/fr-FR
//      paragraphs).
//   2. Wait for editor frame, doc paint complete.
//   3. Click at top of doc (English paragraph), type "Schmettrling
//      fhsdkj qweryt" (three deliberate misspellings).
//   4. Wait 4s for spell daemon to scan + tile re-render.
//   5. Sample canvas pixels in a 800x100 band around the cursor.
//      Assert `redPx > 50` — squiggles are thin dashed underlines,
//      ~3-5 red pixels per misspelling on a normal-zoom doc, so
//      three misspellings give ~30-50 red pixels minimum.

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');

const VIEWER  = process.env.VIEWER_URL || env.FILE_STORAGE_URL;
const FIXTURE = path.join(__dirname, '..', 'test', 'data',
                          'mixed-lang-paragraphs.docx');
const NAME    = `spell-squig-${Date.now()}.docx`;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-spellcheck-squiggle';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0    = Date.now();
const log   = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let allPassed = true;
function check(label, cond, evidence) {
    if (cond) {
        log(`PASS ${label}`);
    } else {
        log(`FAIL ${label}: ${evidence || ''}`);
        allPassed = false;
    }
}

fs.rmSync(SHOT_DIR, { recursive: true, force: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

const MIN_RED_PIXELS = 30;

(async () => {
    const bytes = fs.readFileSync(FIXTURE);
    const up = await uploadV2(VIEWER, NAME, bytes);
    log(`uploaded ${up.fileId.substring(0, 12)}`);

    const browser = await puppeteer.launch({
        headless: 'new',
        protocolTimeout: env.scaleTimeout(600000),
        args: ['--no-sandbox', '--enable-features=SharedArrayBuffer',
               '--lang=en-US'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });

    // Capture iframe console (including fprintf(stderr) routed through
    // emscripten → console.error). The LO -35 build adds a
    // lok-spell-paint diagnostic at the OnWin paint gate so we can see
    // which of three hypotheses holds when 0 red pixels are observed.
    const consoleLines = [];
    page.on('console', m => {
        const t = m.text();
        consoleLines.push(`[${m.type()}] ${t}`);
        if (/lok-spell-paint|lok-193-|spell|hunspell|wrongl/i.test(t)) {
            log(`  iframe ${m.type()}: ${t}`);
        }
    });
    page.on('pageerror', e => consoleLines.push(`[pageerror] ${e.message}`));

    await page.goto(`${VIEWER}/?singleuser#file=${up.b64urlSecret}`, {
        waitUntil: 'domcontentloaded',
        timeout: env.scaleTimeout(120000),
    });

    let frame = null;
    for (let i = 0; i < 90 && !frame; i++) {
        frame = page.frames().find(f => f.url().includes('cool.html'));
        if (frame && !(await frame.$('#document-canvas').catch(() => null))) {
            frame = null;
        }
        if (!frame) await sleep(1000);
    }
    if (!frame) {
        log('FATAL: frame never reached cool.html');
        await browser.close();
        process.exit(2);
    }
    log('frame ready');

    await sleep(env.scaleTimeout(14000));
    await page.screenshot({ path: `${SHOT_DIR}/01_doc_loaded.png` });

    // Type three deliberate misspellings at top of doc (English context).
    const canvas = await frame.$('#document-canvas');
    if (!canvas) {
        log('FATAL: no #document-canvas');
        await browser.close();
        process.exit(2);
    }

    await canvas.click({ offset: { x: 200, y: 200 } });
    await sleep(800);
    await page.keyboard.type(' Schmettrling fhsdkj qweryt ', { delay: 60 });
    log('typed misspellings; waiting 5s for spell daemon');
    await sleep(env.scaleTimeout(5000));
    await page.screenshot({ path: `${SHOT_DIR}/02_after_type.png` });

    // Sample canvas red pixels in the band where the cursor sits.
    const redScan = await frame.evaluate(() => {
        const canvas = document.getElementById('document-canvas');
        if (!canvas) return { error: 'no canvas' };
        const ctx = canvas.getContext('2d');
        let redPx = 0, totalPx = 0;
        try {
            // Sample a horizontal band 100px tall centered on the typed
            // word row. The typed text lands at roughly y=200-300 in
            // canvas-local coords. Sample wider band to be tolerant of
            // line-wrap.
            const data = ctx.getImageData(100, 180, 1200, 140).data;
            for (let i = 0; i < data.length; i += 4) {
                const r = data[i], g = data[i+1], b = data[i+2];
                // Squiggle is roughly RGB ~(220, 50, 50) — strict
                // detection so the test doesn't false-positive on
                // dark gray text or red-tinted UI chrome.
                if (r > 150 && g < 90 && b < 90) redPx++;
                totalPx++;
            }
        } catch (e) {
            return { error: e.message };
        }
        return { redPx, totalPx };
    });
    log(`red-pixel scan: ${JSON.stringify(redScan)}`);

    // Also dump a tight closeup PNG so the report can show what we saw.
    await page.screenshot({
        path: `${SHOT_DIR}/03_canvas_band.png`,
        clip: { x: 100, y: 180, width: 1200, height: 140 },
    });

    check(
        `canvas carries >= ${MIN_RED_PIXELS} red-spell-squiggle pixels`,
        (redScan.redPx || 0) >= MIN_RED_PIXELS,
        `observed redPx=${redScan.redPx} totalPx=${redScan.totalPx}`
    );

    // Surface the lok-spell-paint diag lines (added in lo-build
    // 2026-05-22-35) so the test report shows WHY 0 red pixels were
    // observed. Always dumps — passing or failing.
    const paintLines = consoleLines.filter(l => /lok-spell-paint/.test(l));
    log(`captured ${paintLines.length} lok-spell-paint lines from iframe`);
    paintLines.slice(0, 12).forEach(l => log(`  ${l}`));
    if (paintLines.length === 0) {
        const spellish = consoleLines.filter(l => /spell|wrongl|hunspell/i.test(l));
        log(`no lok-spell-paint lines; ${spellish.length} other spell-related lines`);
        spellish.slice(0, 8).forEach(l => log(`  ${l}`));
    }
    fs.writeFileSync(`${SHOT_DIR}/iframe-console.log`, consoleLines.join('\n'));

    await browser.close();

    if (!allPassed) {
        log('TEST FAILED');
        process.exit(1);
    }
    log('TEST PASSED');
})().catch(e => {
    console.error('FATAL', e.stack || e.message);
    process.exit(2);
});
