// test-cv-regression-dict-locale-resolve.js — dict-loader's
// loadDictionaryForLocale resolves a BCP 47 runtime locale tag to whatever
// the manifest actually ships, then dispatches via the idempotent
// loadDictionary().
//
// Background (task #196 / iter 43): the editor's StatusBar emits a
// .uno:LanguageStatus state-change every time the cursor enters a paragraph
// with a different language. StatusBar calls loadDictionaryForLocale(<BCP-47>)
// on each event so paragraphs in mixed-language docs trigger their dictionary
// on focus. Without the resolver, a literal "fr-CA" lookup in dict-loader's
// manifest would miss "fr_FR" (the only French-region dict shipped) and
// spellcheck would silently disable.
//
// What this test asserts (identical to the legacy version):
//   1. window.loadDictionaryForLocale is exported.
//   2. Exact lowercase match: 'en' → manifest 'en'.
//   3. Primary-tag fallthrough: 'en-US' → primary 'en' → manifest 'en'.
//   4. Region-prefix match: 'fr-CA' → primary 'fr' → manifest 'fr_FR'.
//   5. Underscore separator: 'de_DE'/'de_AT' → primary 'de' → manifest 'de'.
//   6. Unknown locale: 'xx-YY' → resolves with { skipped: 'no-manifest-match' }.
//   7. Empty input: '' → resolves with { skipped: 'empty-locale' }.
//
// Migrated from wasm/tests/regression/test-regression-dict-locale-resolve.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-dict-locale-resolve.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, waitCvInteractive, cvEditorFrame } =
    require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOCX = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/regression-dict-locale-resolve';
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
    log('=== CV regression: loadDictionaryForLocale BCP 47 resolver ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    if (!fs.existsSync(DOCX)) { check('fixture present', false, DOCX); process.exit(2); }
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

        log('open writer via /collabora-tester');
        await openViaContentViewer(browser, BASE, DOCX, { page, iframeTimeout: 45000 });
        check('editor became interactive (Save enabled)',
              await waitCvInteractive(page, LOAD_BUDGET));
        await sleep(5000); // settle for primary dict preload
        const editor = cvEditorFrame(page);
        check('editor frame reachable', !!editor, editor ? 'ok' : '(none)');
        await snap(page, 'editor_loaded');
        if (!editor) throw new Error('no editor frame');

        // Resolver must be exported.
        const exported = await editor.evaluate(() =>
            typeof window.loadDictionaryForLocale === 'function');
        check('window.loadDictionaryForLocale exported',
              exported, `typeof=${exported ? 'function' : 'missing'}`);
        if (!exported) throw new Error('resolver missing');

        // Manifest sanity.
        const manifest = await editor.evaluate(() =>
            (window.__dictLoader && window.__dictLoader.manifest) || []);
        check('manifest non-empty', manifest.length > 0,
              `${manifest.length} entries`);
        const has = (lang) =>
            manifest.some(e => e.lang.toLowerCase() === lang.toLowerCase());

        // Build the case set based on what's in the manifest. The manifest
        // content varies by build (build-dicts.sh DEFAULT_LANGS); skip cases
        // whose target lang isn't shipped.
        const cases = [];
        if (has('en')) {
            cases.push(['en',     'en',    'exact lowercase match'         ]);
            cases.push(['en-US',  'en',    'primary-tag fallthrough en-US' ]);
            cases.push(['en_US',  'en',    'underscore separator en_US'    ]);
        }
        if (has('de')) {
            cases.push(['de',     'de',    'exact de'                      ]);
            cases.push(['de-DE',  'de',    'de-DE → de'                    ]);
            cases.push(['de_AT',  'de',    'de_AT (Austrian) → de'         ]);
        }
        if (has('fr_FR')) {
            cases.push(['fr-FR', 'fr_FR',  'fr-FR exact (lowercased eq)'   ]);
            cases.push(['fr-CA', 'fr_FR',  'fr-CA region-prefix → fr_FR'   ]);
            cases.push(['fr',    'fr_FR',  'bare fr → region-prefix fr_FR' ]);
        }
        if (has('pt_BR') && has('pt_PT')) {
            // pt-BR exact lowercase match wins over pt_PT.
            cases.push(['pt-BR', 'pt_BR',  'pt-BR exact'                   ]);
        }

        for (const [input, expectedLang, label] of cases) {
            const got = await editor.evaluate(async (loc) => {
                const r = await window.loadDictionaryForLocale(loc);
                return r;
            }, input);
            check(`resolveLocale('${input}') → manifest '${expectedLang}' (${label})`,
                  got && got.lang === expectedLang,
                  JSON.stringify(got));
        }

        // Unknown locale must resolve, not reject.
        const unknown = await editor.evaluate(async () =>
            await window.loadDictionaryForLocale('xx-YY'));
        check("resolveLocale('xx-YY') resolves with skipped:no-manifest-match",
              unknown && unknown.skipped === 'no-manifest-match',
              JSON.stringify(unknown));

        // Empty input.
        const emptyR = await editor.evaluate(async () =>
            await window.loadDictionaryForLocale(''));
        check("resolveLocale('') resolves with skipped:empty-locale",
              emptyR && emptyR.skipped === 'empty-locale',
              JSON.stringify(emptyR));

        await snap(page, 'after_resolver_cases');
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
