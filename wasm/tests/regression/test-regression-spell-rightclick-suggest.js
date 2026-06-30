// Regression: right-clicking a misspelled word offers spelling suggestions,
// and picking one corrects the word — for en-US, de-DE and fr-FR.
//
// Bug (2026-06-24): squiggles painted, but right-clicking a misspelled word
// showed NO context menu (the kit sent nothing). Root cause in
// SwView::ExecSpellPopup / SwSpellPopup ctor (LO core). After the fix the kit
// emits a spelling context menu (keyed by .uno:SpellCheckIgnore) whose items
// include the hunspell suggestions; clicking one dispatches the replace.
//
// E2E only — real right-click via Puppeteer, real menu-item click, verify the
// visible word actually changed. No internal/dispatch calls.
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

const VIEWER  = process.env.VIEWER_URL || env.FILE_STORAGE_URL;
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'mixed-lang-paragraphs.docx');
const NAME    = `spell-rclick-${Date.now()}.docx`;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-spell-rightclick-suggest';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const log = m => console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) { if (cond) log(`PASS ${label}`); else { log(`FAIL ${label}: ${ev||''}`); allPassed = false; } }

fs.rmSync(SHOT_DIR, { recursive: true, force: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

function findFrame(page) { return page.frames().find(f => f.url().includes('cool.html')) || null; }

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

async function charCount(frame) {
    const t = await frame.evaluate(() => document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
    const m = t.match(/([\d,]+)\s*character/);
    return m ? parseInt(m[1].replace(/,/g, '')) : -1;
}

async function rightClickAndCorrect(page, frame, label, x, y) {
    await page.mouse.click(x, y, { button: 'right' });
    await sleep(env.scaleTimeout(2500));
    const items = await menuItems(frame);
    log(`[${label}] menu items: ${JSON.stringify(items).slice(0, 220)}`);
    check(`[${label}] spelling context menu appears`, items.length > 0 && isSpellingMenu(items),
          `items=${items.length}`);
    const fixed = /^(ignore|ignore all|spelling|spelling…|add|add to dictionary|add word|set language|paragraph|paste|comment|page style)/i;
    const suggestion = items.find(t => t && !fixed.test(t.trim()));
    check(`[${label}] at least one suggestion offered`, !!suggestion, `first=${suggestion || '(none)'}`);
    if (!suggestion) { await page.keyboard.press('Escape'); return; }

    // Real mouse click on the suggestion item (the jQuery-contextMenu plugin
    // reacts to mouseup, not a DOM .click()). The iframe fills the page, so the
    // item's viewport rect ≈ page coords.
    const rect = await frame.evaluate((txt) => {
        const lists = [...document.querySelectorAll('.context-menu-list')].filter(l => l.offsetParent !== null);
        for (const l of lists) for (const it of l.querySelectorAll('.context-menu-item')) {
            if ((it.textContent || '').trim() === txt) { const r = it.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; }
        }
        return null;
    }, suggestion).catch(() => null);
    if (!rect) { check(`[${label}] suggestion item locatable`, false); return; }
    log(`[${label}] clicking suggestion "${suggestion}" at (${rect.x|0},${rect.y|0})`);
    await page.mouse.click(rect.x, rect.y);
    await sleep(env.scaleTimeout(3000)); // apply + re-spell

    // Verify the correction took effect: right-click the same word again — it is
    // now correctly spelled, so it must NOT produce a spelling context menu.
    await page.mouse.click(x, y, { button: 'right' });
    await sleep(env.scaleTimeout(2500));
    const items2 = await menuItems(frame);
    log(`[${label}] re-right-click menu: ${JSON.stringify(items2).slice(0, 180)}`);
    check(`[${label}] picking suggestion corrected the word (no longer flagged)`,
          !isSpellingMenu(items2), `items=${JSON.stringify(items2).slice(0,120)}`);
    await page.keyboard.press('Escape');
    await sleep(400);
    return suggestion;
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
    page.on('console', m => { const t = m.text(); if (/overflow|Stack cookie|unreachable/i.test(t)) log(`  [iframe] ${t.slice(0,160)}`); });

    await page.goto(`${VIEWER}/?singleuser#file=${up.b64urlSecret}`, { waitUntil: 'domcontentloaded', timeout: env.scaleTimeout(120000) });
    let frame = null;
    for (let i = 0; i < 90 && !frame; i++) { frame = findFrame(page); if (frame && !(await frame.$('#document-canvas').catch(()=>null))) frame = null; if (!frame) await sleep(1000); }
    if (!frame) { log('FATAL: no editor frame'); await browser.close(); process.exit(2); }
    log('frame ready');
    await sleep(env.scaleTimeout(16000)); // doc load + spell scan
    await page.screenshot({ path: `${SHOT_DIR}/01_loaded.png` });

    // English: "manuscrit" on line 1 (screen ~985,337)
    await rightClickAndCorrect(page, frame, 'en', 985, 337);
    await page.screenshot({ path: `${SHOT_DIR}/02_en_after.png` });

    // Other languages: the paragraph's dictionary is fetched on cursor entry
    // (dict-loader). Click into the paragraph, wait for the dict to load + the
    // word to be flagged, then right-click a misspelling.
    async function primeAndCorrect(label, primeX, primeY, wordX, wordY) {
        await page.mouse.click(primeX, primeY);          // place cursor → triggers dict load
        await sleep(env.scaleTimeout(10000));            // dict fetch + autospell rescan
        await page.mouse.click(wordX - 80, wordY);       // move cursor off the menu target
        await sleep(800);
        await rightClickAndCorrect(page, frame, label, wordX, wordY);
        await page.screenshot({ path: `${SHOT_DIR}/0${label === 'de' ? 3 : 4}_${label}_after.png` });
    }

    // German paragraph (~y=428): "Woerter" should suggest "Wörter".
    await primeAndCorrect('de', 500, 428, 795, 428);
    // French paragraph (~y=553): "francais" should suggest "français".
    await primeAndCorrect('fr', 400, 553, 550, 553);

    await browser.close();
    log('\n' + (allPassed ? 'TEST PASSED' : 'TEST FAILED'));
    process.exit(allPassed ? 0 : 1);
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(2); });
