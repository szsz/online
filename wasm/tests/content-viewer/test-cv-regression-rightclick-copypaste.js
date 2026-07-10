// test-cv-regression-rightclick-copypaste.js — right-click → Copy / Paste
// through the context menu, in the Tresorit content-viewer
// (/collabora-tester).
//
// The right-click path goes through a meaningfully different chain
// (Control.ContextMenu.js → Clipboard.js _execCopyCutPaste →
// _navigatorClipboardRead/Write) that bypasses wasm-loader.js's
// document.onpaste handler entirely. This test:
//   - opens a Writer doc
//   - types known text + drag-selects across it
//   - right-clicks the canvas with REAL puppeteer mouse events
//   - finds the 'Copy' context-menu item by visible label and REAL-clicks
//     it by bounding box (no element.click(), no dispatcher shortcut)
//   - moves the caret to end via real keystrokes, presses Ctrl+V (real)
//   - asserts the char count grew — proves the right-click→Copy flow's
//     clipboard contents are pastable
//   - probes navigator.clipboard.readText() — hard assertion that the
//     external/system clipboard received the copied text (backed by the
//     wasm-loader.js /cool/clipboard GET stub; without it the write
//     silently drops its payload and readText() comes back empty)
//
// Migrated from wasm/tests/regression/test-regression-rightclick-copypaste.js
// — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-rightclick-copypaste.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const {
    openBytesViaContentViewer, waitCvInteractive, cvEditorFrame,
    cvCharCount, waitCvCharCount,
} = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/regression-rightclick-copypaste';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
let shotN = 0;
async function snap(page, name) {
    try {
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${SHOT_DIR}/${String(++shotN).padStart(2, '0')}_${name}.png` });
    } catch (e) {}
}

// Real puppeteer click on a context-menu item with a visible label matching
// labelRegex. The menu DOM lives inside the editor iframe, so the item's
// getBoundingClientRect (frame coords) is offset by the iframe's page-level
// bounding box before the real mouse click. DOM-state read only — the click
// itself is a genuine page.mouse.click.
async function realClickMenuItem(page, ifBox, labelRegex) {
    let bbox = null;
    for (let i = 0; i < 30; i++) {
        const fr = cvEditorFrame(page);
        bbox = fr ? await fr.evaluate((src, flags) => {
            const re = new RegExp(src, flags);
            // Items live in `.context-menu-item` (Control.ContextMenu.js).
            const items = Array.from(document.querySelectorAll('.context-menu-item'));
            const found = items.find(el => re.test(el.textContent || ''));
            if (!found) return null;
            const r = found.getBoundingClientRect();
            return { x: r.left, y: r.top, w: r.width, h: r.height,
                     t: (found.textContent || '').trim().substring(0, 60) };
        }, labelRegex.source, labelRegex.flags).catch(() => null) : null;
        if (bbox && bbox.w > 0 && bbox.h > 0) break;
        await sleep(150);
    }
    if (!bbox) return { ok: false, why: 'menu item not found' };
    await page.mouse.click(ifBox.x + bbox.x + bbox.w / 2, ifBox.y + bbox.y + bbox.h / 2);
    return { ok: true, item: bbox.t };
}

(async () => {
    log('=== Regression: right-click → Copy → Ctrl+V pastes content ===');
    if (!fs.existsSync(FIXTURE)) { log(`SKIP: fixture missing: ${FIXTURE}`); process.exit(2); }
    log('viewer: ' + BASE);
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    const { browser, cleanup } = await launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        const cdp = await page.target().createCDPSession();
        try {
            await cdp.send('Browser.grantPermissions', {
                permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
            });
        } catch (e) {}

        // Capture clipboard-related errors + the wasm-loader's clipboard
        // log lines (so we can see whether the GET stub actually fired).
        const clipboardErrors = [];
        const clipboardLogs = [];
        page.on('pageerror', e => {
            if (/clipboard|paste|copy/i.test(e.message)) {
                clipboardErrors.push(e.message.substring(0, 200));
            }
        });
        page.on('console', m => {
            const t = m.text();
            if (/wasm-loader|wasm-loader-diag|Clipboard GET stub|Clipboard POST stub|onpaste|Internal paste|External paste|navigator\.clip|textselectioncontent|cached textselectioncontent/i.test(t)) {
                clipboardLogs.push(t.substring(0, 200));
            }
        });

        log('open writer via /collabora-tester');
        const bytes = fs.readFileSync(FIXTURE);
        await openBytesViaContentViewer(browser, BASE,
            'rightclick-cp-' + Date.now() + '.docx', bytes, { page, iframeTimeout: 60000 });
        check('editor became interactive (Save enabled)', await waitCvInteractive(page, LOAD_BUDGET));
        const wc0 = await waitCvCharCount(page, c => c >= 0, 60000);
        await sleep(3000);
        await snap(page, 'loaded');
        log(`initial #StateWordCount: ${wc0}`);

        const iframeEl = await page.$('iframe');
        const ifBox = await iframeEl.boundingBox();
        const clickX = ifBox.x + ifBox.width / 2;
        const clickY = ifBox.y + Math.min(ifBox.height * 0.55, 450);

        // Focus + click into the canvas to place a caret, then type a marker.
        // The FIRST click into a freshly-opened canvas can be absorbed by
        // focus-init without placing a caret; a no-op type adds 0 chars, so
        // retry click+type until the count actually moves — failed attempts
        // add nothing, so the exact-delta assertion below still holds.
        const MARKER = 'rcMarker';
        log(`Typing "${MARKER}" via real keystrokes`);
        let wcAfterType = wc0;
        for (let attempt = 1; attempt <= 4; attempt++) {
            await page.mouse.click(clickX, clickY);
            await sleep(500);
            await page.keyboard.type(MARKER, { delay: 50 });
            await sleep(1200);
            wcAfterType = await cvCharCount(page);
            if (wcAfterType - wc0 >= MARKER.length) break;
            log(`  marker-type attempt ${attempt} was a no-op (delta=${wcAfterType - wc0}); retrying`);
        }
        await snap(page, 'after_typing');
        log(`after-type #StateWordCount: ${wcAfterType}`);
        check('typing increased char count by len(marker)',
            wcAfterType - wc0 === MARKER.length,
            `delta=${wcAfterType - wc0} expected=${MARKER.length}`);

        // Locate the blinking cursor (it sits right after the typed marker)
        // to anchor the drag-select on the actual text line — in a
        // near-blank doc the typed text lands at the document TOP, so
        // fixed mid-page coords would cross empty space.
        const fr0 = cvEditorFrame(page);
        const cursorBox = fr0 ? await fr0.evaluate(() => {
            const el = document.querySelector('.blinking-cursor');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, h: r.height };
        }).catch(() => null) : null;
        const cy = cursorBox ? ifBox.y + cursorBox.y + cursorBox.h / 2 : clickY;
        const cx = cursorBox ? ifBox.x + Math.max(cursorBox.x - 40, 20) : clickX;

        // Drag-select a span of characters along the text line with real
        // mouse.move + mouse.down + mouse.up so the kit receives a proper
        // buttondown / mousemove / buttonup sequence.
        await page.mouse.move(cx - 80, cy);
        await sleep(150);
        await page.mouse.down({ button: 'left' });
        await page.mouse.move(cx + 80, cy, { steps: 10 });
        await page.mouse.up({ button: 'left' });
        await sleep(900);
        await snap(page, 'after_select');

        // RIGHT-CLICK on the canvas — this is the test's whole point.
        log('Real-right-click on canvas …');
        await page.mouse.click(cx, cy, { button: 'right' });

        // Wait for the context menu (Control.ContextMenu.js creates
        // `.on-the-fly-context-menu`).
        let menuVisible = false;
        for (let i = 0; i < 30 && !menuVisible; i++) {
            const fr = cvEditorFrame(page);
            menuVisible = fr ? await fr.evaluate(() =>
                !!document.querySelector('.on-the-fly-context-menu') ||
                !!document.querySelector('.context-menu-list')
            ).catch(() => false) : false;
            if (!menuVisible) await sleep(150);
        }
        await snap(page, 'context_menu_open');
        check('context menu opens on right-click', menuVisible === true);

        if (!menuVisible) {
            log('No context menu — aborting subsequent checks');
        } else {
            // Enumerate items for diagnostic visibility.
            const fr = cvEditorFrame(page);
            const items = fr ? await fr.evaluate(() => {
                const els = Array.from(document.querySelectorAll('.context-menu-item'));
                return els.map(el => (el.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 60));
            }).catch(() => []) : [];
            log(`context-menu items (${items.length}): ${JSON.stringify(items.slice(0, 12))}`);

            // Real-click the 'Copy' menu item. The label may include a
            // shortcut suffix like "Copy\tCtrl+C" — match the word boundary.
            const copy = await realClickMenuItem(page, ifBox, /\bCopy\b/);
            check('"Copy" menu item present + clickable', copy.ok === true, copy.item || copy.why);
            await sleep(1200);
            await snap(page, 'after_copy');

            // Move caret to end of doc.
            await page.keyboard.down('Control');
            await page.keyboard.press('End');
            await page.keyboard.up('Control');
            await sleep(500);

            // Ctrl+V — paste the just-copied text.
            await page.keyboard.down('Control');
            await page.keyboard.press('v');
            await page.keyboard.up('Control');
            await sleep(2000);
            await snap(page, 'after_paste');

            const wcAfterPaste = await cvCharCount(page);
            log(`after-paste #StateWordCount: ${wcAfterPaste}`);
            // Kit-side assertion: paste must have added SOMETHING. The exact
            // char delta depends on what the drag-select grabbed, so assert
            // "more than zero" — that proves right-click Copy populated the
            // kit's clipboard AND the subsequent Ctrl+V pasted it.
            check('right-click Copy + Ctrl+V pasted content into doc',
                wcAfterPaste - wcAfterType > 0,
                `delta=${wcAfterPaste - wcAfterType}`);

            // Hard assertion: the external/system clipboard must receive the
            // copied text (via the wasm-loader.js /cool/clipboard GET stub).
            const extClip = await page.evaluate(async () => {
                try {
                    const t = await navigator.clipboard.readText();
                    return { ok: true, text: t.substring(0, 200) };
                } catch (e) {
                    return { ok: false, why: String(e).substring(0, 200) };
                }
            });
            log(`navigator.clipboard.readText() after right-click Copy: ` +
                `ok=${extClip.ok} text="${extClip.text || ''}" why=${extClip.why || ''}`);
            check('navigator.clipboard.readText() returns non-empty text ' +
                '(external clipboard write succeeded via /cool/clipboard GET stub)',
                extClip.ok === true && extClip.text && extClip.text.length > 0,
                extClip.ok ? `len=${(extClip.text || '').length}` : extClip.why);
        }

        log(`clipboard logs captured (${clipboardLogs.length}):`);
        clipboardLogs.slice(-12).forEach(e => log(`  L| ${e}`));
        if (clipboardErrors.length) {
            log(`captured ${clipboardErrors.length} clipboard-related pageerrors:`);
            clipboardErrors.slice(0, 5).forEach(e => log(`  ! ${e}`));
        }
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        try { await (cleanup ? cleanup() : browser.close()); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
