// test-cv-regression-spellcheck-squiggle.js — red spell-error squiggle
// actually paints on the document canvas (task #196, LO PR #12 inftxt.cxx
// OnWin/LOK gate).
//
// Before the LO fix: the probe reported redPx: 0 even with dict-loader
// confirmed loading Hunspell .dic/.aff into Module.FS and
// .uno:SpellOnline=true in renderOptsObj — the paint gate at inftxt.cxx:687
// suppressed the squiggle in LOK tile mode because OnWin() was false.
//
// What this asserts (identical to the legacy version):
//   1. Open mixed-lang-paragraphs.docx (en-US/de-DE/fr-FR paragraphs) via
//      the content-viewer tester.
//   2. Wait for editor frame + doc paint.
//   3. Click at top of doc (English paragraph), type "Schmettrling fhsdkj
//      qweryt" (three deliberate misspellings).
//   4. Wait for the spell daemon to scan + tile re-render.
//   5. Sample canvas pixels in a 1200x140 band around the cursor row and
//      assert >= 30 red squiggle-signature pixels (r>150, g<90, b<90).
//
// Migrated from wasm/tests/regression/test-regression-spellcheck-squiggle.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-spellcheck-squiggle.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, waitCvInteractive, cvEditorFrame } =
    require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data',
                          'mixed-lang-paragraphs.docx');
const SHOT_DIR = '/tmp/content-viewer-report/regression-spellcheck-squiggle';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const MIN_RED_PIXELS = 30;

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

(async () => {
    log('=== CV regression: red spell squiggle paints on canvas ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
    log('viewer: ' + BASE);

    const { browser } = await launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        // English primary dict preload (legacy ran Chrome with --lang=en-US).
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'languages',
                { get: () => ['en-US', 'en'], configurable: true });
            Object.defineProperty(navigator, 'language',
                { get: () => 'en-US', configurable: true });
        });

        // Capture iframe console (including fprintf(stderr) routed through
        // emscripten → console.error) — the lok-spell-paint diagnostic at the
        // OnWin paint gate shows WHY 0 red pixels were observed.
        const consoleLines = [];
        page.on('console', m => {
            const t = m.text();
            consoleLines.push(`[${m.type()}] ${t}`);
            if (/lok-spell-paint|lok-193-|spell|hunspell|wrongl/i.test(t)) {
                log(`  iframe ${m.type()}: ${t.slice(0, 160)}`);
            }
        });
        page.on('pageerror', e => consoleLines.push(`[pageerror] ${e.message}`));

        log('open mixed-lang docx via /collabora-tester');
        await openViaContentViewer(browser, BASE, FIXTURE,
            { page, viewport: { width: 1600, height: 1000 }, iframeTimeout: 45000 });
        check('editor became interactive (Save enabled)',
              await waitCvInteractive(page, LOAD_BUDGET));
        const frame = cvEditorFrame(page);
        check('editor frame reachable', !!frame, frame ? 'ok' : '(none)');
        if (!frame) throw new Error('no editor frame');

        await sleep(14000); // doc paint + primary dict + spell daemon warm-up
        await page.screenshot({ path: `${SHOT_DIR}/01_doc_loaded.png` });

        // Type three deliberate misspellings at top of doc (English context).
        const canvas = await frame.$('#document-canvas');
        check('#document-canvas present', !!canvas);
        if (!canvas) throw new Error('no #document-canvas');

        await canvas.click({ offset: { x: 200, y: 200 } });
        await sleep(800);
        await page.keyboard.type(' Schmettrling fhsdkj qweryt ', { delay: 60 });
        log('typed misspellings; waiting for spell daemon');
        await sleep(6000);
        await page.screenshot({ path: `${SHOT_DIR}/02_after_type.png` });

        // Sample canvas red pixels in the band where the cursor sits. The
        // band is canvas-local (getImageData), so it is unaffected by where
        // the iframe sits on the page.
        const redScan = await frame.evaluate(() => {
            const canvas = document.getElementById('document-canvas');
            if (!canvas) return { error: 'no canvas' };
            const ctx = canvas.getContext('2d');
            let redPx = 0, totalPx = 0;
            try {
                // Horizontal band 140px tall around the typed word row
                // (~y=200-300 in canvas-local coords), wide to be tolerant
                // of line-wrap.
                const data = ctx.getImageData(100, 180, 1200, 140).data;
                for (let i = 0; i < data.length; i += 4) {
                    const r = data[i], g = data[i + 1], b = data[i + 2];
                    // Squiggle is roughly RGB ~(220, 50, 50) — strict
                    // detection so the test doesn't false-positive on dark
                    // gray text or red-tinted UI chrome.
                    if (r > 150 && g < 90 && b < 90) redPx++;
                    totalPx++;
                }
            } catch (e) {
                return { error: e.message };
            }
            return { redPx, totalPx };
        });
        log(`red-pixel scan: ${JSON.stringify(redScan)}`);
        await page.screenshot({ path: `${SHOT_DIR}/03_after_scan.png` });

        check(
            `canvas carries >= ${MIN_RED_PIXELS} red-spell-squiggle pixels`,
            (redScan.redPx || 0) >= MIN_RED_PIXELS,
            `observed redPx=${redScan.redPx} totalPx=${redScan.totalPx}`
        );

        // Surface the lok-spell-paint diag lines so the report shows WHY 0
        // red pixels were observed. Always dumps — passing or failing.
        const paintLines = consoleLines.filter(l => /lok-spell-paint/.test(l));
        log(`captured ${paintLines.length} lok-spell-paint lines from iframe`);
        paintLines.slice(0, 12).forEach(l => log(`  ${l}`));
        if (paintLines.length === 0) {
            const spellish = consoleLines.filter(l => /spell|wrongl|hunspell/i.test(l));
            log(`no lok-spell-paint lines; ${spellish.length} other spell-related lines`);
            spellish.slice(0, 8).forEach(l => log(`  ${l}`));
        }
        fs.writeFileSync(`${SHOT_DIR}/iframe-console.log`, consoleLines.join('\n'));
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
