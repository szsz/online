const __cl = require('../../lib/inject-checklist');
// Regression: ribbon Styles iconview entries must visually preview the
// effect of applying that style — Title looks bold + large, Body Text
// looks small/regular, Heading 1 sits between, etc. Before this fix
// every entry rendered as identical 14 px Ubuntu placeholder text and
// the picker conveyed no visual information.
//
// Phase 1 (this regression) — built-in style names. CSS in
// notebookbar.css keys off [title="..."]. Test asserts computed
// font-size + weight + italic on the placeholder spans for the
// built-ins we know LO ships in a Writer template.
//
// Phase 2 (separate PR, gated on /lo-roll) — LO core gains per-style
// visual-properties payload, Widget.IconView.ts already sets
// data-style-id on the placeholder so a runtime-injected stylesheet
// can target by stable internal id. Custom user styles like
// "Tresorit Title" will then render with their own font-size /
// weight / color too. Today they fall through to the default rule
// and render as plain placeholder text — that's the current expected
// state; the EXPECTED-FAIL assertions below pin it.
//
// Fixture: test/data/custom-styles.docx (5 custom paragraph styles
// alongside built-ins). Confirmed earlier: the kit enumerates all 5
// custom styles into the picker.

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

const VIEWER  = env.FILE_STORAGE_URL;
const FIXTURE = path.join(__dirname, '..', 'test', 'data', 'custom-styles.docx');
const NAME    = `regression-stylesview-preview-${Date.now()}.docx`;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-stylesview-preview';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0    = Date.now();
const log   = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  PASS: ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

// "Expected fail" — record as a soft fail. Test still passes overall
// while phase 2 is outstanding; the line tells reviewers what's still
// gated on the LO-core change. Once /lo-roll lands, flip to check().
function checkExpectedFail(label, cond, ev) {
    __cl.recordCheck(label + ' (EXPECTED FAIL until phase 2 / LO roll)', cond, ev);
    if (cond) log(`  PASS UNEXPECTED: ${label}${ev ? ' [' + ev + ']' : ''}  ← phase 2 may have landed?`);
    else      log(`  expected-fail: ${label}${ev ? ' [' + ev + ']' : ''}`);
}

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}`, fullPage: false }); }
    catch (_) {}
}

async function snapClip(page, name, clip) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}`, clip }); }
    catch (_) {}
}

