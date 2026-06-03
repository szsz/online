// Regression: clicking the language switcher dropdown actually
// changes the editor's UI language (not just the localStorage pin).
//
// The existing test-regression-ui-lang.js exercises the *plumbing*
// (URL → window.LANG → LOCALIZATIONS) but writes the localStorage
// pin via page.evaluate(), bypassing the dropdown click handler.
// That misses bugs in:
//   - the change-event listener wiring
//   - the onchange callback (which triggers window.location.reload)
//   - any race where the iframe rebuild on reload doesn't pick up
//     the new pin (e.g. SW serving a cached cool.html with stale
//     iframe URL)
//
// This test drives a REAL <select> change via puppeteer's
// page.select(): user picks a language → viewer reloads → editor
// iframe must come up with the new lang in its window.LANG and
// in window.LOCALIZATIONS.
//
// What the test asserts:
//   1. Initial page load has the expected default language (English
//      fallback when navigator.languages doesn't match anything we
//      ship).
//   2. page.select('#ui-lang-switcher', 'de') triggers the change
//      event, the localStorage pin gets written, the page reloads.
//   3. After reload: editor iframe URL contains &lang=de.
//   4. After reload: editor's window.LANG === 'de'.
//   5. After reload: window.LOCALIZATIONS has > 100 keys (German
//      strings actually loaded — not an empty fallback).
//
// Runtime: ~30-60s (two viewer loads, two editor cold-starts).

'use strict';

const fs = require('fs');
const puppeteer = require('puppeteer');
const env = require('./lib/test-env');
const __cl = require('./lib/inject-checklist');

const VIEWER  = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-lang-switcher-click';

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

async function getEditorState(page) {
    const frame = page.frames().find(f => f.url().includes('cool.html'));
    if (!frame) return null;
    try {
        return await frame.evaluate(() => ({
            url:        location.href,
            windowLANG: window.LANG || null,
            localeKeys: window.LOCALIZATIONS
                ? Object.keys(window.LOCALIZATIONS).length : 0,
        }));
    } catch (_) { return null; }
}

async function waitForEditor(page, timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const frame = page.frames().find(f => f.url().includes('cool.html'));
        if (frame) {
            const haveCanvas = await frame.$('#document-canvas').catch(() => null);
            if (haveCanvas) return frame;
        }
        await sleep(500);
    }
    return null;
}

(async () => {
    log('=== Regression: language switcher click changes editor lang ===');
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

    // Force a clean default state — navigator.languages set to a list
    // where the FIRST entry is English (so default fallback to "en"
    // applies, not some pre-existing pin).
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'languages',
            { get: () => ['en-US', 'en'], configurable: true });
        Object.defineProperty(navigator, 'language',
            { get: () => 'en-US', configurable: true });
    });

    try {
        // ── Step 1: initial load with default English ────────────
        await page.goto(`${VIEWER}/?singleuser`,
            { waitUntil: 'domcontentloaded',
              timeout: env.scaleTimeout(60000) });
        await sleep(2500);
        await snap(page, 'initial_load_english');

        // Confirm switcher is mounted and default is English ("en")
        const sw0 = await page.$eval('#ui-lang-switcher', el => ({
            value: el.value, optionCount: el.options.length,
        })).catch(() => null);
        check('switcher mounted on initial load',
              !!sw0, JSON.stringify(sw0));
        if (sw0) {
            check('default selection is "en" (no pin, en-US navigator)',
                  sw0.value === 'en',
                  `value=${sw0.value}`);
        }

        // Confirm editor came up with default lang
        const editor0 = await waitForEditor(page,
            env.scaleTimeout(90000));
        check('editor frame reachable on initial load', !!editor0,
              editor0 ? 'ok' : 'no frame');

        if (editor0) {
            await sleep(3000); // settle for l10n-all.js
            const state0 = await getEditorState(page);
            check('initial editor window.LANG is en-* (English)',
                  state0 && (state0.windowLANG === 'en' ||
                             state0.windowLANG === 'en-US'),
                  state0 ? `windowLANG=${state0.windowLANG}` : '(null)');
            check('initial editor LOCALIZATIONS empty (English path)',
                  state0 && state0.localeKeys === 0,
                  state0 ? `keys=${state0.localeKeys}` : '(null)');
        }

        // ── Step 2: click-pick "de" via the dropdown ────────────
        // page.select fires a real `change` event — the same code
        // path as a user clicking the dropdown and picking an entry.
        await snap(page, 'before_click_de');
        const navigationDone = page.waitForNavigation({
            waitUntil: 'domcontentloaded',
            timeout: env.scaleTimeout(60000),
        });
        await page.select('#ui-lang-switcher', 'de');
        log('selected "de" — waiting for viewer reload');
        await navigationDone;
        await sleep(3000);
        await snap(page, 'after_reload_german');

        // localStorage pin must now be "de"
        const pin = await page.evaluate(() =>
            localStorage.getItem('cool-ui-lang'));
        check('localStorage pin set to "de" after click',
              pin === 'de', `pin=${pin}`);

        // Switcher should reflect the new pin
        const sw1 = await page.$eval('#ui-lang-switcher', el => el.value)
            .catch(() => null);
        check('switcher value reflects pin after reload',
              sw1 === 'de', `value=${sw1}`);

        // Editor iframe URL must contain &lang=de
        const iframeSrc = await page.$eval('#editor-frame', f => f.src)
            .catch(() => null);
        const langMatch = iframeSrc && iframeSrc.match(/[?&]lang=([^&]+)/);
        const urlLang = langMatch ? decodeURIComponent(langMatch[1]) : null;
        check('iframe URL contains &lang=de after reload',
              urlLang === 'de',
              `urlLang=${urlLang} src=${(iframeSrc||'').slice(0,140)}`);

        // ── Step 3: editor must come up with the new lang ───────
        const editor1 = await waitForEditor(page,
            env.scaleTimeout(90000));
        check('editor frame reachable after switch', !!editor1,
              editor1 ? 'ok' : 'no frame');

        if (editor1) {
            await sleep(4000); // l10n-all.js populates LOCALIZATIONS
            const state1 = await getEditorState(page);
            check('editor window.LANG is "de" after switch',
                  state1 && state1.windowLANG === 'de',
                  state1 ? `windowLANG=${state1.windowLANG}` : '(null)');
            check('editor LOCALIZATIONS has > 100 German keys',
                  state1 && state1.localeKeys > 100,
                  state1 ? `keys=${state1.localeKeys}` : '(null)');
            await snap(page, 'editor_loaded_german');
        }

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
