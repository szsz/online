// test-cv-regression-language-picker-multilang.js — the status-bar language
// picker offers languages beyond English.
//
// Bug (2026-06-26): the picker listed only English variants (English USA /
// South Africa / Australia) — the user could not select German/French/… to
// spell-check. Root cause: getLanguages() (LOK .uno:LanguageStatus command
// values) returned only xSpell->getLocales(), i.e. *installed* dictionaries.
// Dictionaries load lazily in the WASM build, so at start-up only the primary
// (navigator.language) English dictionary is installed → English-only picker,
// a chicken-and-egg (can't pick a language to trigger its dictionary load).
//
// Fix: getLanguages() under EMSCRIPTEN emits the full SvtLanguageTable; the
// client (Map.js) narrows it to dictionary-backed languages via the manifest,
// keeping the common favourites inline and the rest in the "More…" dialog.
//
// E2E only — opens the real status-bar language menu via a Puppeteer click and
// reads the rendered menu entries. No internal/dispatch calls.
//
// Migrated from wasm/tests/regression/test-regression-language-picker-multilang.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-language-picker-multilang.js [base-url]

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
const SHOT_DIR = '/tmp/content-viewer-report/regression-language-picker-multilang';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

// iframe origin on the page — frame-local rects + origin = page coords.
async function frameOrigin(page) {
    const el = await page.$('iframe');
    const box = el && await el.boundingBox();
    if (!box) throw new Error('no editor iframe on page');
    return { x: box.x, y: box.y };
}
async function clickFramePt(page, fx, fy) {
    const o = await frameOrigin(page);
    await page.mouse.click(o.x + fx, o.y + fy);
}

// Collect the visible, human-readable text of anything that looks like a
// menu/list entry currently on screen (JSDialog menu items, dropdowns,
// treelistbox rows). Broad on purpose so the assertion survives small
// differences in the menu's DOM structure.
async function visibleEntryTexts(frame) {
    return frame.evaluate(() => {
        const out = [];
        document.querySelectorAll('span, td, li, div').forEach(el => {
            if (el.offsetParent === null) return;            // not visible
            const own = [...el.childNodes].filter(n => n.nodeType === 3)
                .map(n => n.textContent.trim()).join('').trim();
            if (own && own.length <= 40) out.push(own);
        });
        return out;
    }).catch(() => []);
}

const NON_ENGLISH = /german|deutsch|fran[çc]ais|french|italian|italiano|spanish|espa|portug|dutch|nederlands|russ/i;

async function openLanguageMenu(page, frame) {
    // The status-bar language menubutton renders with base id "languagestatus"
    // (Util.ScrollableBar splits the "languagestatus:LanguageStatusMenu" id on
    // ':'). Click it to drop the menu.
    const rect = await frame.evaluate(() => {
        const el = document.getElementById('languagestatus')
            || document.querySelector('[id^="languagestatus"]')
            || document.querySelector('#LanguageStatus');
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }).catch(() => false);
    if (!rect) return false;
    await clickFramePt(page, rect.x, rect.y);
    await sleep(1800);
    return true;
}

(async () => {
    log('=== CV regression: language picker offers non-English languages ===');
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

        log('open mixed-lang docx via /collabora-tester');
        await openViaContentViewer(browser, BASE, FIXTURE,
            { page, viewport: { width: 1600, height: 1000 }, iframeTimeout: 45000 });
        check('editor became interactive (Save enabled)',
              await waitCvInteractive(page, LOAD_BUDGET));
        const frame = cvEditorFrame(page);
        check('editor frame reachable', !!frame, frame ? 'ok' : '(none)');
        if (!frame) throw new Error('no editor frame');
        log('frame ready');
        await sleep(16000); // doc load + manifest fetch + spell scan
        await page.screenshot({ path: `${SHOT_DIR}/01_loaded.png` });

        // Click into the document so the status bar populates the language
        // state (frame coords 800,340 — mapped through the iframe origin).
        await clickFramePt(page, 800, 340);
        await sleep(2500);

        const opened = await openLanguageMenu(page, frame);
        check('language status menu opened', opened, 'no #languagestatus button found');
        await page.screenshot({ path: `${SHOT_DIR}/02_menu_open.png` });

        let entries = opened ? await visibleEntryTexts(frame) : [];
        log(`inline menu entries: ${JSON.stringify(entries).slice(0, 400)}`);
        let hasNonEnglish = entries.some(t => NON_ENGLISH.test(t));

        // If the common language isn't in the inline favourites menu, open the
        // "More…" / "Set Language for All text" dialog and check the full list.
        if (!hasNonEnglish) {
            const more = entries.find(t => /set language for all|more/i.test(t));
            log(`no non-English inline; trying "More…" (${more || 'not found'})`);
            const moreRect = await frame.evaluate((txt) => {
                const els = [...document.querySelectorAll('.context-menu-item,[role="menuitem"],.ui-menu-item')];
                const el = els.find(e => txt && (e.textContent || '').trim() === txt) ||
                           els.find(e => /set language for all/i.test(e.textContent || ''));
                if (!el) return null; const r = el.getBoundingClientRect();
                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }, more).catch(() => null);
            if (moreRect) {
                await clickFramePt(page, moreRect.x, moreRect.y);
                await sleep(3000);
                await page.screenshot({ path: `${SHOT_DIR}/03_more_dialog.png` });
                entries = await visibleEntryTexts(frame);
                log(`More-dialog entries (${entries.length}): ${JSON.stringify(entries).slice(0, 400)}`);
                hasNonEnglish = entries.some(t => NON_ENGLISH.test(t));
            }
        }

        const nonEnglish = [...new Set(entries.filter(t => NON_ENGLISH.test(t)))];
        log(`non-English languages offered: ${JSON.stringify(nonEnglish)}`);
        check('picker offers a non-English language (German/French/Italian/…)',
              hasNonEnglish, `entries sampled=${JSON.stringify(entries).slice(0, 200)}`);
        check('picker offers at least two distinct non-English languages',
              nonEnglish.length >= 2, `found=${JSON.stringify(nonEnglish)}`);
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
