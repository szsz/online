// test-cv-regression-calc-impress-edits.js — Calc and Impress edits must
// fire `invalidatetiles:` AND the relay-adapter must forward those tiles to
// remote peers (content-viewer co-edit harness).
//
// The regression this guards: "B sees A's remote edit" — the relay-
// forwarding contract. A's LOCAL invalidatetiles for own typing do NOT
// traverse TheFakeWebSocket.onmessage (Kit pushes them straight into the
// canvas-tile pipeline), so only B's relay-routed tick is asserted —
// same as the legacy test after its iter-20 correction.
//
// Per doctype (Calc xlsx, Impress pptx):
//   - A creates a co-edit session in the content viewer, B joins the link
//   - edit observer (ws.onmessage invalidatetiles counter) installs on both
//   - A clicks into the doc (Impress: double-click into a placeholder) and
//     types 'ABC' via real keyboard
//   - ASSERT B's invalidatetiles tick increases
//
// Migrated from wasm/tests/regression/test-regression-calc-impress-edits.js
// — legacy version retired.
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openCoEditPair, cvEditorFrame } =
    require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DATA_DIR = path.join(__dirname, '..', '..', '..', 'test', 'data');
const SHOT_DIR = '/tmp/content-viewer-report/regression-calc-impress-edits';
const STAMP = Date.now();
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const TICK_BUDGET = parseInt(process.env.TICK_BUDGET || '60000', 10);

const T0 = Date.now();
const log = m => console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`);

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2,'0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch (e) {}
}

let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  PASS: ${label}`);
    else { log(`  FAIL: ${label}${ev?' ['+ev+']':''}`); allPassed = false; }
}

// Re-resolves the ACTIVE editor iframe on every call — a captured frame ref
// can detach across re-opens; re-querying follows the live element.
async function getFrame(page) {
    return cvEditorFrame(page);
}

// Hook ws.onmessage and count `invalidatetiles:` events. Wait until the
// hook is actually installed before returning (the relay-adapter installs
// its own hook asynchronously, and a fire-and-forget wrap can be clobbered
// before we observe anything).
async function installEditObserver(page) {
    const fr = await getFrame(page);
    if (!fr) return false;
    return fr.evaluate(async () => {
        window.__editTick = window.__editTick || 0;
        function isOurs(fn) { return typeof fn === 'function' && fn.__editTickHook === true; }
        function wrap(ws) {
            if (!ws || !ws.onmessage || isOurs(ws.onmessage)) return false;
            const orig = ws.onmessage;
            const hooked = function(ev) {
                try {
                    const s = typeof ev.data === 'string' ? ev.data : '';
                    if (s.indexOf('invalidatetiles:') === 0) window.__editTick++;
                } catch (e) {}
                return orig.apply(this, arguments);
            };
            hooked.__editTickHook = true;
            ws.onmessage = hooked;
            return true;
        }
        let installed = false;
        for (let i = 0; i < 100; i++) {
            if (wrap(globalThis.TheFakeWebSocket)) { installed = true; break; }
            await new Promise(r => setTimeout(r, 100));
        }
        if (installed && !window.__editTickWatchdog) {
            window.__editTickWatchdog = setInterval(() => {
                const ws = globalThis.TheFakeWebSocket;
                if (ws && ws.onmessage && !isOurs(ws.onmessage)) wrap(ws);
            }, 250);
        }
        return installed;
    });
}

async function getEditTick(page) {
    const fr = await getFrame(page);
    if (!fr) return 0;
    return fr.evaluate(() => window.__editTick || 0).catch(() => 0);
}

async function waitForEditTick(page, baseline, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const t = await getEditTick(page);
        if (t > baseline) return t;
        await sleep(200);
    }
    return -1;
}

async function clickCanvas(page) {
    const frameEl = await page.$('iframe');
    if (frameEl) {
        const box = await frameEl.boundingBox();
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    await sleep(300);
}

async function focusForType(page, docType) {
    // Click the canvas area inside the iframe to focus for typing.
    // For Impress, double-click to enter a text placeholder.
    await clickCanvas(page);
    if (docType === 'impress') {
        const frameEl = await page.$('iframe');
        if (frameEl) {
            const box = await frameEl.boundingBox();
            if (box) {
                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { clickCount: 2 });
            }
        }
        await sleep(300);
    }
}

(async () => {
    log('=== CV Regression: Calc & Impress edits propagate via invalidatetiles ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    log('viewer: ' + BASE);

    const { browser } = await launch({ headless: 'new' });

    try {
        for (const [docType, src, ext] of [['calc', 'testdoc.xlsx', 'xlsx'],
                                           ['impress', 'testdoc.pptx', 'pptx']]) {
            const fileName = `regr-cv-${STAMP}.${ext}`;
            log(`\n--- ${docType.toUpperCase()}: ${fileName} ---`);
            const fixture = path.join(DATA_DIR, src);
            if (!fs.existsSync(fixture)) {
                check(`fixture present for ${docType}`, false, fixture);
                continue;
            }
            const bytes = fs.readFileSync(fixture);

            // Two clients — A creates the co-edit session, B joins the link
            // in an isolated browser context (openCoEditPair waits for both
            // to become interactive; it throws on timeout).
            let pair = null;
            try {
                pair = await openCoEditPair(browser, BASE, fileName, bytes, {
                    userA: 'User A', userB: 'User B',
                    viewport: { width: 1280, height: 800 },
                    iframeTimeout: 90000,
                    loadBudgetMs: LOAD_BUDGET,
                });
            } catch (e) {
                check(`A+B loaded ${docType} (co-edit pair)`, false,
                      (e.message || '').substring(0, 160));
                continue;
            }
            check(`A+B loaded ${docType} (co-edit pair)`, true);
            const { A, B, contextB } = pair;

            for (const [b, label] of [[A, 'A'], [B, 'B']]) {
                const installed = await installEditObserver(b.page);
                check(`${label} edit observer installed`, installed === true);
            }
            await snap(A.page, `${docType}_loaded`);

            // Settle so peers see each other.
            await sleep(8000);

            // A clicks to focus then types 3 chars via real keyboard.
            await focusForType(A.page, docType);
            await sleep(docType === 'impress' ? 1500 : 250);
            const aPre = await getEditTick(A.page);
            const bPre = await getEditTick(B.page);
            log(`  pre-type: A.tick=${aPre} B.tick=${bPre}`);

            await clickCanvas(A.page);
            await A.page.keyboard.type('ABC', { delay: 150 });

            // Only assert on B's relay-forwarded invalidatetiles. A's LOCAL
            // invalidatetiles for own typing do NOT traverse
            // TheFakeWebSocket.onmessage — Kit pushes them directly into the
            // canvas-tile pipeline. The actual regression this test guards
            // is "B sees A's remote edit" — the relay-forwarding contract.
            const bAfter = await waitForEditTick(B.page, bPre, TICK_BUDGET);
            log(`  post-type: B.tick=${bAfter} (A.tick local-path skipped)`);
            check(`${docType} B sees A's edit (invalidatetiles forwarded by relay-adapter)`,
                  bAfter > bPre, `bPre=${bPre} bAfter=${bAfter}`);

            await snap(A.page, `${docType}_after_edit_A`);
            await snap(B.page, `${docType}_after_edit_B`);

            try { await A.page.close(); } catch (e) {}
            try { await B.page.close(); } catch (e) {}
            try { await contextB.close(); } catch (e) {}
        }

        log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    } catch (e) {
        log('Error: ' + e.message);
        allPassed = false;
    } finally {
        try { await browser.close(); } catch (e) {}
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
