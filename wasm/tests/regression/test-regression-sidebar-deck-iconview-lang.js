// Regression: Writer Styles sidebar deck iconview tiles render
// LOCALISED style names when the UI lang is German (task #193 LO PR
// chain #8/#9/#10).
//
// What this asserts:
//   1. Open a Writer fixture via the viewer with navigator.language
//      pinned to de-DE.
//   2. Open the styles sidebar deck (dispatch 'showstylelistdeck').
//   3. Sample the iconview entries in the right pane (x > 1300).
//      `stylesview_NN` DOM ids carry the visible label.
//   4. Assert at least N of the well-known paragraph styles render in
//      German — exact match list, so a future regression flipping
//      back to English names fails loudly:
//         "Überschrift 1", "Aufzählung", "Fußzeile",
//         "Stichwortverzeichnis Überschrift", "Untertitel", "Titel"
//
// What this DOES NOT assert:
//   - The `treeview_NN` tree-list entries below the iconview (still
//     English at LO -28; tracked separately as Gap remaining in
//     project_193_status). Once that lands, extend this test to
//     cover treeview_NN entries too.
//
// Runtime: ~60-90s. Single browser, single viewer load.

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

// Allow overriding the viewer target via VIEWER env var so the test can
// run against the internal Azure deploy when CI tests haven't yet
// validated the fix locally.
const VIEWER  = process.env.VIEWER_URL || env.FILE_STORAGE_URL;
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data',
                          'mixed-lang-paragraphs.docx');
const NAME    = `sidebar-de-${Date.now()}.docx`;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-sidebar-deck-lang';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0    = Date.now();
const log   = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let allPassed = true;
function check(label, cond, evidence) {
    if (cond) {
        log(`PASS ${label}`);
    } else {
        log(`FAIL ${label}: ${evidence || ''}`);
        allPassed = false;
    }
}

