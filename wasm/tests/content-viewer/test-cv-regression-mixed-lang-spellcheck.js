// test-cv-regression-mixed-lang-spellcheck.js — paragraph-language change →
// reactive dict load wiring (task #196 / iter 44). E2E against a docx fixture
// with three paragraphs tagged en-US / de-DE / fr-FR.
//
// What this asserts (identical to the legacy version):
//   1. Open test/data/mixed-lang-paragraphs.docx via the content-viewer.
//   2. Editor primary preload runs (English, since pinned navigator).
//   3. Click into the German paragraph → .uno:LanguageStatus state-change →
//      window.__dictLoader.loaded gains 'de'.
//   4. Click into the French paragraph → state.loaded gains 'fr_FR' (the
//      manifest's region-prefix match for the bare 'fr' primary tag).
//   5. Click back into the English paragraph → no new dict fetch (English
//      already loaded as primary).
//
// This locks the wiring end-to-end: the LanguageStatus event flows from
// kit → COOL state-change handler → dict-loader resolver → idempotent
// loadDictionary, all observable from outside the editor iframe via
// __dictLoader and performance.getEntries.
//
// Out-of-scope (separate test): asserting that LO actually flags typos —
// this test pins the dict-load PLUMBING.
//
// Migrated from wasm/tests/regression/test-regression-mixed-lang-spellcheck.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-mixed-lang-spellcheck.js [base-url]

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
const SHOT_DIR = '/tmp/content-viewer-report/regression-mixed-lang-spellcheck';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const DICT_WAIT = 20000; // cursor click → LanguageStatus → dict fetch chain

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
let shotN = 0;
async function snap(page, name) {
    try { fs.mkdirSync(SHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${SHOT_DIR}/${String(++shotN).padStart(2, '0')}_${name}.png` }); } catch (e) {}
}

// Helper: wait until window.__dictLoader.loaded contains `lang`. Polled
// because the click → LanguageStatus → loadDictionary → fetch chain takes
// hundreds of ms.
async function waitForLoadedLang(frame, lang, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const has = await frame.evaluate((l) =>
            !!(window.__dictLoader && window.__dictLoader.loaded[l]),
            lang).catch(() => false);
        if (has) return true;
        await sleep(250);
    }
    return false;
}

// Click at a doc-relative percentage inside the canvas to land the cursor
// in a specific paragraph. The fixture has three paragraphs stacked
// vertically. In the CV the editor iframe does NOT fill the page (the
// tester toolbar sits above it), so page coords = iframe origin + in-frame
// canvas rect.
async function clickInCanvas(page, frame, fractionDown) {
    const box = await frame.evaluate(() => {
        const c = document.getElementById('document-canvas');
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return { x: r.x | 0, y: r.y | 0, w: r.width | 0, h: r.height | 0 };
    });
    if (!box) throw new Error('no #document-canvas in frame');
    const el = await page.$('iframe');
    const fbox = el && await el.boundingBox();
    if (!fbox) throw new Error('no editor iframe on page');
    const px = fbox.x + box.x + Math.floor(box.w / 4);
    const py = fbox.y + box.y + Math.floor(box.h * fractionDown);
    await page.mouse.click(px, py);
}

(async () => {
    log('=== CV regression: mixed-language paragraph spellcheck wiring ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    if (!fs.existsSync(FIXTURE)) { check('fixture present', false, FIXTURE); process.exit(2); }
    log('viewer: ' + BASE);

    const { browser } = await launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'languages',
                { get: () => ['en-US', 'en'], configurable: true });
            Object.defineProperty(navigator, 'language',
                { get: () => 'en-US', configurable: true });
        });

        log('open mixed-lang docx via /collabora-tester');
        await openViaContentViewer(browser, BASE, FIXTURE,
            { page, viewport: { width: 1280, height: 900 }, iframeTimeout: 45000 });
        check('editor became interactive (Save enabled)',
              await waitCvInteractive(page, LOAD_BUDGET));
        await sleep(6000); // settle for primary dict + doc load
        const frame = cvEditorFrame(page);
        check('editor frame reachable', !!frame, frame ? 'ok' : '(none)');
        await snap(page, 'doc_loaded');
        if (!frame) throw new Error('no editor frame');

        const initial = await frame.evaluate(() => ({
            primary: window.__dictLoader && window.__dictLoader.primaryLang,
            loaded: window.__dictLoader
                ? Object.keys(window.__dictLoader.loaded) : [],
            hasResolver: typeof window.loadDictionaryForLocale === 'function',
        }));
        check('window.loadDictionaryForLocale exported (iter 43)',
              initial.hasResolver, JSON.stringify(initial));
        check('primary English dict already loaded',
              initial.loaded.includes(initial.primary || 'en'),
              `loaded=[${initial.loaded.join(',')}]`);
        if (!initial.hasResolver) throw new Error('resolver missing');

        // Click into the GERMAN paragraph. Empirically the fixture's
        // paragraph layout puts German in the ~35-45% vertical band
        // (English wraps to a short line at the top, then German wraps
        // 2-3 lines, then French wraps 2 lines).
        log('clicking into German paragraph');
        await clickInCanvas(page, frame, 0.40);
        await sleep(2000);
        await snap(page, 'after_click_german_paragraph');

        const gotDe = await waitForLoadedLang(frame, 'de', DICT_WAIT);
        check('loadDictionary fired for German (de) after cursor entry',
              gotDe, gotDe ? 'ok' : 'timed out — LanguageStatus → dict chain broken?');

        // Click into the FRENCH paragraph (~83%).
        log('clicking into French paragraph');
        await clickInCanvas(page, frame, 0.83);
        await sleep(500);
        await snap(page, 'after_click_french_paragraph');

        // 'fr-FR' resolves to manifest 'fr_FR' via the resolver.
        const gotFr = await waitForLoadedLang(frame, 'fr_FR', DICT_WAIT);
        check('loadDictionary fired for French (fr_FR) after cursor entry',
              gotFr, gotFr ? 'ok' : 'timed out');

        // Click back into ENGLISH paragraph — must NOT trigger a new fetch
        // (English already loaded as primary).
        log('clicking back into English paragraph');
        const fetchesBefore = await frame.evaluate(() =>
            performance.getEntriesByType('resource')
                .filter(e => /\/dicts\/(en|de|fr)/.test(e.name))
                .length);
        await clickInCanvas(page, frame, 0.20);
        await sleep(2000);
        const fetchesAfter = await frame.evaluate(() =>
            performance.getEntriesByType('resource')
                .filter(e => /\/dicts\/(en|de|fr)/.test(e.name))
                .length);
        check('clicking into English paragraph triggers no new dict fetch',
              fetchesAfter === fetchesBefore,
              `before=${fetchesBefore} after=${fetchesAfter}`);

        const final = await frame.evaluate(() =>
            Object.keys(window.__dictLoader.loaded).sort());
        check('state.loaded ends up with 3 entries (en + de + fr_FR)',
              final.length >= 3,
              `loaded=[${final.join(',')}]`);
        await snap(page, 'final_state');
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
