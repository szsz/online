// Regression: the status-bar language picker offers languages beyond English.
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
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

const VIEWER  = process.env.VIEWER_URL || env.FILE_STORAGE_URL;
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'mixed-lang-paragraphs.docx');
const NAME    = `lang-picker-${Date.now()}.docx`;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-language-picker-multilang';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const log = m => console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) { if (cond) log(`PASS ${label}`); else { log(`FAIL ${label}: ${ev||''}`); allPassed = false; } }

fs.rmSync(SHOT_DIR, { recursive: true, force: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

function findFrame(page) { return page.frames().find(f => f.url().includes('cool.html')) || null; }

// Collect the visible, human-readable text of anything that looks like a
// menu/list entry currently on screen (JSDialog menu items, dropdowns,
// treelistbox rows). Broad on purpose so the assertion survives small
// differences in the menu's DOM structure.
async function visibleEntryTexts(frame) {
    // The JSDialog language menu renders entries as bare <span>s (no stable
    // item class), and the "More…" dialog as treelistbox rows. Collect every
    // visible element whose *direct* text is a short label — robust to the
    // exact menu DOM. We only ever test this against language-name labels.
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
    const clicked = await frame.evaluate(() => {
        const el = document.getElementById('languagestatus')
            || document.querySelector('[id^="languagestatus"]')
            || document.querySelector('#LanguageStatus');
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }).catch(() => false);
    if (!clicked) return false;
    await page.mouse.click(clicked.x, clicked.y);
    await sleep(env.scaleTimeout(1500));
    return true;
}

(async () => {
    const bytes = fs.readFileSync(FIXTURE);
    const up = await uploadV2(VIEWER, NAME, bytes);
    log(`uploaded ${up.fileId.substring(0,12)}`);

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: env.scaleTimeout(600000),
        args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-features=SharedArrayBuffer', '--lang=en-US'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });

    await page.goto(`${VIEWER}/?singleuser#file=${up.b64urlSecret}`, { waitUntil: 'domcontentloaded', timeout: env.scaleTimeout(120000) });
    let frame = null;
    for (let i = 0; i < 90 && !frame; i++) { frame = findFrame(page); if (frame && !(await frame.$('#document-canvas').catch(()=>null))) frame = null; if (!frame) await sleep(1000); }
    if (!frame) { log('FATAL: no editor frame'); await browser.close(); process.exit(2); }
    log('frame ready');
    await sleep(env.scaleTimeout(16000)); // doc load + manifest fetch + spell scan
    await page.screenshot({ path: `${SHOT_DIR}/01_loaded.png` });

    // Click into the document so the status bar populates the language state.
    await page.mouse.click(800, 340);
    await sleep(env.scaleTimeout(2000));

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
            return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }, more).catch(() => null);
        if (moreRect) {
            await page.mouse.click(moreRect.x, moreRect.y);
            await sleep(env.scaleTimeout(2500));
            await page.screenshot({ path: `${SHOT_DIR}/03_more_dialog.png` });
            entries = await visibleEntryTexts(frame);
            log(`More-dialog entries (${entries.length}): ${JSON.stringify(entries).slice(0, 400)}`);
            hasNonEnglish = entries.some(t => NON_ENGLISH.test(t));
        }
    }

    const nonEnglish = [...new Set(entries.filter(t => NON_ENGLISH.test(t)))];
    log(`non-English languages offered: ${JSON.stringify(nonEnglish)}`);
    check('picker offers a non-English language (German/French/Italian/…)',
          hasNonEnglish, `entries sampled=${JSON.stringify(entries).slice(0,200)}`);
    check('picker offers at least two distinct non-English languages',
          nonEnglish.length >= 2, `found=${JSON.stringify(nonEnglish)}`);

    await browser.close();
    log('\n' + (allPassed ? 'TEST PASSED' : 'TEST FAILED'));
    process.exit(allPassed ? 0 : 1);
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(2); });