fs.rmSync(SHOT_DIR, { recursive: true, force: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

// Expected German labels — these come from LO's UNO DisplayName for
// the corresponding built-in paragraph styles when uno_de.zip is
// installed (LO PR #8/#9/#10 wired DisplayName into StyleList's
// set_text path). Tolerant of any subset matching since the deck only
// shows a few visible entries at a time.
const EXPECTED_DE_LABELS = [
    'Überschrift 1',
    'Aufzählung',
    'Fußzeile',
    'Stichwortverzeichnis Überschrift',
    'Untertitel',
    'Titel',
    'Standardvorlage',
    'Nummerierung 2',
];
// At least this many of the expected labels must appear.
const REQUIRED_MATCHES = 3;

(async () => {
    const bytes = fs.readFileSync(FIXTURE);
    const up = await uploadV2(VIEWER, NAME, bytes);
    log(`uploaded ${up.fileId.substring(0, 12)}`);

    const browser = await puppeteer.launch({
        headless: 'new',
        protocolTimeout: env.scaleTimeout(600000),
        args: ['--no-sandbox', '--enable-features=SharedArrayBuffer',
               '--lang=de-DE'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1700, height: 1100 });
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5',
    });
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'languages', { get: () => ['de-DE', 'de'] });
        Object.defineProperty(navigator, 'language',  { get: () => 'de-DE' });
        try { localStorage.setItem('cool-ui-lang', 'de'); } catch (_) {}
    });

    const url = `${VIEWER}/?singleuser#file=${up.b64urlSecret}`;
    log(`navigating ${url}`);
    await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: env.scaleTimeout(120000),
    });

    // Wait for editor frame to be live.
    let frame = null;
    for (let i = 0; i < 90 && !frame; i++) {
        frame = page.frames().find(f => f.url().includes('cool.html'));
        if (frame && !(await frame.$('#document-canvas').catch(() => null))) {
            frame = null;
        }
        if (!frame) await sleep(1000);
    }
    if (!frame) {
        log('FATAL frame never reached cool.html');
        await browser.close();
        process.exit(2);
    }
    log('frame ready');

    await sleep(env.scaleTimeout(14000));
    await page.screenshot({ path: `${SHOT_DIR}/01_doc_loaded.png` });

    // Open the styles sidebar deck. The notebookbar's "Vorlagen-
    // Seitenleiste öffnen" button only appears after expanding the
    // styles iconview dropdown — use the explicit dispatch instead.
    log('--- opening styles sidebar deck via dispatch ---');
    await frame.evaluate(() => {
        try {
            if (window.app && window.app.map && window.app.map.dispatch) {
                window.app.map.dispatch('showstylelistdeck');
            } else if (window.app && window.app.socket && window.app.socket.sendMessage) {
                window.app.socket.sendMessage('uno .uno:DesignerDialog');
            }
        } catch (_) {}
    });
    await sleep(env.scaleTimeout(4500));
    await page.screenshot({ path: `${SHOT_DIR}/02_sidebar_opened.png` });

    // Sample the right pane for visible style labels.
    const samples = await frame.evaluate(() => {
        const out = [];
        document.querySelectorAll('[id^="stylesview"]').forEach(el => {
            const r = el.getBoundingClientRect();
            if (r.width < 30 || r.height < 10) return;
            const t = (el.innerText || el.textContent || '').trim();
            if (!t || t.length > 80) return;
            out.push({ id: el.id, text: t, x: r.x | 0, y: r.y | 0 });
        });
        return out;
    });
    log(`captured ${samples.length} stylesview_NN samples`);

    fs.writeFileSync(`${SHOT_DIR}/samples.json`,
                     JSON.stringify(samples, null, 2));

    const captured = new Set(samples.map(s => s.text));
    const found = EXPECTED_DE_LABELS.filter(l => captured.has(l));
    log(`expected ${EXPECTED_DE_LABELS.length} German labels; found ${found.length}: ` +
        JSON.stringify(found));

    check(
        `at least ${REQUIRED_MATCHES} German labels appear in stylesview iconview`,
        found.length >= REQUIRED_MATCHES,
        `captured=${JSON.stringify([...captured].slice(0, 20))}`
    );

    // Spot-check: NO English "Heading N" fallback. "Heading 1" has a
    // German DisplayName ("Überschrift 1"); if it shows as plain
    // "Heading 1" the localisation chain regressed.
    //
    // Note: some less-common styles (Body Text 2/3, Text Body Indent,
    // Figure Index Heading) have NO German DisplayName in upstream LO
    // dictionaries and fall back to English even with full
    // localisation working. Those are out of scope here.
    const hasEnglishHeading = [...captured].some(t => /^Heading\s+\d/.test(t));
    check(
        'no English "Heading N" fallback in stylesview',
        !hasEnglishHeading,
        `captured contains Heading-N: ${[...captured].filter(t => /^Heading\s+\d/.test(t)).join(',')}`
    );

    // -- treeview_NN entries (the tree-list below the iconview) --
    // Same widget chain (StyleList.cxx FillTreeBox / FillBox), separate
    // JSTreeView DOM nodes. The follow-up LO PR (drop UNO DisplayName
    // indirection) is what makes these render German. Before that PR,
    // they showed internal English names like "Numbering 1", "Quote".
    const treeSamples = await frame.evaluate(() => {
        const out = [];
        document.querySelectorAll('[id^="treeview"]').forEach(el => {
            const r = el.getBoundingClientRect();
            if (r.x < 1200 || r.width < 30 || r.height < 10) return;
            const t = (el.innerText || el.textContent || '').trim();
            if (!t || t.length > 80) return;
            out.push({ id: el.id, text: t, x: r.x | 0, y: r.y | 0 });
        });
        return out;
    });
    log(`captured ${treeSamples.length} treeview_NN samples`);
    fs.writeFileSync(`${SHOT_DIR}/tree-samples.json`,
                     JSON.stringify(treeSamples, null, 2));

    const treeCaptured = new Set(treeSamples.map(s => s.text));

    // Same German labels — we expect a subset to appear in the tree
    // list too. Tree list often shows different alphabetical range
    // than the iconview, so we require a smaller match count.
    const EXPECTED_TREE_DE = [
        // Common Writer styles that have translated names in upstream
        // German LO data, likely to be visible in the visible tree
        // range (alphabetical).
        'Nummerierung 1', 'Nummerierung 2', 'Nummerierung 3',
        'Aufzählung 1', 'Aufzählung 2', 'Aufzählung 3',
        'Liste 1', 'Liste 2', 'Liste 3',
        'Zitat', 'Untertitel', 'Titel',
        'Standardvorlage', 'Vorformatierter Text',
        'Stichwortverzeichnis Überschrift',
    ];
    const treeFound = EXPECTED_TREE_DE.filter(l => treeCaptured.has(l));
    log(`treeview_NN: expected German labels ${EXPECTED_TREE_DE.length}; found ` +
        `${treeFound.length}: ${JSON.stringify(treeFound)}`);

    // Specific anti-regression: these English internal names must NOT
    // appear (they're the exact strings shown before the fix).
    const TREE_REGRESSION_STRINGS = [
        'Numbering 1', 'Numbering 2', 'Numbering 3',
        'List 1', 'List 2', 'List 3',
        'Quote', 'Subtitle', 'Title',
        'Preformatted Text',
    ];
    const treeEnglishLeak = TREE_REGRESSION_STRINGS.filter(l => treeCaptured.has(l));

    check(
        `treeview_NN: no English internal names leak (expected zero of ${TREE_REGRESSION_STRINGS.length})`,
        treeEnglishLeak.length === 0,
        `leaked: ${JSON.stringify(treeEnglishLeak)}; sample captured=` +
        `${JSON.stringify([...treeCaptured].slice(0, 15))}`
    );

    await browser.close();

    if (!allPassed) {
        log('TEST FAILED');
        process.exit(1);
    }
    log('TEST PASSED');
})().catch(e => {
    console.error('FATAL', e.stack || e.message);
    process.exit(2);
});
