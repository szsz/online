const __cl = require('./lib/inject-checklist');
// Regression: viewer detects browser UI language, applies it via
// ?lang=<code> on the editor iframe, and exposes a switcher dropdown
// in the sidebar that overrides via localStorage.
//
// Coverage:
//   1. navigator.languages=['de-DE','de'] → iframe URL carries lang=de
//      and the dropdown shows German selected.
//   2. User changes dropdown to "fr" → localStorage["cool-ui-lang"]
//      becomes "fr" + viewer reloads + iframe URL carries lang=fr.
//   3. navigator.languages=['xx','yy'] (no match) → falls back to "en".
//   4. Selecting "en" in the dropdown clears the localStorage pin
//      (English = default = no pin).
//
// Visual report: screenshots of the sidebar with dropdown visible,
// the dropdown opened, the iframe URL post-switch, and the final
// state. Wired into both runners as "regression-ui-lang".
//
// Out of scope (gated on /lo-roll for the build refactor): asserting
// that the editor's actual UI strings render in German. We assert
// the *plumbing* — what reaches cool.html via ?lang=. The translation
// lookup itself is already exercised by every COOL deployment.

'use strict';

const fs = require('fs');
const puppeteer = require('puppeteer');
const env = require('./lib/test-env');

const VIEWER  = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-ui-lang';

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

// Override navigator.languages BEFORE any page script runs. Puppeteer's
// evaluateOnNewDocument fires on every navigation; setting it once on
// the page is enough for both initial load and the switcher's
// in-place reload.
async function pinNavigatorLanguages(page, langs) {
    await page.evaluateOnNewDocument((arr) => {
        Object.defineProperty(navigator, 'languages',
            { get: () => arr, configurable: true });
        Object.defineProperty(navigator, 'language',
            { get: () => arr[0] || 'en', configurable: true });
    }, langs);
}

// Fetch the iframe's current src — encodes the lang we passed.
async function readIframeSrc(page) {
    return await page.evaluate(() => {
        const f = document.getElementById('editor-frame');
        return f ? f.src : null;
    });
}

