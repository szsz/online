// test-cv-regression-spell-rightclick-suggest.js — right-clicking a
// misspelled word offers spelling suggestions, and picking one corrects the
// word — for en-US, de-DE and fr-FR.
//
// Bug (2026-06-24): squiggles painted, but right-clicking a misspelled word
// showed NO context menu (the kit sent nothing). Root cause in
// SwView::ExecSpellPopup / SwSpellPopup ctor (LO core). After the fix the kit
// emits a spelling context menu (keyed by .uno:SpellCheckIgnore) whose items
// include the hunspell suggestions; clicking one dispatches the replace.
//
// E2E only — real right-click via Puppeteer, real menu-item click, verify the
// visible word actually changed. No internal/dispatch calls.
//
// Coordinate note: the legacy viewer's editor iframe filled the page, so
// frame coords == page coords. In the content-viewer the tester toolbar sits
// above the iframe, so every frame-local coordinate is mapped through the
// iframe's bounding-box origin before mouse use.
//
// Migrated from wasm/tests/regression/test-regression-spell-rightclick-suggest.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-spell-rightclick-suggest.js [base-url]

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
const SHOT_DIR = '/tmp/content-viewer-report/regression-spell-rightclick-suggest';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

// iframe origin on the page — frame-local coords + origin = page coords.
async function frameOrigin(page) {
    const el = await page.$('iframe');
    const box = el && await el.boundingBox();
    if (!box) throw new Error('no editor iframe on page');
    return { x: box.x, y: box.y };
}
async function clickFramePt(page, fx, fy, opts) {
    const o = await frameOrigin(page);
    await page.mouse.click(o.x + fx, o.y + fy, opts || {});
}

// read the visible context-menu items (jQuery contextMenu plugin)
async function menuItems(frame) {
    return frame.evaluate(() => {
        const lists = [...document.querySelectorAll('.context-menu-list')].filter(l => l.offsetParent !== null);
        const items = [];
        lists.forEach(l => l.querySelectorAll('.context-menu-item').forEach(it => {
            const t = (it.textContent || '').trim();
            if (t) items.push(t);
        }));
        return items;
    }).catch(() => []);
}

// A generic (non-spelling) menu has Paste/Clone Formatting/Page Style and NO
// suggestions. The spelling menu carries suggestion items + Spelling…/Ignore.
function isSpellingMenu(items) {
    const blob = items.join(' | ').toLowerCase();
    return /ignore|spelling|add to dictionary|add word/.test(blob);
}

async function rightClickAndCorrect(page, frame, label, x, y) {
    await clickFramePt(page, x, y, { button: 'right' });
    await sleep(3000);
    const items = await menuItems(frame);
    log(`[${label}] menu items: ${JSON.stringify(items).slice(0, 220)}`);
    check(`[${label}] spelling context menu appears`, items.length > 0 && isSpellingMenu(items),
          `items=${items.length}`);
    const fixed = /^(ignore|ignore all|spelling|spelling…|add|add to dictionary|add word|set language|paragraph|paste|comment|page style)/i;
    const suggestion = items.find(t => t && !fixed.test(t.trim()));
    check(`[${label}] at least one suggestion offered`, !!suggestion, `first=${suggestion || '(none)'}`);
    if (!suggestion) { await page.keyboard.press('Escape'); return; }

    // Real mouse click on the suggestion item (the jQuery-contextMenu plugin
    // reacts to mouseup, not a DOM .click()). Frame rect + iframe origin =
    // page coords.
    const rect = await frame.evaluate((txt) => {
        const lists = [...document.querySelectorAll('.context-menu-list')].filter(l => l.offsetParent !== null);
        for (const l of lists) for (const it of l.querySelectorAll('.context-menu-item')) {
            if ((it.textContent || '').trim() === txt) { const r = it.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
        }
        return null;
    }, suggestion).catch(() => null);
    if (!rect) { check(`[${label}] suggestion item locatable`, false); return; }
    log(`[${label}] clicking suggestion "${suggestion}" at frame (${rect.x | 0},${rect.y | 0})`);
    await clickFramePt(page, rect.x, rect.y);
    await sleep(3500); // apply + re-spell

    // Verify the correction took effect: right-click the same word again — it
    // is now correctly spelled, so it must NOT produce a spelling context menu.
    await clickFramePt(page, x, y, { button: 'right' });
    await sleep(3000);
    const items2 = await menuItems(frame);
    log(`[${label}] re-right-click menu: ${JSON.stringify(items2).slice(0, 180)}`);
    check(`[${label}] picking suggestion corrected the word (no longer flagged)`,
          !isSpellingMenu(items2), `items=${JSON.stringify(items2).slice(0, 120)}`);
    await page.keyboard.press('Escape');
    await sleep(400);
    return suggestion;
}

(async () => {
    log('=== CV regression: right-click spelling suggestions (en/de/fr) ===');
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
        page.on('console', m => { const t = m.text(); if (/overflow|Stack cookie|unreachable/i.test(t)) log(`  [iframe] ${t.slice(0, 160)}`); });

        log('open mixed-lang docx via /collabora-tester');
        await openViaContentViewer(browser, BASE, FIXTURE,
            { page, viewport: { width: 1600, height: 1000 }, iframeTimeout: 45000 });
        check('editor became interactive (Save enabled)',
              await waitCvInteractive(page, LOAD_BUDGET));
        const frame = cvEditorFrame(page);
        check('editor frame reachable', !!frame, frame ? 'ok' : '(none)');
        if (!frame) throw new Error('no editor frame');
        log('frame ready');
        await sleep(16000); // doc load + spell scan
        await page.screenshot({ path: `${SHOT_DIR}/01_loaded.png` });

        // English: "manuscrit" on line 1 (frame ~985,337).
        await rightClickAndCorrect(page, frame, 'en', 985, 337);
        await page.screenshot({ path: `${SHOT_DIR}/02_en_after.png` });

        // Other languages: the paragraph's dictionary is fetched on cursor
        // entry (dict-loader). Click into the paragraph, wait for the dict to
        // load + the word to be flagged, then right-click a misspelling.
        async function primeAndCorrect(label, primeX, primeY, wordX, wordY) {
            await clickFramePt(page, primeX, primeY); // place cursor → triggers dict load
            await sleep(10000);                       // dict fetch + autospell rescan
            await clickFramePt(page, wordX - 80, wordY); // move cursor off the menu target
            await sleep(800);
            await rightClickAndCorrect(page, frame, label, wordX, wordY);
            await page.screenshot({ path: `${SHOT_DIR}/0${label === 'de' ? 3 : 4}_${label}_after.png` });
        }

        // German paragraph (~y=428): "Woerter" should suggest "Wörter".
        await primeAndCorrect('de', 500, 428, 795, 428);
        // French paragraph (~y=553): "francais" should suggest "français".
        await primeAndCorrect('fr', 400, 553, 550, 553);
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
