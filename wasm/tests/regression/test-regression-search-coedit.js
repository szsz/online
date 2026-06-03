const __cl = require('./lib/inject-checklist');
// Regression: Bug 3 — search functionality in 2-browser co-edit context.
//
// Companion to test-regression-search.js (single-browser). Verifies BOTH
// (a) co-edit propagation of typed text from A to B and
// (b) that B can then search for the new token via Ctrl+F and find it.
//
// Steps:
//   1. Both A and B open the same docx via the viewer.
//   2. A types "FINDABLE_TOKEN_xy" at end of doc.
//   3. Wait 5 s for relay to forward the text to B.
//   4. B opens Find via Ctrl+F.
//   5. B types "FINDABLE_TOKEN_xy" into the find input + Enter.
//   6. Assert on B's DOM that a match was found:
//      - non-empty _docLayer text-selection bounds, OR
//      - a search-result indicator in the navigator panel.
//   7. All input via real keyboard / mouse — DOM-only assertions.

const { launch, sleep } = require('./lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-search-coedit';
const DOC_NAME = 'search-coedit-' + Date.now() + '.docx';
const DOC_PATH = path.join(__dirname, '..', 'test', 'data', 'new.docx');
const SEARCH_TOKEN = 'FINDABLE_TOKEN_xy';

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
        f.url().includes('cool.html') && f.url().includes(fileId));
}
async function getStatus(frame) {
    if (!frame) return '';
    try {
        return await frame.evaluate(() =>
            document.querySelector('#StateWordCount')?.textContent?.trim() || '');
    } catch (e) { return ''; }
}
function charCount(s) {
    const m = s && s.match(/([\d,]+)\s+characters/);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : -1;
}

async function openInViewer(browser, label, fileId, b64urlSecret) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    page.on('pageerror', e => log(`[${label} pageerror] ${e.message}`));
    await page.goto(VIEWER + '/?planc=1#file=' + b64urlSecret,
        { waitUntil: 'domcontentloaded', timeout: 90000 });
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
        const fr = await getEditorFrame(page, fileId);
        if (fr) {
            const st = await getStatus(fr);
            if (/\d+\s+character/i.test(st)) {
                log(`[${label}] Loaded: "${st}"`);
                return page;
            }
        }
        await sleep(500);
    }
    throw new Error(`[${label}] never loaded`);
}

