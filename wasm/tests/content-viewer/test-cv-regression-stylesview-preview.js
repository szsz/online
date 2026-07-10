// test-cv-regression-stylesview-preview.js — ribbon Styles iconview entries
// visually preview the effect of applying that style: Title bold + large,
// Body Text small/regular, Heading 1 between, Block Quotation italic, etc.
// Pre-fix every entry rendered as identical 14px placeholder text.
//
// WHAT IS VERIFIED (same subject as the legacy test):
//   Phase 1 (hard asserts) — built-in style names get CSS previews:
//     Title bigger + bolder than Body Text; Subtitle smaller than Title and
//     not bold; H1 > H2 > H3 all bold; Title > H1; Block Quotation italic.
//   Kit enumeration — all 5 custom "Tresorit *" styles from the fixture
//     appear in the full dropdown list.
//   Phase 2 (EXPECTED FAIL until the LO-core per-style manifest lands) —
//     custom styles get their own visual preview (Tresorit Title differs
//     from Body Text and is bold). Soft-fail lines only.
//
// Fixture: test/data/custom-styles.docx (5 custom paragraph styles alongside
// built-ins), reused verbatim from the legacy test.
//
// Migrated from wasm/tests/regression/test-regression-stylesview-preview.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-stylesview-preview.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, waitCvInteractive } = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'custom-styles.docx');
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const SHOT_DIR = '/tmp/content-viewer-report/regression-stylesview-preview';

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
// "Expected fail" — soft line only; test still passes overall while phase 2
// (LO-core per-style visual manifest) is outstanding. Flip to check() once
// the LO roll lands.
function checkExpectedFail(label, cond, ev) {
    if (cond) log(`  PASS UNEXPECTED: ${label}${ev ? ' [' + ev + ']' : ''}  ← phase 2 may have landed?`);
    else log(`  expected-fail: ${label}${ev ? ' [' + ev + ']' : ''}`);
}
const editorFrame = page => page.frames().find(f => (f.url() || '').includes('cool.html'));
let shotN = 0;
async function snap(page, name, clip) {
    try {
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        const f = `${SHOT_DIR}/${String(++shotN).padStart(2, '0')}_${name}.png`;
        await page.screenshot(clip ? { path: f, clip } : { path: f });
    } catch (_) {}
}

