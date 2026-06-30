// Regression: single-user is the DEFAULT viewer mode (2026-06-17); co-editing
// is opt-in via the ?co-editing URL param and the in-app "Co-edit" toggle
// button. This locks the inversion in place:
//
//   1. Default open (no param)  → editor iframe URL has NO `&relay=`
//      (single-user); relay-adapter logs "Single-user mode".
//   2. coEditing:true (?co-editing) → iframe URL carries `&relay=`;
//      relay-adapter logs "Connecting to <relay>".
//   3. Real-UI: clicking #coedit-toggle in a single-user session reloads the
//      page into ?co-editing and the iframe then carries `&relay=`.
//
// Real user-input only: the button is clicked via page.click on the visible
// viewer chrome; outcomes are read from the DOM (iframe src / title / url).
// No sendUnoCommand / dispatcher / state injection.

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { openViaViewer } = require('../../lib/open-via-viewer');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-coediting-toggle';
const TIMEOUT = env.scaleTimeout(180000);
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');

const T0 = Date.now();
const elapsed = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';
const log = m => console.log(`[${elapsed()}] ${m}`);

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2, '0')}_${elapsed()}_${name}.png`;
    await page.screenshot({ path: `${SHOT_DIR}/${f}` }).catch(() => {});
    log(`[snap] ${f}`);
}

let allPassed = true;
function check(label, cond) {
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}`); allPassed = false; }
}

// Read the live editor iframe src from the viewer top window (DOM read).
const iframeSrc = page => page.evaluate(() => {
    const el = document.getElementById('editor-frame');
    return el && el.src ? el.src : '';
}).catch(() => '');

const titleOf = page => page.evaluate(() => document.title).catch(() => '');

function waitForWriter(frame) {
    return frame.waitForFunction(() => {
        const wc = document.querySelector('#StateWordCount');
        return wc && wc.textContent && wc.textContent.includes('characters');
    }, { timeout: TIMEOUT });
}

// Poll the active editor-frame src until it's a real file iframe (cool.html,
// not the prewarm-blank bootstrap). Used after the button-triggered reload.
async function waitForFileIframe(page) {
    const t0 = Date.now();
    while (Date.now() - t0 < TIMEOUT) {
        const src = await iframeSrc(page);
        if (src.indexOf('cool.html') >= 0 && src.indexOf('__prewarm_blank') < 0)
            return src;
        await sleep(250);
    }
    return '';
}

(async () => {
    const { browser, cleanup } = await launch();
    const bytes = fs.readFileSync(FIXTURE);
    try {
        // ── 1. DEFAULT = single-user ────────────────────────────────────
        log('=== 1. default open (no param) — expect single-user ===');
        const relayLogs1 = [];
        const r1 = await openViaViewer(browser, VIEWER, 'new.docx', bytes, {
            gotoTimeout: 30000, iframeTimeout: TIMEOUT,
            onPage: p => p.on('console', m => {
                const t = m.text();
                if (t.includes('[relay]')) relayLogs1.push(t);
            }),
        });
        await waitForWriter(r1.editorFrame);
        await snap(r1.page, 'default_loaded');
        const src1 = await iframeSrc(r1.page);
        log(`  iframe src: ${src1.slice(0, 140)}`);
        check('default: iframe URL has NO &relay= (single-user)',
            src1.indexOf('relay=') === -1);
        check('default: top URL has no ?co-editing',
            (r1.page.url().indexOf('co-editing') === -1));
        check('default: title is "Viewer (Single User)"',
            (await titleOf(r1.page)).includes('Single User'));
        await sleep(1500);
        check('default: relay-adapter logged single-user mode',
            relayLogs1.some(t => /single-user/i.test(t)));
        await r1.page.close();

        // ── 2. coEditing:true (?co-editing) = relay connects ────────────
        log('=== 2. open with coEditing:true — expect relay ===');
        const relayLogs2 = [];
        const r2 = await openViaViewer(browser, VIEWER, 'new.docx', bytes, {
            coEditing: true, gotoTimeout: 30000, iframeTimeout: TIMEOUT,
            onPage: p => p.on('console', m => {
                const t = m.text();
                if (t.includes('[relay]')) relayLogs2.push(t);
            }),
        });
        await waitForWriter(r2.editorFrame);
        await snap(r2.page, 'coediting_loaded');
        const src2 = await iframeSrc(r2.page);
        log(`  iframe src: ${src2.slice(0, 160)}`);
        check('co-editing: iframe URL carries &relay=',
            src2.indexOf('relay=') !== -1);
        check('co-editing: top URL has ?co-editing',
            r2.page.url().indexOf('co-editing') !== -1);
        check('co-editing: title is "Viewer (Co-editing)"',
            (await titleOf(r2.page)).includes('Co-editing'));
        await sleep(1500);
        check('co-editing: relay-adapter logged "Connecting to"',
            relayLogs2.some(t => /Connecting to/i.test(t)));
        await r2.page.close();

        // ── 3. Button toggle via REAL UI ───────────────────────────────
        log('=== 3. click #coedit-toggle in single-user → reload into co-editing ===');
        const r3 = await openViaViewer(browser, VIEWER, 'new.docx', bytes, {
            gotoTimeout: 30000, iframeTimeout: TIMEOUT,
        });
        await waitForWriter(r3.editorFrame);
        const page = r3.page;
        check('toggle pre-state: single-user (no &relay=)',
            (await iframeSrc(page)).indexOf('relay=') === -1);

        // Reveal the sidebar (it auto-collapses once a doc loads): move the
        // cursor into the 8px hover-zone at the left edge, then onto #files.
        await page.mouse.move(4, 400);
        await sleep(700);
        await page.waitForSelector('#coedit-toggle', { visible: true, timeout: 10000 });
        await snap(page, 'toggle_sidebar_revealed');

        // Real click → handler sets location.href (full navigation/reload).
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: TIMEOUT }),
            page.click('#coedit-toggle'),
        ]);
        log(`  reloaded → ${page.url().slice(0, 90)}`);
        check('after click: top URL gained ?co-editing',
            page.url().indexOf('co-editing') !== -1);

        const src3 = await waitForFileIframe(page);
        log(`  post-reload iframe src: ${src3.slice(0, 160)}`);
        await snap(page, 'toggle_after_reload');
        check('after click: iframe URL now carries &relay=',
            src3.indexOf('relay=') !== -1);
        check('after click: title is "Viewer (Co-editing)"',
            (await titleOf(page)).includes('Co-editing'));
        await page.close();

        log('\n' + '='.repeat(50));
        if (allPassed) log('✓ ALL CO-EDITING-MODE-TOGGLE TESTS PASSED');
        else { log('✗ SOME TESTS FAILED'); process.exitCode = 1; }
    } catch (err) {
        log('FAIL: ' + err.message);
        console.error(err);
        process.exitCode = 1;
    } finally {
        await cleanup();
    }
})();