async function clickCanvas(page) {
    const frameEl = await page.$('iframe#editor-frame');
    if (frameEl) {
        const box = await frameEl.boundingBox();
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    await sleep(400);
}

(async () => {
    log('=== Regression Bug 3 (co-edit): search after relay propagation ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(DOC_PATH)) {
        log('ERROR: fixture missing: ' + DOC_PATH);
        process.exit(1);
    }

    const { browser, cleanup } = await launch({ width: 1920, height: 1080 });

    try {
        const bytes = fs.readFileSync(DOC_PATH);
        const up = await uploadV2(VIEWER, DOC_NAME, bytes);
        log(`Uploaded ${DOC_NAME} (${(bytes.length / 1024).toFixed(1)} KB)`);

        const pageA = await openInViewer(browser, 'A', up.fileId, up.b64urlSecret);
        await sleep(8000);
        const pageB = await openInViewer(browser, 'B', up.fileId, up.b64urlSecret);
        await sleep(15000);

        const frA = await getEditorFrame(pageA, up.fileId);
        const frB = await getEditorFrame(pageB, up.fileId);
        check('A and B both have editor frames', !!frA && !!frB);

        await snap(pageA, 'A_setup');
        await snap(pageB, 'B_initial');

        const initA = charCount(await getStatus(frA));
        const initB = charCount(await getStatus(frB));
        log(`Initial: A=${initA} B=${initB}`);

        // ── A types FINDABLE_TOKEN_xy at end of doc ──
        await clickCanvas(pageA);
        await pageA.keyboard.down('Control');
        await pageA.keyboard.press('End');
        await pageA.keyboard.up('Control');
        await sleep(500);
        await pageA.keyboard.press('Enter');
        await sleep(400);
        await pageA.keyboard.type(SEARCH_TOKEN, { delay: 50 });
        await sleep(2000);
        await snap(pageA, 'A_after_change');

        // ── Wait for B to receive the typed text via the relay ──
        log('Waiting up to 30s for B to receive typed token...');
        const waitDeadline = Date.now() + 30000;
        const expectedDelta = SEARCH_TOKEN.length + 1; // +1 for the Enter
        let bGrew = false;
        while (Date.now() < waitDeadline) {
            const cb = charCount(await getStatus(frB));
            if (cb >= initB + SEARCH_TOKEN.length) { bGrew = true; break; }
            await sleep(500);
        }
        const finalB = charCount(await getStatus(frB));
        log(`After A typed: B chars=${finalB} (init was ${initB}, expected +${expectedDelta})`);
        check('B received A\'s typed token via relay (char count grew)',
              bGrew,
              `init=${initB} after=${finalB} expectedDelta=${expectedDelta}`);

        // Settle a bit longer to ensure B has fully reflowed.
        await sleep(2000);

        // ── On B: install outgoing-message tap to confirm a search went out ──
        await frB.evaluate(() => {
            try {
                window.__sentMsgs = [];
                const sock = window.app && window.app.socket;
                if (!sock || !sock.sendMessage) return;
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

        // ── On B: focus the canvas, then Ctrl+F to open Find ──
        await clickCanvas(pageB);
        const ifEl = await pageB.$('iframe#editor-frame');
        const ifBox = await ifEl.boundingBox();
        await pageB.keyboard.down('Control');
        await pageB.keyboard.press('f');
        await pageB.keyboard.up('Control');
        await sleep(1500);
        await snap(pageB, 'B_after_ctrl_f');

        // Locate the search input (modern path: navigator-search-input).
        const searchRect = await frB.evaluate(() => {
            for (const id of ['navigator-search-input', 'search-input']) {
                const inp = document.getElementById(id);
                if (!inp) continue;
                const r = inp.getBoundingClientRect();
                if (r.width > 0)
                    return { id, x: r.x, y: r.y, w: r.width, h: r.height };
            }
            return null;
        }).catch(() => null);
        log(`B search input rect: ${JSON.stringify(searchRect)}`);
        check('B: search input is visible after Ctrl+F',
              searchRect && searchRect.w > 0,
              JSON.stringify(searchRect));

        if (searchRect && searchRect.w > 0) {
            const sx = ifBox.x + searchRect.x + searchRect.w / 2;
            const sy = ifBox.y + searchRect.y + searchRect.h / 2;
            await pageB.mouse.click(sx, sy);
            await sleep(400);
            // Triple-click to clear anything in the input.
            await pageB.mouse.click(sx, sy, { clickCount: 3 });
            await sleep(200);
            await pageB.keyboard.press('Backspace');
            await sleep(200);
            await pageB.keyboard.type(SEARCH_TOKEN, { delay: 60 });
            await sleep(500);
            await snap(pageB, 'B_typed_token');
            await pageB.keyboard.press('Enter');
            log(`B: pressed Enter to search for "${SEARCH_TOKEN}"`);
            await sleep(3000);
        }
        await snap(pageB, 'B_after_search_enter');

        // ── DOM-only assertion: B sees a match ──
        // Acceptable evidence:
        //   (a) non-empty _docLayer text-selection bounds (the highlight)
        //   (b) the search input value still equals our token (it was typed)
        //   (c) navigator-search reports a result count visible in the panel
        let foundEvidence = null;
        const pollEnd = Date.now() + 8000;
        while (Date.now() < pollEnd) {
            foundEvidence = await frB.evaluate((token) => {
                const out = { textSel: null, term: null, hasResults: false,
                              inputValue: null, resultLabel: null };
                try {
                    const m = window.app && window.app.map;
                    if (m && m._docLayer) {
                        out.term = m._docLayer._searchTerm || null;
                        out.hasResults = !!m._docLayer._searchResults;
                        if (m._docLayer._textSelectionStart)
                            out.textSel = JSON.stringify(
                                m._docLayer._textSelectionStart).substring(0, 80);
                    }
                } catch (e) {}
                const inp = document.getElementById('navigator-search-input')
                    || document.getElementById('search-input');
                if (inp) out.inputValue = inp.value || null;
                // Hunt for any element whose text contains the token or
                // a "X of Y" / "X result" indicator.
                const labels = document.querySelectorAll(
                    '#navigation-sidebar *, .navigator *, [class*="search"] *');
                for (const el of labels) {
                    const t = (el.textContent || '').trim();
                    if (!t || t.length > 200) continue;
                    if (t.includes(token) || /\bof\s+\d+|\bresults?\b|\bmatch/i.test(t)) {
                        out.resultLabel = t.substring(0, 120);
                        break;
                    }
                }
                return out;
            }, SEARCH_TOKEN).catch(() => null);
            if (foundEvidence && (foundEvidence.textSel || foundEvidence.hasResults
                || foundEvidence.resultLabel)) break;
            await sleep(400);
        }
        log(`B search evidence: ${JSON.stringify(foundEvidence)}`);

        // Did anything go out from B's socket?
        const sent = await frB.evaluate(() => window.__sentMsgs || []).catch(() => []);
        log(`B outgoing search-related messages (${sent.length}):`);
        sent.forEach(m => log(`    ${m.substring(0, 200)}`));
        const sentExecute = sent.some(m => /\.uno:ExecuteSearch/i.test(m));
        const sentFindEvent = sent.some(m => /dialogevent.*\bFind\b/i.test(m));
        check('B: search request went out (Find dialogevent OR ExecuteSearch)',
              sentExecute || sentFindEvent,
              `findEvents=${sent.filter(m => /dialogevent.*Find/.test(m)).length} executeSearch=${sentExecute}`);

        check('B: a search match is observable in the DOM',
              !!foundEvidence && (
                  !!foundEvidence.textSel
                  || (foundEvidence.hasResults && foundEvidence.term &&
                      String(foundEvidence.term).toLowerCase()
                          .includes(SEARCH_TOKEN.toLowerCase()))
                  || !!foundEvidence.resultLabel
              ),
              JSON.stringify(foundEvidence));

        log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    } catch (e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        await cleanup();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
