// test-cv-regression-spell-language-switch.js — switching a paragraph's
// language makes spellcheck re-run with the (lazily-loaded) dictionary, so
// misspelled words get red squiggles.
//
// Bug (2026-06-27): after switching text to Spanish via the language picker,
// no red squiggles appeared even though the Spanish dictionary loaded.
// Two-layer root cause in libreoffice-core-wasm:
//   1. The dictionary's async fetch finishes *after* the language-change spell
//      pass, so text is recorded "clean" and nothing re-examines it. Fixed by
//      firing a re-spell from lok_wasm_dict_installed (PR #48).
//   2. That re-spell fired only SPELL_WRONG_WORDS_AGAIN, which re-checks only
//      already-flagged words — the wrong-list was empty, so nothing happened.
//      Fixed by also firing SPELL_CORRECT_WORDS_AGAIN (LO 2026-06-27-110).
//
// Drives the real status-bar language menu and reads real canvas pixels — no
// internal/dispatch calls. Types English-valid words ("the house garden") that
// English spell accepts but Spanish/Hungarian reject, switches the doc
// language, and asserts red squiggle pixels appear where there were (almost)
// none before. Covers both menu paths (inline favourite + More… dialog).
//
// Migrated from wasm/tests/regression/test-regression-spell-language-switch.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-spell-language-switch.js [base-url]

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
const SHOT_DIR = '/tmp/content-viewer-report/regression-spell-language-switch';
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

// Count red squiggle-colored pixels on the document canvas (r>150,g<90,b<90).
// getImageData is canvas-local, unaffected by where the iframe sits.
async function redPixels(frame) {
    return frame.evaluate(() => {
        const c = document.getElementById('document-canvas');
        if (!c) return -1;
        const d = c.getContext('2d').getImageData(100, 150, 1300, 260).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4)
            if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) n++;
        return n;
    }).catch(() => -1);
}

(async () => {
    log('=== CV regression: language switch re-spells with lazy dict ===');
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
        await sleep(16000); // doc load + manifest fetch

        // Clear the doc and type words valid in English (so English spell
        // leaves them clean) but invalid in Spanish/Hungarian.
        await clickFramePt(page, 700, 340); await sleep(800);
        await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control'); await sleep(300);
        await page.keyboard.press('Delete'); await sleep(500);
        await page.keyboard.type('the house garden', { delay: 50 });
        await sleep(6000); // English spell pass
        const enRed = await redPixels(frame);
        await page.screenshot({ path: `${SHOT_DIR}/01_english.png` });
        log(`English red pixels = ${enRed}`);

        // Click a span whose direct text matches `re` (menu entry / dialog row).
        async function clickText(re) {
            const r = await frame.evaluate((rs) => {
                const rx = new RegExp(rs);
                const sp = [...document.querySelectorAll('span,td,div')].filter(s => s.offsetParent !== null);
                const el = sp.find(s => rx.test([...s.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('')));
                if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
            }, re).catch(() => null);
            if (r) { await clickFramePt(page, r.x, r.y); return true; }
            return false;
        }
        async function openLangMenu() {
            await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control'); await sleep(400);
            const btn = await frame.evaluate(() => { const e = document.getElementById('languagestatus'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
            if (!btn) return false;
            await clickFramePt(page, btn.x, btn.y); await sleep(1800);
            return true;
        }

        // Switch the document to `name` and assert squiggles appear. `viaMore`:
        // common languages are inline favourites; the rest (e.g. Hungarian) are
        // reached through "Set Language for Selection → More…". Both paths
        // trigger the lazy dict load + re-spell — covers the multi-language fix.
        async function switchAndCheck(name, viaMore, shot) {
            if (!(await openLangMenu())) { check(`[${name}] language status button present`, false); return; }
            if (viaMore) {
                const more = await clickText('Set Language for Selection');
                check(`[${name}] "Set Language for Selection" available`, more);
                await sleep(2500);
                const row = await clickText('^' + name);
                check(`[${name}] offered in the More… language list`, row);
                await sleep(800);
                const ok = await frame.evaluate(() => { const b = document.getElementById('ok') || [...document.querySelectorAll('button')].find(x => /^ok$/i.test((x.textContent || '').trim())); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
                if (ok) await clickFramePt(page, ok.x, ok.y);
            } else {
                const inline = await clickText('^' + name);
                check(`[${name}] offered in the inline language menu`, inline);
            }
            log(`switched to ${name}; waiting for dict load + re-spell`);
            await sleep(16000);
            await clickFramePt(page, 700, 520); await sleep(1500); // move cursor off, let paint settle
            const red = await redPixels(frame);
            await page.screenshot({ path: `${SHOT_DIR}/${shot}.png` });
            log(`${name} red pixels = ${red}`);
            check(`${name} misspellings show red squiggles after switching language`,
                  red > enRed + 40 && red > 80, `enRed=${enRed} red=${red}`);
        }

        // Spanish: an inline favourite. Hungarian: via the More… dialog (and a
        // real user-reported "doesn't always check spelling" language — its
        // dict is larger / lazier, so it exercises the re-spell-on-dict-install
        // path).
        await switchAndCheck('Spanish \\(Spain\\)', false, '02_spanish');
        await switchAndCheck('Hungarian', true, '03_hungarian');
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