(async () => {
    if (!fs.existsSync(FIXTURE)) { log(`SKIP: fixture missing: ${FIXTURE}`); process.exit(2); }
    log('=== Regression: stylesview ribbon preview (content viewer) ===');
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new', width: 1600, height: 1000 });
    try {
        const page = await browser.newPage();
        await openViaContentViewer(browser, BASE, FIXTURE, {
            page, viewport: { width: 1600, height: 1000 }, iframeTimeout: 60000,
        });
        check('editor interactive', await waitCvInteractive(page, LOAD_BUDGET));
        const frame = editorFrame(page);
        if (!frame) throw new Error('editor frame never loaded');
        await frame.waitForFunction(() => {
            const wc = document.querySelector('#StateWordCount');
            return !!(wc && /\d+\s+character/i.test(wc.textContent || ''));
        }, { timeout: 60000 });
        await sleep(4000);   // settle for stylesview population

        await snap(page, 'editor_loaded');
        // Ribbon strip crop — the visible surface the bug + fix is about.
        await snap(page, 'ribbon_top_full', { x: 0, y: 0, width: 1600, height: 260 });

        // Enumerate the visible stylesview entries' computed style.
        const visible = await frame.evaluate(() => {
            const sv = document.getElementById('stylesview');
            if (!sv) return { error: 'no stylesview' };
            return Array.from(sv.querySelectorAll('.ui-iconview-entry')).map(e => {
                const span = e.querySelector('span[title]');
                if (!span) return null;
                const cs = getComputedStyle(span);
                return {
                    id: e.id,
                    title: span.title,
                    text: span.innerText.trim(),
                    fontSize: parseFloat(cs.fontSize),
                    fontWeight: parseInt(cs.fontWeight, 10),
                    fontStyle: cs.fontStyle,
                    rect: (() => { const r = e.getBoundingClientRect();
                        return { x: r.x | 0, y: r.y | 0, w: r.width | 0, h: r.height | 0 }; })(),
                };
            }).filter(Boolean);
        });
        if (visible.error) throw new Error('cannot probe stylesview: ' + visible.error);
        log(`Visible stylesview entries: ${visible.length}`);
        for (const v of visible) {
            log(`  ${v.title.padEnd(20)} fontSize=${v.fontSize}px  weight=${v.fontWeight}  ${v.fontStyle}`);
        }
        const byTitle = t => visible.find(v => v.title === t);

        // ── Headline asserts on built-in styles ─────────────────────
        const title = byTitle('Title');
        const bodyText = byTitle('Body Text');
        if (title && bodyText) {
            check('Title is BIGGER than Body Text',
                title.fontSize > bodyText.fontSize + 2,
                `Title=${title.fontSize}px  Body=${bodyText.fontSize}px`);
            check('Title is BOLD (weight >= 600)',
                title.fontWeight >= 600, `weight=${title.fontWeight}`);
            check('Body Text is REGULAR (weight < 600)',
                bodyText.fontWeight < 600, `weight=${bodyText.fontWeight}`);
        } else {
            check('Title + Body Text both present in picker', false,
                `Title=${!!title} BodyText=${!!bodyText}`);
        }

        const subtitle = byTitle('Subtitle');
        if (subtitle && title) {
            check('Subtitle is smaller than Title',
                subtitle.fontSize < title.fontSize,
                `Subtitle=${subtitle.fontSize}px  Title=${title.fontSize}px`);
            check('Subtitle is NOT bold (weight < 600)',
                subtitle.fontWeight < 600, `weight=${subtitle.fontWeight}`);
        }

        const h1 = byTitle('Heading 1'), h2 = byTitle('Heading 2'), h3 = byTitle('Heading 3');
        if (h1 && h2 && h3) {
            check('Heading hierarchy: H1 > H2 > H3',
                h1.fontSize > h2.fontSize && h2.fontSize > h3.fontSize,
                `H1=${h1.fontSize}  H2=${h2.fontSize}  H3=${h3.fontSize}`);
            check('Headings 1-3 are bold',
                h1.fontWeight >= 600 && h2.fontWeight >= 600 && h3.fontWeight >= 600,
                `weights ${h1.fontWeight}/${h2.fontWeight}/${h3.fontWeight}`);
        }
        if (title && h1) {
            check('Title is bigger than Heading 1',
                title.fontSize > h1.fontSize,
                `Title=${title.fontSize}px  H1=${h1.fontSize}px`);
        }
        const blockQuote = byTitle('Block Quotation');
        if (blockQuote) {
            check('Block Quotation is italic',
                blockQuote.fontStyle === 'italic', `fontStyle=${blockQuote.fontStyle}`);
        }

        // ── Closeups of the first few entries for the report. Entry rects
        //    are iframe-relative; offset by the iframe's page position.
        const ifEl = await page.$('iframe');
        const ifBox = await ifEl.boundingBox();
        for (const v of visible.slice(0, 6)) {
            const slug = v.title.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase();
            await snap(page, `entry_${slug}`, {
                x: Math.max(0, ifBox.x + v.rect.x - 4),
                y: Math.max(0, ifBox.y + v.rect.y - 4),
                width: v.rect.w + 8,
                height: v.rect.h + 8,
            });
        }

        // ── Open the More-options dropdown so the FULL style list (custom
        //    Tresorit styles included) is visible. Real mouse click.
        const expRect = await frame.evaluate(() => {
            const el = document.getElementById('stylesview-iconview-list-expand-button');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        if (expRect) {
            await page.mouse.click(ifBox.x + expRect.x, ifBox.y + expRect.y);
            await sleep(2000);
            await snap(page, 'dropdown_open_full_list');

            const dropdownTitles = await frame.evaluate(() => {
                const all = document.querySelectorAll('.ui-iconview-entry > span[title]');
                const seen = new Set();
                const out = [];
                all.forEach(s => { if (!seen.has(s.title)) { seen.add(s.title); out.push(s.title); } });
                return out;
            });

            const customWanted = ['Tresorit Title', 'Tresorit Heading',
                'Tresorit Subhead', 'Tresorit Quote', 'Tresorit Caption'];
            const customPresent = customWanted.filter(s => dropdownTitles.includes(s));
            check('All 5 custom styles enumerated by the kit',
                customPresent.length === customWanted.length,
                `present=${customPresent.length}/${customWanted.length} `
                + `missing=${customWanted.filter(s => !customPresent.includes(s)).join(',')}`);

            // ── Phase 2 expected-fails: custom styles should ALSO preview.
            const dropdownStyles = await frame.evaluate(() => {
                const map = {};
                document.querySelectorAll('.ui-iconview-entry > span[title]').forEach(s => {
                    const cs = getComputedStyle(s);
                    if (!map[s.title]) {
                        map[s.title] = {
                            fontSize: parseFloat(cs.fontSize),
                            fontWeight: parseInt(cs.fontWeight, 10),
                            fontStyle: cs.fontStyle,
                        };
                    }
                });
                return map;
            });
            const tt = dropdownStyles['Tresorit Title'];
            const bt = dropdownStyles['Body Text'];
            if (tt && bt) {
                checkExpectedFail(
                    'Custom "Tresorit Title" font-size differs from Body Text',
                    Math.abs(tt.fontSize - bt.fontSize) > 2,
                    `Tresorit Title=${tt.fontSize}px  Body Text=${bt.fontSize}px`);
                checkExpectedFail(
                    'Custom "Tresorit Title" is bold',
                    tt.fontWeight >= 600, `weight=${tt.fontWeight}`);
            }
            await snap(page, 'dropdown_with_custom_styles');
        } else {
            log('  (no expander; dropdown not opened — skipping custom-styles closeup)');
        }

        await snap(page, 'final_state');
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
