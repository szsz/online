const __cl = require('../../lib/inject-checklist');
// Regression: Bug 3 — search not finding text via Ctrl+F / search input.
//
// User-reported: invoke search (Ctrl+F or the status-bar search input),
// type any token that exists in the doc, press Enter — search reports
// nothing found.
//
// Suspected root cause (read-only inspection):
//
// • The modern Writer search path goes via the Navigator's QuickFind
//   tab. Map.KeyboardShortcuts.ts:333 binds Ctrl+F → dispatch action
//   'home-search'. docdispatcher.ts:161 maps that to
//   uiManager.focusSearch() which (Control.UIManager.ts:1576-1586)
//   does navigator.preFocusQuickFind() + showNavigator() and then
//   the panel's createSearchBar() builds an #navigator-search-input
//   inside #navigation-sidebar.
//
// • The QuickFindPanel jsdialog model is initialized lazily — the kit
//   sends 'uno .uno:QuickFind' (UIManager.initializeQuickFindInCore at
//   line 1454-1459) which makes the core dispatch the QuickFind
//   sidebar deck JSON to the browser. In our run we observed the
//   browser logs:
//     "JSDialogModelState: created new for component: quickfind"
//     repeated, then
//     "JSDialogModelState: model missing in component: quickfind"
//     "executeAction: not found control with id: 'searchoptionsbox'..."
//   which suggests the JSDialogComponent for 'quickfind' is being
//   re-created several times and the second/later renders find no
//   model. The UI never settles into a usable searchable state.
//
// • The legacy mobile #search-input (window.L.DomUtil.get('search-input'))
//   is referenced from SearchService.ts:17,21 — but no JS path
//   creates the element on desktop. App.searchService.search() will
//   crash with TypeError on .value for a null lookup if anything ever
//   tries to call it for a desktop user — and indeed the new path
//   uses NavigatorPanel.useSearchCallback (line 541+) instead.
//
// This test:
//   1. Uploads test/data/new.docx (contains "baseline newcontent").
//   2. Presses Ctrl+F to invoke the search via the dispatched action
//      'home-search'.
//   3. Looks for #navigator-search-input (modern path) OR
//      #search-input (legacy path) becoming visible.
//   4. Types "baseline"; presses Enter.
//   5. Asserts a match was reported (.uno:ExecuteSearch went out;
//      _searchResults populated).

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-search';
const DOC_NAME = 'search-' + Date.now() + '.docx';
const DOC_PATH = path.join(__dirname, '..', 'test', 'data', 'new.docx');
// Token must already be present in the doc body. test/data/new.docx
// contains "baseline newcontent" — "baseline" is our findable token.
const SEARCH_TOKEN = 'baseline';

const T0 = Date.now();
function log(m) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch (e) {}
    log(`[snap] ${f}`);
}

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

async function getEditorFrame(page, fileId) {
    return page.frames().find(f =>
        f.url().includes('cool.html') && (!fileId || f.url().includes(fileId)));
}

async function getStatus(frame) {
    if (!frame) return '';
    try {
        return await frame.evaluate(() =>
            document.querySelector('#StateWordCount')?.textContent?.trim() || '');
    } catch (e) { return ''; }
}

