// test-cv-regression-dict-multi-lang.js — dict-loader.js supports loading
// multiple language dictionaries concurrently AND short-circuits a redundant
// fetch for any language already written to Module.FS.
//
// Background (task #196): the editor preloads ONE dict at startup based on
// navigator.language. The reactive `window.loadDictionary(lang)` API fetches
// additional bundles on demand, but until iter 42 there was no idempotency
// tracking — calling loadDictionary('fr') twice re-fetched + re-wrote the
// 2-5 MB bundle each time. In the content-viewer the editor fetches dicts
// at collabora-<ver>/dicts/ through the SW — same dict-loader, same manifest.
//
// What this test asserts (identical to the legacy version):
//   1. Editor loads with the navigator.language primary preloaded
//      (state.primaryLang set, state.loaded[primary] === true).
//   2. window.loadDictionary('de') fetches + installs the German bundle;
//      state.loaded gains 'de'; result has NO { cached: true }.
//   3. A SECOND loadDictionary('de') short-circuits — returns
//      { lang: 'de', cached: true } with no new network fetch
//      (performance.getEntries resource count unchanged).
//   4. window.loadDictionary('fr_FR') for a different lang installs;
//      state.loaded reaches >= 3 entries.
//   5. Module.FS has hunspell data for the loaded lang in the flat
//      /instdir/share/dict/ that LO's lingucomponent scans.
//
// Migrated from wasm/tests/regression/test-regression-dict-multi-lang.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-dict-multi-lang.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, waitCvInteractive, cvEditorFrame } =
    require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOCX = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/regression-dict-multi-lang';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);

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

(async () => {
    log('=== CV regression: dict-loader multi-language reactive load ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    if (!fs.existsSync(DOCX)) { check('fixture present', false, DOCX); process.exit(2); }
    log('viewer: ' + BASE);

    const { browser } = await launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        // Pin navigator.language so the primary preload picks a predictable
        // code (English) — the test exercises ADDING German + French on top.
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'languages',
                { get: () => ['en-US', 'en'], configurable: true });
            Object.defineProperty(navigator, 'language',
                { get: () => 'en-US', configurable: true });
        });

        log('open writer via /collabora-tester');
        await openViaContentViewer(browser, BASE, DOCX, { page, iframeTimeout: 45000 });
        check('editor became interactive (Save enabled)',
              await waitCvInteractive(page, LOAD_BUDGET));
        await sleep(5000); // settle for primary dict preload
        const editor = cvEditorFrame(page);
        check('editor frame reachable', !!editor, editor ? 'ok' : '(none)');
        await snap(page, 'editor_loaded');
        if (!editor) throw new Error('no editor frame');

        // Read dict-loader's debug surface inside the iframe.
        const initialState = await editor.evaluate(() => {
            const s = window.__dictLoader || null;
            if (!s) return null;
            return {
                primaryLang: s.primaryLang,
                primaryWritten: s.primaryWritten,
                loaded: Object.keys(s.loaded || {}),
            };
        });
        check('window.__dictLoader debug surface present',
              !!initialState,
              initialState ? JSON.stringify(initialState) : '(null)');
        if (!initialState) throw new Error('no __dictLoader surface');
        check('primary lang preloaded (state.primaryLang set)',
              !!initialState.primaryLang,
              `primaryLang=${initialState.primaryLang}`);
        check('primary lang in state.loaded set',
              initialState.loaded.includes(initialState.primaryLang),
              `loaded=[${initialState.loaded.join(',')}]`);

        // Load German dict reactively. Must be a lang that's not the
        // primary AND not already loaded.
        const targetA = initialState.primaryLang === 'de' ? 'fr_FR' : 'de';
        log(`reactive load #1: ${targetA}`);
        const result1 = await editor.evaluate(async (lang) => {
            const r = await window.loadDictionary(lang);
            return { result: r, loaded: Object.keys(window.__dictLoader.loaded) };
        }, targetA);
        check(`reactive loadDictionary('${targetA}') resolves`,
              !!result1.result && result1.result.lang === targetA,
              JSON.stringify(result1.result));
        check(`reactive loadDictionary('${targetA}') NOT cached on first call`,
              !result1.result.cached,
              `cached=${!!result1.result.cached}`);
        check(`'${targetA}' added to state.loaded`,
              result1.loaded.includes(targetA),
              `loaded=[${result1.loaded.join(',')}]`);

        // Verify the FS write happened: dict-loader writes the data files
        // (.dic/.aff/.dat/.idx) into the flat /instdir/share/dict/ that
        // LO's lingucomponent scans on startup.
        const fsHas1 = await editor.evaluate((lang) => {
            try {
                const dir = '/instdir/share/dict';
                const all = window.Module && window.Module.FS
                    ? window.Module.FS.readdir(dir).filter(n => n !== '.' && n !== '..')
                    : [];
                const re = new RegExp('(?:^|_)' + lang + '(?:[._]|$)', 'i');
                const hits = all.filter(n => re.test(n));
                return { dir, total: all.length, hits: hits.length, sampleHit: hits[0] || null };
            } catch (e) { return { error: e.message }; }
        }, targetA);
        check(`Module.FS /instdir/share/dict/ has data for ${targetA}`,
              fsHas1.hits >= 1,
              JSON.stringify(fsHas1));

        // SECOND call to same lang — must short-circuit.
        log(`reactive load #2: ${targetA} (idempotency)`);
        const result2 = await editor.evaluate(async (lang) => {
            const before = performance.getEntriesByType('resource')
                .filter(e => e.name.includes(lang))
                .length;
            const r = await window.loadDictionary(lang);
            const after = performance.getEntriesByType('resource')
                .filter(e => e.name.includes(lang))
                .length;
            return { result: r, fetchesBefore: before, fetchesAfter: after };
        }, targetA);
        check(`second loadDictionary('${targetA}') returns cached:true`,
              result2.result && result2.result.cached === true,
              JSON.stringify(result2.result));
        check(`second loadDictionary('${targetA}') triggers no new network fetch`,
              result2.fetchesAfter === result2.fetchesBefore,
              `before=${result2.fetchesBefore} after=${result2.fetchesAfter}`);

        // Third lang — verify state grows.
        const targetB = initialState.primaryLang === 'fr_FR' ? 'es' : 'fr_FR';
        log(`reactive load #3: ${targetB}`);
        const result3 = await editor.evaluate(async (lang) => {
            const r = await window.loadDictionary(lang);
            return { result: r, loaded: Object.keys(window.__dictLoader.loaded) };
        }, targetB);
        check(`reactive loadDictionary('${targetB}') resolves`,
              !!result3.result && result3.result.lang === targetB,
              JSON.stringify(result3.result));
        check(`state.loaded now contains primary + '${targetA}' + '${targetB}'`,
              result3.loaded.length >= 3,
              `loaded=[${result3.loaded.join(',')}]`);

        await snap(page, 'after_three_dicts_loaded');
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
