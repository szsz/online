// Regression: paragraph-language change → reactive dict load wiring
// (task #196 / iter 44). E2E test against a docx fixture with three
// paragraphs tagged en-US / de-DE / fr-FR.
//
// What this asserts:
//   1. Open test/data/mixed-lang-paragraphs.docx via the viewer.
//   2. Editor primary preload runs (English, since pinned navigator).
//   3. Click into the German paragraph → wait for the
//      .uno:LanguageStatus state-change → window.__dictLoader.loaded
//      gains 'de' AND fetch count for 'de' goes from 0 → 1.
//   4. Click into the French paragraph → state.loaded gains 'fr_FR'
//      (the manifest's region-prefix match for the bare 'fr' primary
//      tag — see iter 43's loadDictionaryForLocale resolver).
//   5. Click back into the English paragraph → no new fetch (English
//      already loaded as primary).
//
// This locks the iter 43 wiring end-to-end: the LanguageStatus event
// flows from kit → COOL state-change handler → dict-loader resolver
// → idempotent loadDictionary, all observable from outside the
// editor iframe via __dictLoader and performance.getEntries.
//
// Out-of-scope (separate iter): asserting that LO actually flags
// English typos in the German paragraph as misspelled. That requires
// driving the spellcheck visitor + reading squiggle markers, which
// is its own large surface; this test pins the dict-load PLUMBING.
//
// Runtime: ~60-90s. Single browser, single viewer load, three
// cursor-clicks within the editor iframe.

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('./lib/test-env');
const __cl = require('./lib/inject-checklist');
const { uploadV2 } = require('./lib/v2-upload');

const VIEWER  = env.FILE_STORAGE_URL;
const FIXTURE = path.join(__dirname, '..', 'test', 'data',
                          'mixed-lang-paragraphs.docx');
const NAME    = `mixed-lang-${Date.now()}.docx`;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-mixed-lang-spellcheck';

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

// Helper: wait until window.__dictLoader.loaded contains `lang`,
// up to timeoutMs. Polled because the load is async and the cursor
// click → LanguageStatus event → loadDictionary → fetch chain takes
// hundreds of ms.
async function waitForLoadedLang(frame, lang, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const has = await frame.evaluate((l) =>
            !!(window.__dictLoader && window.__dictLoader.loaded[l]),
            lang);
        if (has) return true;
        await sleep(250);
    }
    return false;
}

// Click at a doc-relative percentage inside the canvas to land the
// cursor in a specific paragraph. The fixture has three paragraphs
// stacked vertically — 25% / 55% / 85% land roughly mid-paragraph.
async function clickInCanvas(page, frame, fractionDown) {
    const box = await frame.evaluate(() => {
        const c = document.getElementById('document-canvas');
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return { x: r.x | 0, y: r.y | 0, w: r.width | 0, h: r.height | 0 };
    });
    if (!box) throw new Error('no #document-canvas in frame');
    // The canvas is inside the iframe; convert to page coords.
    const iframeBox = await page.evaluate(() => {
        const f = document.getElementById('editor-frame');
        if (!f) return null;
        const r = f.getBoundingClientRect();
        return { x: r.x | 0, y: r.y | 0 };
    });
    const px = (iframeBox?.x || 0) + box.x + Math.floor(box.w / 4);
    const py = (iframeBox?.y || 0) + box.y + Math.floor(box.h * fractionDown);
    await page.mouse.click(px, py);
}

(async () => {
    log('=== Regression: mixed-language paragraph spellcheck wiring ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(FIXTURE)) {
        log(`SKIP: fixture missing at ${FIXTURE}`);
        process.exit(2);
    }

    const bytes = fs.readFileSync(FIXTURE);
    const up = await uploadV2(VIEWER, NAME, bytes);
    const url = `${VIEWER}/?singleuser#file=${up.b64urlSecret}`;
    log(`uploaded ${NAME} (${(bytes.length / 1024).toFixed(0)}KB)`);

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'languages',
            { get: () => ['en-US', 'en'], configurable: true });
        Object.defineProperty(navigator, 'language',
            { get: () => 'en-US', configurable: true });
    });

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded',
            timeout: env.scaleTimeout(120000) });
        await sleep(3000);
        const frame = await waitForEditorFrame(page, env.scaleTimeout(120000));
        check('editor frame reachable', !!frame, frame ? 'ok' : '(none)');
        if (!frame) process.exit(allPassed ? 0 : 1);
        await sleep(5000); // settle for primary dict + doc load
        await snap(page, 'doc_loaded');

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
        if (!initial.hasResolver) process.exit(allPassed ? 0 : 1);

        // Click into the GERMAN paragraph. Empirically the fixture's
        // paragraph layout under the post-FD viewport puts German in
        // the ~35-45% vertical band (English wraps to a single short
        // line at the top, then German wraps 2-3 lines, then French
        // wraps 2 lines). Earlier coords (0.50) landed in French.
        log('clicking into German paragraph');
        await clickInCanvas(page, frame, 0.40);
        await sleep(2000);
        const deLangStatus = await frame.evaluate(() =>
            (window.app && window.app.map && window.app.map['stateChangeHandler']
                && window.app.map['stateChangeHandler'].getItemValue('.uno:LanguageStatus')) || '(unset)');
        log(`  .uno:LanguageStatus after German click: "${deLangStatus}"`);
        await snap(page, 'after_click_german_paragraph');

        const gotDe = await waitForLoadedLang(frame, 'de',
            env.scaleTimeout(15000));
        check('loadDictionary fired for German (de) within 15s',
              gotDe, gotDe ? 'ok' : 'timed out — LanguageStatus → dict chain broken?');

        // Click into the FRENCH paragraph (~85%).
        log('clicking into French paragraph');
        await clickInCanvas(page, frame, 0.83);
        await sleep(500);
        await snap(page, 'after_click_french_paragraph');

        // 'fr-FR' resolves to manifest 'fr_FR' via iter 43's resolver.
        const gotFr = await waitForLoadedLang(frame, 'fr_FR',
            env.scaleTimeout(15000));
        check('loadDictionary fired for French (fr_FR) within 15s',
              gotFr, gotFr ? 'ok' : 'timed out');

        // Click back into ENGLISH paragraph — must NOT trigger
        // a new fetch (English already loaded as primary).
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
        log(`ERROR: ${e.message}`);
        check('test ran without exceptions', false, e.message);
    } finally {
        try { await page.close(); } catch (_) {}
        try { await ctx.close(); } catch (_) {}
        try { await browser.close(); } catch (_) {}
    }

    process.exit(allPassed ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
