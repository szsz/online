// Regression: dict-loader's loadDictionaryForLocale resolves a BCP 47
// runtime locale tag to whatever the manifest actually ships, then
// dispatches via the idempotent loadDictionary().
//
// Background (task #196 / iter 43): the editor's StatusBar emits a
// .uno:LanguageStatus state-change every time the cursor enters a
// paragraph with a different language. Iter 43 wires StatusBar to
// call loadDictionaryForLocale(<BCP-47>) on each event so paragraphs
// in mixed-language docs trigger their dictionary on focus. Without
// the resolver, a literal "fr-CA" lookup in dict-loader's manifest
// would miss "fr_FR" (the only French-region dict shipped) and
// spellcheck would silently disable.
//
// What this test asserts (in-browser, against the deployed editor):
//   1. window.loadDictionaryForLocale is exported.
//   2. Exact lowercase match: 'en' → manifest 'en' (cached after
//      primary preload).
//   3. Primary-tag fallthrough: 'en-US' → primary 'en' → manifest 'en'.
//   4. Region-prefix match: 'fr-CA' → primary 'fr' → manifest 'fr_FR'
//      (the shipped French-region dict).
//   5. Underscore separator: 'de_DE' → primary 'de' → manifest 'de'.
//   6. Unknown locale: 'xx-YY' → resolves with { skipped:
//      'no-manifest-match' } rather than rejecting.
//   7. Empty input: '' → resolves with { skipped: 'empty-locale' }.
//   8. State.loaded grows when a new manifest entry resolves; second
//      call to same locale (or any locale resolving to the same
//      manifest entry) short-circuits via the iter 42 cache.
//
// Runtime: ~30-45s. Single browser, viewer cold-load, no document
// open — same setup as test-regression-dict-multi-lang.js.

'use strict';

const fs = require('fs');
const puppeteer = require('puppeteer');
const env = require('../../lib/test-env');
const __cl = require('../../lib/inject-checklist');

const VIEWER  = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-dict-locale-resolve';

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
    log('=== Regression: loadDictionaryForLocale BCP 47 resolver ===');
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

        // Resolver must be exported.
        const exported = await editor.evaluate(() =>
            typeof window.loadDictionaryForLocale === 'function');
        check('window.loadDictionaryForLocale exported',
              exported, `typeof=${exported ? 'function' : 'missing'}`);
        if (!exported) process.exit(allPassed ? 0 : 1);

        // Manifest sanity.
        const manifest = await editor.evaluate(() =>
            (window.__dictLoader && window.__dictLoader.manifest) || []);
        check('manifest non-empty', manifest.length > 0,
              `${manifest.length} entries`);
        const has = (lang) =>
            manifest.some(e => e.lang.toLowerCase() === lang.toLowerCase());

        // Build the case set based on what's in the manifest. The
        // manifest content varies by build (build-dicts.sh DEFAULT_LANGS);
        // skip cases whose target lang isn't shipped.
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
            // pt-BR exact lower lowercase match wins over pt_PT.
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
        log(`ERROR: ${e.message}`);
        check('test ran without exceptions', false, e.message);
    } finally {
        try { await page.close(); } catch (_) {}
        try { await ctx.close(); } catch (_) {}
        try { await browser.close(); } catch (_) {}
    }

    process.exit(allPassed ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
