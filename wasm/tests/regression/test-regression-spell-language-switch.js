// Regression: switching a paragraph's language makes spellcheck re-run with the
// (lazily-loaded) dictionary, so misspelled words get red squiggles.
//
// Bug (2026-06-27): after switching text to Spanish via the language picker,
// no red squiggles appeared even though the Spanish dictionary loaded. Two-layer
// root cause in libreoffice-core-wasm:
//   1. The dictionary's async fetch finishes *after* the language-change spell
//      pass, so text is recorded "clean" and nothing re-examines it. Fixed by
//      firing a re-spell from lok_wasm_dict_installed (PR #48).
//   2. That re-spell fired only SPELL_WRONG_WORDS_AGAIN, which re-checks only
//      already-flagged words — the wrong-list was empty, so nothing happened.
//      Fixed by also firing SPELL_CORRECT_WORDS_AGAIN (re-check correct words),
//      which re-spells everything (PR #49 → LO_BUILD_ID 2026-06-27-110).
//
// Drives the real status-bar language menu and reads real canvas pixels — no
// internal/dispatch calls. Types English-valid words ("the house garden") that
// English spell accepts but Spanish rejects, switches the doc to Spanish, and
// asserts red squiggle pixels appear where there were (almost) none before.
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

const VIEWER  = process.env.VIEWER_URL || env.FILE_STORAGE_URL;
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'mixed-lang-paragraphs.docx');
const NAME    = `spell-langswitch-${Date.now()}.docx`;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-spell-language-switch';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const log = m => console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) { if (cond) log(`PASS ${label}`); else { log(`FAIL ${label}: ${ev||''}`); allPassed = false; } }

fs.rmSync(SHOT_DIR, { recursive: true, force: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

function findFrame(page) { return page.frames().find(f => f.url().includes('cool.html')) || null; }

// Count red squiggle-colored pixels on the document canvas (r>150,g<90,b<90).
async function redPixels(frame) {
    return frame.evaluate(() => {
        const c = document.getElementById('document-canvas');
        if (!c) return -1;
        const d = c.getContext('2d').getImageData(100, 150, 1300, 260).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4)
            if (d[i] > 150 && d[i+1] < 90 && d[i+2] < 90) n++;
        return n;
    }).catch(() => -1);
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
    await sleep(env.scaleTimeout(16000)); // doc load + manifest fetch

    // Clear the doc and type words valid in English (so English spell leaves
    // them clean) but invalid in Spanish.
    await page.mouse.click(700, 340); await sleep(800);
    await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control'); await sleep(300);
    await page.keyboard.press('Delete'); await sleep(500);
    await page.keyboard.type('the house garden', { delay: 50 });
    await sleep(env.scaleTimeout(6000)); // English spell pass
    const enRed = await redPixels(frame);
    await page.screenshot({ path: `${SHOT_DIR}/01_english.png` });
    log(`English red pixels = ${enRed}`);

    // Click a span whose direct text matches `re` (menu entry / dialog row).
    async function clickText(re) {
        const r = await frame.evaluate((rs) => {
            const rx = new RegExp(rs);
            const sp = [...document.querySelectorAll('span,td,div')].filter(s => s.offsetParent !== null);
            const el = sp.find(s => rx.test([...s.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join('')));
            if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width/2, y: b.y + b.height/2 };
        }, re).catch(() => null);
        if (r) { await page.mouse.click(r.x, r.y); return true; }
        return false;
    }
    async function openLangMenu() {
        await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control'); await sleep(400);
        const btn = await frame.evaluate(() => { const e = document.getElementById('languagestatus'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; });
        if (!btn) return false;
        await page.mouse.click(btn.x, btn.y); await sleep(env.scaleTimeout(1500));
        return true;
    }

    // Switch the document to `name` and assert squiggles appear. `viaMore`:
    // common languages are inline favourites; the rest (e.g. Hungarian) are
    // reached through "Set Language for Selection → More…". Both paths trigger
    // the lazy dict load + re-spell — covers the multi-language fix.
    async function switchAndCheck(name, viaMore, shot) {
        if (!(await openLangMenu())) { check(`[${name}] language status button present`, false); return; }
        if (viaMore) {
            const more = await clickText('Set Language for Selection');
            check(`[${name}] "Set Language for Selection" available`, more);
            await sleep(env.scaleTimeout(2000));
            const row = await clickText('^' + name);
            check(`[${name}] offered in the More… language list`, row);
            await sleep(800);
            const ok = await frame.evaluate(() => { const b = document.getElementById('ok') || [...document.querySelectorAll('button')].find(x=>/^ok$/i.test((x.textContent||'').trim())); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; });
            if (ok) await page.mouse.click(ok.x, ok.y);
        } else {
            const inline = await clickText('^' + name);
            check(`[${name}] offered in the inline language menu`, inline);
        }
        log(`switched to ${name}; waiting for dict load + re-spell`);
        await sleep(env.scaleTimeout(16000));
        await page.mouse.click(700, 520); await sleep(1500); // move cursor off, let paint settle
        const red = await redPixels(frame);
        await page.screenshot({ path: `${SHOT_DIR}/${shot}.png` });
        log(`${name} red pixels = ${red}`);
        check(`${name} misspellings show red squiggles after switching language`,
              red > enRed + 40 && red > 80, `enRed=${enRed} red=${red}`);
    }

    // Spanish: an inline favourite. Hungarian: via the More… dialog (and a real
    // user-reported "doesn't always check spelling" language — its dict is
    // larger / lazier, so it exercises the re-spell-on-dict-install path).
    await switchAndCheck('Spanish \\(Spain\\)', false, '02_spanish');
    await switchAndCheck('Hungarian', true, '03_hungarian');

    await browser.close();
    log('\n' + (allPassed ? 'TEST PASSED' : 'TEST FAILED'));
    process.exit(allPassed ? 0 : 1);
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(2); });