async function pickLangFromSrc(src) {
    if (!src) return null;
    const m = src.match(/[?&]lang=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
}

(async () => {
    log('=== Regression: viewer UI-language detect + switcher ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    // Each subtest gets its own BrowserContext — localStorage persists
    // per origin within a context, and we don't want the "pinned French"
    // case to leak into the "no pin → fall back" case. createBrowserContext
    // gives us isolated storage per page.
    async function freshPage() {
        const ctx = await browser.createBrowserContext();
        const p = await ctx.newPage();
        // Track the context so we can close it later (puppeteer 24.x
        // doesn't auto-close contexts when their last page closes).
        p.__ctx = ctx;
        return p;
    }
    async function closePage(p) {
        await p.close().catch(() => {});
        if (p.__ctx) await p.__ctx.close().catch(() => {});
    }

    try {
        // ── 1. German browser → iframe URL has lang=de ───────────
        const page1 = await freshPage();
        await pinNavigatorLanguages(page1, ['de-DE', 'de', 'en']);
        await page1.setViewport({ width: 1280, height: 800 });
        await page1.goto(`${VIEWER}/?singleuser`,
            { waitUntil: 'domcontentloaded', timeout: env.scaleTimeout(60000) });
        // Give the viewer a moment to mount the dropdown + start the iframe.
        await sleep(2500);
        await snap(page1, 'german_browser_initial_load');

        const sw1 = await page1.$eval('#ui-lang-switcher', el => ({
            value: el.value,
            optionCount: el.options.length,
            visible: el.offsetParent !== null,
        })).catch(() => null);
        check('Language switcher mounted in sidebar',
              sw1 && sw1.visible,
              JSON.stringify(sw1));
        if (sw1) {
            check('Switcher reflects detected browser language (de)',
                  sw1.value === 'de',
                  `value=${sw1.value}`);
            check('Switcher offers many options (>20 langs)',
                  sw1.optionCount >= 20,
                  `count=${sw1.optionCount}`);
        }

        const src1 = await readIframeSrc(page1);
        const lang1 = await pickLangFromSrc(src1);
        check('Iframe URL carries lang=de from browser detect',
              lang1 === 'de',
              `lang=${lang1} src=${(src1||'').substring(0,140)}`);

        // Wait for cool.html to come up inside the editor iframe and
        // assert that window.LANG (which l10n-all.js reads at bundle
        // start to pick which locale chunk to load) actually equals
        // 'de'. Without this assertion the bug we're guarding against
        // (URL param reaches iframe, but window.LANG never gets set,
        // so LOCALIZATIONS stays empty and the UI is English) would
        // pass the surface-level "URL has lang=de" check but every
        // user-visible string would still be English.
        let editorFrame = null;
        for (let i = 0; i < 90 && !editorFrame; i++) {
            editorFrame = page1.frames().find(f => f.url().includes('cool.html'));
            if (editorFrame) {
                const haveCanvas = await editorFrame
                    .$('#document-canvas').catch(() => null);
                if (!haveCanvas) editorFrame = null;
            }
            if (!editorFrame) await sleep(1000);
        }
        if (editorFrame) {
            await sleep(2000);   // settle for l10n-all.js to populate
            const editorState = await editorFrame.evaluate(() => ({
                windowLANG: window.LANG || null,
                localeKeys: window.LOCALIZATIONS
                    ? Object.keys(window.LOCALIZATIONS).length : 0,
            }));
            check('window.LANG inside editor iframe matches URL lang (=de)',
                  editorState.windowLANG === 'de',
                  `windowLANG=${editorState.windowLANG}`);
            check('LOCALIZATIONS populated (German strings loaded)',
                  editorState.localeKeys > 100,
                  `keys=${editorState.localeKeys}`);
        } else {
            check('editor iframe with #document-canvas reachable',
                  false, 'no frame found');
        }

        await closePage(page1);

        // ── 2. localStorage pin to "fr" → URL has lang=fr ────────
        // Set the pin via a one-shot navigation: goto + evaluate +
        // reload. We deliberately don't use evaluateOnNewDocument here
        // because it would re-fire on the dropdown-induced reload below
        // and silently re-pin "fr" *after* the user picked English,
        // making the clear-pin assertion impossible to verify.
        const page2 = await freshPage();
        await pinNavigatorLanguages(page2, ['de-DE', 'de']); // browser still says German
        await page2.setViewport({ width: 1280, height: 800 });
        await page2.goto(`${VIEWER}/?singleuser`,
            { waitUntil: 'domcontentloaded', timeout: env.scaleTimeout(60000) });
        await page2.evaluate(() => {
            try { localStorage.setItem('cool-ui-lang', 'fr'); }
            catch (_) {}
        });
        // Reload so the viewer's UI_LANG resolution sees the pin we
        // just wrote. After this load the dropdown should reflect "fr".
        await page2.reload({ waitUntil: 'domcontentloaded',
            timeout: env.scaleTimeout(30000) });
        await sleep(2500);
        await snap(page2, 'pinned_french_initial_load');

        const sw2 = await page2.$eval('#ui-lang-switcher',
            el => el.value).catch(() => null);
        check('Pinned French overrides browser detect in dropdown',
              sw2 === 'fr',
              `dropdown=${sw2}`);

        const src2 = await readIframeSrc(page2);
        const lang2 = await pickLangFromSrc(src2);
        check('Iframe URL carries lang=fr from localStorage pin',
              lang2 === 'fr',
              `lang=${lang2}`);

        // Now select English in the dropdown → pin should clear.
        await page2.select('#ui-lang-switcher', 'en');
        // The handler reloads the page; wait for the new load.
        await page2.waitForNavigation({ waitUntil: 'domcontentloaded',
            timeout: env.scaleTimeout(30000) }).catch(() => {});
        await sleep(2000);
        await snap(page2, 'after_switch_to_english');

        const sw3 = await page2.$eval('#ui-lang-switcher',
            el => el.value).catch(() => null);
        const pin3 = await page2.evaluate(
            () => localStorage.getItem('cool-ui-lang'));
        // After clearing the pin, the dropdown should reflect what
        // navigator.languages resolves to — German (since we're still
        // on the de-DE puppeteer page). NOT English.
        check('Selecting English in dropdown clears the localStorage pin',
              pin3 === null,
              `pin=${pin3}`);
        check('After clearing pin, dropdown reflects browser detect (de)',
              sw3 === 'de',
              `dropdown=${sw3}`);

        const src3 = await readIframeSrc(page2);
        const lang3 = await pickLangFromSrc(src3);
        check('After clearing pin, iframe URL is lang=de again',
              lang3 === 'de',
              `lang=${lang3}`);

        await closePage(page2);

        // ── 3. Unsupported browser language → English fallback ──
        const page3 = await freshPage();
        await pinNavigatorLanguages(page3, ['xx-XX', 'yy']);
        await page3.setViewport({ width: 1280, height: 800 });
        await page3.goto(`${VIEWER}/?singleuser`,
            { waitUntil: 'domcontentloaded', timeout: env.scaleTimeout(60000) });
        await sleep(2500);
        await snap(page3, 'unsupported_lang_fallback_english');

        const src4 = await readIframeSrc(page3);
        const lang4 = await pickLangFromSrc(src4);
        check('Unsupported browser lang → iframe URL is lang=en',
              lang4 === 'en',
              `lang=${lang4}`);

        const sw4 = await page3.$eval('#ui-lang-switcher',
            el => el.value).catch(() => null);
        check('Switcher shows en for unsupported browser lang',
              sw4 === 'en',
              `dropdown=${sw4}`);

        await closePage(page3);

        // ── 4. Closeup of the switcher (for the report) ─────────
        const page4 = await freshPage();
        await pinNavigatorLanguages(page4, ['en-US']);
        await page4.setViewport({ width: 1280, height: 800 });
        await page4.goto(`${VIEWER}/?singleuser`,
            { waitUntil: 'domcontentloaded', timeout: env.scaleTimeout(60000) });
        await sleep(2000);

        const langRow = await page4.$('#ui-lang-row');
        if (langRow) {
            const box = await langRow.boundingBox();
            if (box) {
                await page4.screenshot({
                    path: `${SHOT_DIR}/${String(++shotNum).padStart(2,'0')}_switcher_closeup.png`,
                    clip: {
                        x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8),
                        width: box.width + 16, height: box.height + 16,
                    },
                });
            }
        }
        await closePage(page4);

        log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    } finally {
        await browser.close();
    }

    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e.stack || e.message);
    process.exit(2);
});