(async () => {
    log('=== Regression Bug 3: search functionality ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(DOC_PATH)) {
        log('ERROR: fixture missing: ' + DOC_PATH);
        process.exit(1);
    }

    const userDataDir = path.join(require('os').tmpdir(),
        'search-' + Date.now() + '-' + process.pid);
    fs.mkdirSync(userDataDir, { recursive: true });

    const { browser, cleanup } = await launch({ width: 1920, height: 1080 });

    try {
        const bytes = fs.readFileSync(DOC_PATH);
        const up = await uploadV2(VIEWER, DOC_NAME, bytes);
        log(`Uploaded ${DOC_NAME} (${(bytes.length / 1024).toFixed(1)} KB)`);

        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        page.on('pageerror', e => log(`[pageerror] ${e.message}`));
        page.on('console', m => {
            const t = m.text();
            if (/search|ExecuteSearch|find|highlight/i.test(t))
                log(`[page] ${t.substring(0, 220)}`);
        });

        const url = VIEWER + '/?singleuser&planc=1#file=' + up.b64urlSecret;
        log(`Navigating to ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

        let frame = null;
        const deadline = Date.now() + 240000;
        while (Date.now() < deadline) {
            await sleep(500);
            frame = await getEditorFrame(page, up.fileId);
            if (!frame) continue;
            const st = await getStatus(frame);
            if (/\d+\s+character/i.test(st)) break;
        }
        check('Editor frame loaded', frame && /\d+\s+character/i.test(await getStatus(frame)));
        if (!frame) throw new Error('editor frame never loaded');

        await sleep(4000);
        await snap(page, 'editor_loaded');

        // Tap outgoing messages so we can see if .uno:ExecuteSearch /
        // .uno:SearchDialog / .uno:QuickFind go out.
        await frame.evaluate(() => {
            try {
                window.__sentMsgs = [];
                const sock = window.app && window.app.socket;
                if (!sock) return;
                const orig = sock.sendMessage.bind(sock);
                sock.sendMessage = function(msg) {
                    try {
                        if (typeof msg === 'string' &&
                            /ExecuteSearch|SearchDialog|QuickFind|search|find/i.test(msg))
                            window.__sentMsgs.push(msg.substring(0, 300));
                    } catch (e) {}
                    return orig(msg);
                };
            } catch (e) {}
        });

        // ── Step 1: Try Ctrl+F to open the search bar ──
        // The browser-level shortcut must reach the iframe and either be
        // intercepted by Map.Keyboard (sending showsearchbar) OR be
        // forwarded to core which posts a UI command back. Click the
        // editor canvas first to focus the iframe.
        const iframeEl = await page.$('iframe#editor-frame');
        const ifBox = await iframeEl.boundingBox();
        await page.mouse.click(ifBox.x + ifBox.width / 2, ifBox.y + ifBox.height / 2);
        await sleep(500);

        await page.keyboard.down('Control');
        await page.keyboard.press('f');
        await page.keyboard.up('Control');
        await sleep(1500);
        await snap(page, 'after_ctrl_f');

        const searchBarsAfterCtrlF = await frame.evaluate(() => {
            const out = {};
            for (const id of ['toolbar-search', 'navigation-sidebar',
                              'search-input', 'navigator-search-input',
                              'navigator-search']) {
                const el = document.getElementById(id);
                if (!el) { out[id] = null; continue; }
                const r = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                out[id] = { display: style.display, visibility: style.visibility,
                            w: r.width, h: r.height };
            }
            return out;
        }).catch(() => ({}));
        log(`Search-related elements after Ctrl+F: ${JSON.stringify(searchBarsAfterCtrlF)}`);
        const someSearchUiVisible =
            (searchBarsAfterCtrlF['navigator-search-input'] && searchBarsAfterCtrlF['navigator-search-input'].w > 0) ||
            (searchBarsAfterCtrlF['search-input'] && searchBarsAfterCtrlF['search-input'].w > 0) ||
            (searchBarsAfterCtrlF['navigation-sidebar'] && searchBarsAfterCtrlF['navigation-sidebar'].w > 0);
        check('Ctrl+F opens some usable search input (navigator-search-input or search-input)',
              someSearchUiVisible,
              JSON.stringify(searchBarsAfterCtrlF));

        // ── Step 2: Locate the actual search input (prefer modern path) ──
        const searchInputRect = await frame.evaluate(() => {
            // Modern Writer path: Navigator → QuickFind tab → input
            let inp = document.getElementById('navigator-search-input');
            if (inp) {
                const r = inp.getBoundingClientRect();
                if (r.width > 0)
                    return { which: 'navigator-search-input',
                             x: r.x, y: r.y, w: r.width, h: r.height };
            }
            // Legacy mobile path
            inp = document.getElementById('search-input');
            if (inp) {
                const r = inp.getBoundingClientRect();
                if (r.width > 0)
                    return { which: 'search-input',
                             x: r.x, y: r.y, w: r.width, h: r.height };
            }
            return null;
        }).catch(() => null);
        log(`search input rect: ${JSON.stringify(searchInputRect)}`);
        check('Some search input is present and visible',
              !!searchInputRect && searchInputRect.w > 0,
              'rect=' + JSON.stringify(searchInputRect));

        await sleep(800);
        if (searchInputRect && searchInputRect.w > 0) {
            const ix = ifBox.x + searchInputRect.x + searchInputRect.w / 2;
            const iy = ifBox.y + searchInputRect.y + searchInputRect.h / 2;
            await page.mouse.click(ix, iy);
            await sleep(400);
            // Triple-click to select any prior text + erase
            await page.mouse.click(ix, iy, { clickCount: 3 });
            await sleep(200);
            await page.keyboard.press('Backspace');
            await sleep(200);
            await page.keyboard.type(SEARCH_TOKEN, { delay: 80 });
            await sleep(500);
            await snap(page, 'typed_token');
            await page.keyboard.press('Enter');
            log(`Pressed Enter to search for "${SEARCH_TOKEN}"`);
            await sleep(3000);
        }
        await snap(page, 'after_search_enter');

        // ── Step 3: Verify outgoing .uno:ExecuteSearch ──
        const sent = await frame.evaluate(() => window.__sentMsgs || []).catch(() => []);
        log(`Search-related outgoing messages (${sent.length}):`);
        sent.forEach(m => log(`    ${m.substring(0, 200)}`));
        // The browser dispatches the Find input via the QuickFind jsdialog
        // pipeline (dialogevent <wid> {"id":"Find", "cmd":"change|activate", ...}).
        // Either path is acceptable as evidence the JS side did its job.
        const sentFindDialogEvent = sent.some(m => /dialogevent.*\bFind\b/i.test(m));
        const executeSearchSent = sent.some(m => /\.uno:ExecuteSearch/i.test(m));
        check('Search input flushed something to the kit (Find dialogevent OR .uno:ExecuteSearch)',
              sentFindDialogEvent || executeSearchSent,
              'findEvents=' + sent.filter(m => /dialogevent.*Find/.test(m)).length +
              ' executeSearch=' + executeSearchSent);

        // ── Step 4: Verify the doc layer recorded a search result ──
        // Poll: kit may take a moment to bounce search response back.
        let result = null;
        const pollEnd = Date.now() + 6000;
        while (Date.now() < pollEnd) {
            result = await frame.evaluate(() => {
                try {
                    const m = window.app && window.app.map;
                    if (!m || !m._docLayer) return null;
                    // Selection bounds: a successful match highlights the
                    // text and the kit reports a non-zero text selection.
                    const sel = m._docLayer._selections || m._docLayer._textSelectionStart;
                    return {
                        searchTerm: m._docLayer._searchTerm,
                        hasResults: !!m._docLayer._searchResults,
                        lastResult: m._docLayer._lastSearchResult ? 'present' : null,
                        // text selection from a search highlight
                        textSelStart: m._docLayer._textSelectionStart ?
                            JSON.stringify(m._docLayer._textSelectionStart).substring(0, 80) : null,
                    };
                } catch (e) { return 'ERR:' + e.message; }
            }).catch(() => null);
            if (result && (result.hasResults || result.textSelStart || result.lastResult)) break;
            await sleep(300);
        }
        log(`Doc layer search state: ${JSON.stringify(result)}`);

        // CanvasTileLayer.js sets _searchResults only when count > 1; a
        // single-match search ("baseline" appears once in new.docx) lands
        // in _lastSearchResult and the cursor jumps to it. Accept any of
        // those three as a valid hit signal.
        check('_docLayer recorded a search hit for the token (selection / _searchResults / _lastSearchResult)',
              result && (
                  (result.hasResults && result.searchTerm &&
                   String(result.searchTerm).toLowerCase().includes(SEARCH_TOKEN.toLowerCase()))
                  || !!result.textSelStart
                  || (result.lastResult === 'present' &&
                      result.searchTerm &&
                      String(result.searchTerm).toLowerCase().includes(SEARCH_TOKEN.toLowerCase()))
              ),
              JSON.stringify(result));

        log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    } catch (e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        await cleanup();
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
