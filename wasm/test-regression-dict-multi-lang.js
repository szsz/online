// Regression: dict-loader.js supports loading multiple language
// dictionaries concurrently AND short-circuits a redundant fetch for
// any language already written to Module.FS.
//
// Background (task #196): the editor today preloads ONE dict at
// startup based on navigator.language. The reactive
// `window.loadDictionary(lang)` API can fetch additional bundles
// on demand, but until iter 42 there was no idempotency tracking —
// calling loadDictionary('fr') twice would re-fetch + re-write the
// 2-5 MB bundle each time. A multi-language document (paragraphs
// in en/de/fr) firing a loadDictionary call per paragraph locale
// event would multiply network + FS work.
//
// What this test asserts:
//   1. Editor loads with the navigator.language primary preloaded
//      (state.primaryLang is set, state.loaded[primary] === true).
//   2. window.loadDictionary('de') fetches + installs the German
//      bundle; state.loaded['de'] is set; { lang: 'de' } returned
//      WITHOUT { cached: true }.
//   3. Calling window.loadDictionary('de') a SECOND time short-
//      circuits — returns { lang: 'de', cached: true } without
//      re-fetching (verified by comparing performance.getEntries()
//      'de.tar.gz' fetch count before/after).
//   4. window.loadDictionary('fr') for a different lang fetches +
//      installs; state.loaded gains 'fr' as a third entry.
//   5. Module.FS has the expected /instdir/share/dict/<file> after
//      <lang>/ directory for each loaded language with at least
//      one file inside (the .dic).
//
// Runtime: ~30-60s. Single browser, no co-edit, no document open
// (just a viewer loading cool.html in iframe-only mode is enough
// to exercise dict-loader).

'use strict';

const fs = require('fs');
const puppeteer = require('puppeteer');
const env = require('./lib/test-env');
const __cl = require('./lib/inject-checklist');

const VIEWER  = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-dict-multi-lang';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0    = Date.now();
const log   = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  PASS: ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}`, fullPage: false }); }
    catch (_) {}
}

async function waitForEditorFrame(page, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const frame = page.frames().find(f => f.url().includes('cool.html'));
        if (frame) {
            const have = await frame.$('#document-canvas').catch(() => null);
            if (have) return frame;
        }
        await sleep(500);
    }
    return null;
}

(async () => {
    log('=== Regression: dict-loader multi-language reactive load ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Pin navigator.language so the primary preload picks a
    // predictable code (English) — the test exercises ADDING
    // German + French on top.
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'languages',
            { get: () => ['en-US', 'en'], configurable: true });
        Object.defineProperty(navigator, 'language',
            { get: () => 'en-US', configurable: true });
    });

    try {
        await page.goto(`${VIEWER}/?singleuser`,
            { waitUntil: 'domcontentloaded',
              timeout: env.scaleTimeout(60000) });
        await sleep(2500);

        const editor = await waitForEditorFrame(page, env.scaleTimeout(120000));
        check('editor frame reachable', !!editor, editor ? 'ok' : '(none)');
        if (!editor) process.exit(allPassed ? 0 : 1);
        await sleep(4000); // settle for primary dict preload

        await snap(page, 'editor_loaded');

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
        if (!initialState) process.exit(allPassed ? 0 : 1);
        check('primary lang preloaded (state.primaryLang set)',
              !!initialState.primaryLang,
              `primaryLang=${initialState.primaryLang}`);
        check('primary lang in state.loaded set',
              initialState.loaded.includes(initialState.primaryLang),
              `loaded=[${initialState.loaded.join(',')}]`);

        // Load German dict reactively. Must be a lang that's not
        // the primary AND not already loaded.
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

        // Verify the FS write happened. After the EMSCRIPTEN DICPATH
        // switch (LO #26 + this online change), dict-loader writes
        // only the data files (.dic/.aff/.dat/.idx) into the flat
        // /instdir/share/dict/ that LO's lingucomponent scans on
        // startup — not the per-lang extension dir.
        const fsHas1 = await editor.evaluate((lang) => {
            try {
                const dir = '/instdir/share/dict';
                const all = window.Module && window.Module.FS
                    ? window.Module.FS.readdir(dir).filter(n => n !== '.' && n !== '..')
                    : [];
                // Match leaf names that look like spell/hyph/thes data
                // for this lang. Hunspell uses e.g. en_US.dic; underscore.
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
        log(`ERROR: ${e.message}`);
        check('test ran without exceptions', false, e.message);
    } finally {
        try { await page.close(); } catch (_) {}
        try { await ctx.close(); } catch (_) {}
        try { await browser.close(); } catch (_) {}
    }

    process.exit(allPassed ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