(async () => {
    log('=== Regression: stylesview ribbon preview ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(FIXTURE)) {
        log(`SKIP: fixture missing: ${FIXTURE}`);
        process.exit(2);
    }

    const bytes = fs.readFileSync(FIXTURE);
    const up    = await uploadV2(VIEWER, NAME, bytes);
    const url   = `${VIEWER}/?singleuser#file=${up.b64urlSecret}`;
    log(`uploaded ${NAME} (${(bytes.length / 1024).toFixed(0)}KB)`);

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded',
                              timeout: env.scaleTimeout(120000) });

        // Wait for the editor frame + canvas + ribbon to settle.
        let frame = null;
        for (let i = 0; i < 90 && !frame; i++) {
            frame = page.frames().find(f => f.url().includes('cool.html'));
            if (frame && !(await frame.$('#document-canvas').catch(() => null))) frame = null;
            if (!frame) await sleep(1000);
        }
        if (!frame) throw new Error('editor frame never loaded');
        await sleep(4000);   // settle for stylesview population

        await snap(page, 'editor_loaded');

        // Crop a screenshot of just the ribbon strip — that's what the
        // visible bug + fix is about. The viewer's URL bar / file name
        // sits above (~y=0..30) and the ribbon proper is ~y=30..130.
        await snapClip(page, 'ribbon_top_full', {
            x: 0, y: 0, width: 1600, height: 220,
        });

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
                        return { x: r.x|0, y: r.y|0, w: r.width|0, h: r.height|0 }; })(),
                };
            }).filter(Boolean);
        });
        log(`Visible stylesview entries: ${visible.length}`);
        for (const v of visible) {
            log(`  ${v.title.padEnd(20)} fontSize=${v.fontSize}px  weight=${v.fontWeight}  ${v.fontStyle}`);
        }

        // Helper: find an entry by visible title.
        const byTitle = t => visible.find(v => v.title === t);

        // ── Headline asserts on built-in styles ─────────────────────
        // Title must be the visual peak — bigger and bolder than Body Text.
        const title = byTitle('Title');
        const bodyText = byTitle('Body Text');
        if (title && bodyText) {
            check('Title is BIGGER than Body Text',
                  title.fontSize > bodyText.fontSize + 2,
                  `Title=${title.fontSize}px  Body=${bodyText.fontSize}px`);
            check('Title is BOLD (weight >= 600)',
                  title.fontWeight >= 600,
                  `weight=${title.fontWeight}`);
            check('Body Text is REGULAR (weight < 600)',
                  bodyText.fontWeight < 600,
                  `weight=${bodyText.fontWeight}`);
        } else {
            check('Title + Body Text both present in picker',
                  false,
                  `Title=${!!title} BodyText=${!!bodyText}`);
        }

        // Subtitle: smaller than Title, not bold.
        const subtitle = byTitle('Subtitle');
        if (subtitle && title) {
            check('Subtitle is smaller than Title',
                  subtitle.fontSize < title.fontSize,
                  `Subtitle=${subtitle.fontSize}px  Title=${title.fontSize}px`);
            check('Subtitle is NOT bold (weight < 600)',
                  subtitle.fontWeight < 600,
                  `weight=${subtitle.fontWeight}`);
        }

        // Heading hierarchy: H1 > H2 > H3, all bold.
        const h1 = byTitle('Heading 1'), h2 = byTitle('Heading 2'), h3 = byTitle('Heading 3');
        if (h1 && h2 && h3) {
            check('Heading hierarchy: H1 > H2 > H3',
                  h1.fontSize > h2.fontSize && h2.fontSize > h3.fontSize,
                  `H1=${h1.fontSize}  H2=${h2.fontSize}  H3=${h3.fontSize}`);
            check('Headings 1-3 are bold',
                  h1.fontWeight >= 600 && h2.fontWeight >= 600 && h3.fontWeight >= 600,
                  `weights ${h1.fontWeight}/${h2.fontWeight}/${h3.fontWeight}`);
        }

        // Headings are below Title in the visual hierarchy.
        if (title && h1) {
            check('Title is bigger than Heading 1',
                  title.fontSize > h1.fontSize,
                  `Title=${title.fontSize}px  H1=${h1.fontSize}px`);
        }

        // Block Quotation should be italic (when present in visible set).
        const blockQuote = byTitle('Block Quotation');
        if (blockQuote) {
            check('Block Quotation is italic',
                  blockQuote.fontStyle === 'italic',
                  `fontStyle=${blockQuote.fontStyle}`);
        }

        // ── Closeups: snap the first few entry rects so the per-test
        //    HTML report shows reviewers what each preview looks like.
        for (const v of visible.slice(0, 6)) {
            const slug = v.title.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase();
            // Ribbon entries are inside the iframe; iframe origin is at
            // page coords ~ (x=0, y=ribbon-top). Their rect.* is iframe-
            // relative; the editor iframe sits below the viewer's top
            // chrome (~30 px). Approximate.
            const PAGE_X_OFFSET = 0, PAGE_Y_OFFSET = 0;
            await snapClip(page, `entry_${slug}`, {
                x: Math.max(0, v.rect.x + PAGE_X_OFFSET - 4),
                y: Math.max(0, v.rect.y + PAGE_Y_OFFSET - 4),
                width: v.rect.w + 8,
                height: v.rect.h + 8,
            });
        }

        // ── Open the More-options dropdown so the full style list
        //    (including custom Tresorit styles) is visible in the report.
        const expander = await frame.$('#stylesview-iconview-list-expand-button');
        if (expander) {
            await expander.click();
            await sleep(2000);
            await snap(page, 'dropdown_open_full_list');

            // Scroll inside the dropdown if needed and check our custom
            // styles are present (kit enumerates them). The picker
            // includes ~70 styles total — custom + built-in.
            const dropdownTitles = await frame.evaluate(() => {
                const all = document.querySelectorAll('.ui-iconview-entry > span[title]');
                const seen = new Set();
                const out = [];
                all.forEach(s => { if (!seen.has(s.title)) { seen.add(s.title); out.push(s.title); } });
                return out;
            });

            const customWanted = ['Tresorit Title', 'Tresorit Heading',
                                  'Tresorit Subhead', 'Tresorit Quote',
                                  'Tresorit Caption'];
            const customPresent = customWanted.filter(s => dropdownTitles.includes(s));
            check('All 5 custom styles enumerated by the kit',
                  customPresent.length === customWanted.length,
                  `present=${customPresent.length}/${customWanted.length} ` +
                  `missing=${customWanted.filter(s => !customPresent.includes(s)).join(',')}`);

            // ── Phase 2 expected-fails ─────────────────────────────
            // Custom styles should ALSO get a visual preview. Today they
            // fall through to the default rule (11px regular serif) so
            // their font-size matches the default. After phase 2, the
            // runtime-injected stylesheet driven by the LO-core manifest
            // will give each its declared visual style.
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

            // Tresorit Title is declared as 32pt bold blue in the docx.
            // Phase 1 has no rule for it → default 11px regular. Phase 2
            // should differentiate it from Body Text.
            const tt = dropdownStyles['Tresorit Title'];
            const bt = dropdownStyles['Body Text'];
            if (tt && bt) {
                checkExpectedFail(
                    'Custom "Tresorit Title" font-size differs from Body Text',
                    Math.abs(tt.fontSize - bt.fontSize) > 2,
                    `Tresorit Title=${tt.fontSize}px  Body Text=${bt.fontSize}px`);
                checkExpectedFail(
                    'Custom "Tresorit Title" is bold',
                    tt.fontWeight >= 600,
                    `weight=${tt.fontWeight}`);
            }

            await snap(page, 'dropdown_with_custom_styles');
        } else {
            log('  (no expander; dropdown not opened — skipping custom-styles closeup)');
        }

        await snap(page, 'final_state');

        log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    } finally {
        await browser.close();
    }

    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e.stack || e.message);
    process.exit(2);
});
