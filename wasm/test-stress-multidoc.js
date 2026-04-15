// Multi-document stress test: simulates real-world co-editing with many
// browsers switching between many documents, looking for races, corruption,
// and propagation gaps.
//
// Setup: N_BROWSERS independent browser contexts open the viewer. Six
// logical documents are uploaded — 2 each of docx / xlsx / pptx (different
// upload names so they live in different relay rooms).
//
// Each round, each browser:
//   1. Picks a random document (different from the one it's currently on,
//      with some probability of staying)
//   2. Opens it via the viewer file-picker (hot-switch when same type as
//      current, cold reload when crossing types)
//   3. Verifies the document loaded (canvas changed AND status bar
//      populated — same WasmDocReady signal the viewer uses)
//   4. Snapshots char counts on every peer currently on this doc
//   5. Types N marker characters
//   6. Verifies every peer's char count grew by at least N within timeout
//   7. Sleeps a random short time, then loops
//
// Concurrent edits are expected (multiple browsers may be on the same doc).
// We use ">= pre-edit + N" rather than "== pre-edit + N" so simultaneous
// edits don't produce false negatives.
//
// NOT included in run-all-tests.sh — this is a long-running test you opt
// into manually:
//
//   N_BROWSERS=10 N_ROUNDS=8 node wasm/test-stress-multidoc.js
//
// Defaults: 10 browsers, 8 rounds. Expect ~30-60 minutes to complete.
// Tunables (env vars):
//   N_BROWSERS=10            number of parallel browsers
//   N_ROUNDS=8               rounds per browser
//   STAY_PROBABILITY=0.2     chance of staying on current doc (no switch)
//   CHARS_PER_EDIT=3         characters typed per round
//   PEER_WAIT_MS=20000       max wait for a peer to see the edit
//   STARTUP_STAGGER_MS=2500  delay between launching successive browsers
//   ROUND_SLEEP_MIN_MS=1000  min sleep between rounds
//   ROUND_SLEEP_MAX_MS=4000  max sleep between rounds

const __cl = require('./lib/inject-checklist');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');

const VIEWER     = env.FILE_STORAGE_URL;
const SHOT_DIR   = '/tmp/static-deploy/public/shots-stress-multidoc';
const FIXTURES_DIR = path.join(__dirname, '..', 'test', 'data');
const STAMP      = Date.now();

const N_BROWSERS         = parseInt(process.env.N_BROWSERS || '10', 10);
const N_ROUNDS           = parseInt(process.env.N_ROUNDS || '8', 10);
const STAY_PROBABILITY   = parseFloat(process.env.STAY_PROBABILITY || '0.2');
const CHARS_PER_EDIT     = parseInt(process.env.CHARS_PER_EDIT || '3', 10);
const PEER_WAIT_MS       = parseInt(process.env.PEER_WAIT_MS || '20000', 10);
const STARTUP_STAGGER_MS = parseInt(process.env.STARTUP_STAGGER_MS || '2500', 10);
const ROUND_SLEEP_MIN_MS = parseInt(process.env.ROUND_SLEEP_MIN_MS || '1000', 10);
const ROUND_SLEEP_MAX_MS = parseInt(process.env.ROUND_SLEEP_MAX_MS || '4000', 10);

// Six logical documents — 2 per format. Uploaded under stress-* names so
// each lives in its own relay room independent of other tests.
const FIXTURES = [
    { src: 'new.docx',        name: `stress-${STAMP}-1.docx`, type: 'writer'  },
    { src: 'template.docx',   name: `stress-${STAMP}-2.docx`, type: 'writer'  },
    { src: 'testdoc.xlsx',    name: `stress-${STAMP}-3.xlsx`, type: 'calc'    },
    { src: 'convert-to.xlsx', name: `stress-${STAMP}-4.xlsx`, type: 'calc'    },
    { src: 'testdoc.pptx',    name: `stress-${STAMP}-5.pptx`, type: 'impress' },
    { src: 'testdoc.pptx',    name: `stress-${STAMP}-6.pptx`, type: 'impress' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0    = Date.now();
const fmtT  = () => `${((Date.now()-T0)/1000).toFixed(1)}s`;
function log(m)            { console.log(`[${fmtT()}] ${m}`); }
function logB(b, m)        { console.log(`[${fmtT()}] [b${b.id}] ${m}`); }
function rnd(min, max)     { return min + Math.floor(Math.random() * (max - min + 1)); }
function pick(arr)         { return arr[Math.floor(Math.random() * arr.length)]; }

let allPassed = true;
const stats = {
    rounds: 0, opens: 0, edits: 0,
    docLoadFailures: 0, ownEditFailures: 0, peerPropagationFailures: 0,
    pageErrors: 0,
};
function recordPass(label, ev) { __cl.recordCheck(label, true, ev); }
function recordFail(label, ev) { __cl.recordCheck(label, false, ev); allPassed = false; }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(4,'0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch(e) {}
}

// Per-document tracking: which browsers are currently on this doc.
const docState = {};
for (const f of FIXTURES) docState[f.name] = { peers: new Set() };

// ── Browser helpers ────────────────────────────────────────────────────
async function getEditorFrame(page) {
    return page.frames().find(f => f.url().includes('cool.html'));
}

async function getCharCount(page) {
    const fr = await getEditorFrame(page);
    if (!fr) return -1;
    try {
        const s = await fr.evaluate(() =>
            document.querySelector('#StateWordCount')?.textContent || '');
        const m = s.match(/([\d,]+)\s+character/);
        return m ? parseInt(m[1].replace(/,/g, ''), 10) : -1;
    } catch (e) { return -1; }
}

async function getStatusDocPos(page) {
    const fr = await getEditorFrame(page);
    if (!fr) return '';
    try {
        return await fr.evaluate(() =>
            document.querySelector('#StatusDocPos')?.textContent || '');
    } catch (e) { return ''; }
}

// Install a doc-event observer in the iframe that counts every
// `invalidatetiles:` message — fired on EACH edit (the .uno:ModifiedStatus
// signal only fires false→true once per session, so it's useless for the
// 2nd, 3rd, ... edit). The relay-adapter forwards `invalidatetiles:`
// from remote peers (relay-adapter.js line ~290), so a peer's tick
// growing proves the edit propagated.
async function installEditObserver(page) {
    const fr = await getEditorFrame(page);
    if (!fr) return;
    // Retry — the relay-adapter installs its own ws.onmessage hook
    // asynchronously after WASM init, so our hook can race in or be
    // clobbered. We poll for TheFakeWebSocket.onmessage to exist before
    // wrapping it; if it gets replaced later we re-wrap.
    try {
        await fr.evaluate(() => {
            if (window.__editObserverInstalled) return;
            window.__editObserverInstalled = true;
            window.__editTick = 0;

            function wrap(ws) {
                if (!ws || ws.__editTickWrapped) return false;
                var orig = ws.onmessage;
                if (!orig) return false;
                ws.__editTickWrapped = true;
                ws.onmessage = function(ev) {
                    try {
                        var s = typeof ev.data === 'string' ? ev.data : '';
                        if (s.indexOf('invalidatetiles:') === 0 ||
                            s.indexOf('tile ') === 0) {
                            window.__editTick++;
                        }
                    } catch (e) {}
                    return orig.apply(this, arguments);
                };
                return true;
            }

            // Try immediately, then every 200ms for up to 10s.
            var attempts = 0;
            var iv = setInterval(function() {
                attempts++;
                var ws = globalThis.TheFakeWebSocket;
                // Re-wrap if onmessage was reassigned by another installer
                // (relay-adapter does this asynchronously).
                if (ws && (!ws.__editTickWrapped ||
                           ws.onmessage.toString().indexOf('__editTick') < 0)) {
                    ws.__editTickWrapped = false;
                    if (wrap(ws)) { clearInterval(iv); return; }
                }
                if (attempts > 50) clearInterval(iv); // 10s max
            }, 200);
            wrap(globalThis.TheFakeWebSocket);
        });
    } catch (e) {}
}

async function getEditTick(page) {
    const fr = await getEditorFrame(page);
    if (!fr) return 0;
    try {
        return await fr.evaluate(() => window.__editTick || 0);
    } catch (e) { return 0; }
}

async function waitForEditTickAtLeast(page, baseline, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const t = await getEditTick(page);
        if (t > baseline) return t;
        await sleep(250);
    }
    return -1;
}

// Install (idempotent) listeners on the parent that capture both the
// hot-switch signal (WasmDocReady) and the cold-reload signal
// (App_LoadingStatus=Initialized) into window globals. We can then poll
// those globals to wait for the next document open.
async function installDocReadyListeners(page) {
    await page.evaluate(() => {
        if (window.__docReadyInstalled) return;
        window.__docReadyInstalled = true;
        window.__lastDocReady = null;        // {filename, ms} — set on WasmDocReady
        window.__lastInitTick  = 0;          // tick incremented on App_LoadingStatus=Initialized
        window.addEventListener('message', function(e) {
            if (typeof e.data !== 'string') return;
            try {
                const m = JSON.parse(e.data);
                if (m.MessageId === 'WasmDocReady' && m.Values) {
                    window.__lastDocReady = m.Values;
                } else if (m.MessageId === 'App_LoadingStatus' &&
                           m.Values && m.Values.Status === 'Initialized') {
                    window.__lastInitTick++;
                }
            } catch (e) {}
        });
    });
}

// Wait for the doc opened by the most recent click to be ready.
//
// Three readiness signals — any of them is sufficient:
//   (a) WasmDocReady with matching filename — fired by wasm-loader after
//       canvas pixels change AND status bar populates (the standard
//       hot-switch path)
//   (b) App_LoadingStatus=Initialized newer than the pre-click baseline —
//       fired by COOL JS in a freshly-loaded iframe (the cold-reload path)
//   (c) The iframe's URL/hash now references the requested filename AND a
//       short post-click delay has passed AND canvas pixels have changed
//       from the pre-click snapshot — fallback for cases where the file
//       loads quickly but neither (a) nor (b) fires (e.g. two very similar
//       xlsx files where wasm-loader's `changed` check stays false)
//
// In all cases we additionally wait for TheFakeWebSocket.send and
// Module.calledRun so subsequent typing won't hit "malloc before runtime
// init".
async function waitForDocReady(page, fileName, baselineInitTick, preCanvas, timeoutMs) {
    await page.evaluate(() => { window.__lastDocReady = null; });
    const encName = encodeURIComponent(fileName);
    const t0 = Date.now();
    let urlMatchedAt = 0;
    while (Date.now() - t0 < timeoutMs) {
        const state = await page.evaluate(() => ({
            ready: window.__lastDocReady,
            initTick: window.__lastInitTick,
        }));
        const hotReady  = state.ready && state.ready.filename === fileName;
        const coldReady = state.initTick > baselineInitTick;

        const fr = await getEditorFrame(page);

        // Signal (c): iframe URL references this filename AND canvas pixels
        // changed AND status bar (wc/dp) is populated AND a short settle
        // window has elapsed. Without the wc/dp populated check, this can
        // fire before COOL has wired up the status widgets — leading to
        // getCharCount() returning -1 even though the doc looks loaded.
        let urlAndCanvasReady = false;
        if (fr) {
            const url = fr.url();
            const urlHasFile = url.includes(encName);
            if (urlHasFile && !urlMatchedAt) urlMatchedAt = Date.now();
            const settled = urlMatchedAt && (Date.now() - urlMatchedAt > 1500);
            if (settled && preCanvas && preCanvas.length > 100) {
                const probe = await fr.evaluate(() => {
                    const c = document.querySelector('canvas');
                    const wc = document.querySelector('#StateWordCount');
                    const dp = document.querySelector('#StatusDocPos');
                    return {
                        cur: c ? c.toDataURL('image/png').substring(200, 1500) : '',
                        wcText: wc ? wc.textContent : '',
                        dpText: dp ? dp.textContent : '',
                    };
                }).catch(() => ({ cur: '', wcText: '', dpText: '' }));
                const canvasChanged = probe.cur && probe.cur.length > 100 &&
                                      probe.cur !== preCanvas;
                // For Writer require "character" specifically so getCharCount
                // can parse a number (it returns -1 on "X words" without the
                // "Y characters" half). For Calc/Impress the dp field
                // ("Sheet N of M" / "Slide N of M") is the readiness marker.
                const statusReady = /character/i.test(probe.wcText) ||
                                    /Sheet|Slide/i.test(probe.dpText);
                if (canvasChanged && statusReady) urlAndCanvasReady = true;
            }
        }

        if ((hotReady || coldReady || urlAndCanvasReady) && fr) {
            // Wait for WASM runtime + FakeWebSocket to be safe to message.
            for (let i = 0; i < 80; i++) {
                const ok = await fr.evaluate(() => {
                    const ws = globalThis.TheFakeWebSocket;
                    const m  = globalThis.Module;
                    return !!ws && typeof ws.send === 'function'
                        && !!m && !!m.calledRun;
                }).catch(() => false);
                if (ok) return Date.now() - t0;
                await sleep(250);
            }
            return -2; // signal arrived but WASM never finished init
        }
        await sleep(250);
    }
    return -1;
}

async function getInitTick(page) {
    return await page.evaluate(() => window.__lastInitTick || 0).catch(() => 0);
}

async function openViewer(browser, b) {
    b.ctx = await browser.createBrowserContext();
    b.page = await b.ctx.newPage();
    await b.page.setViewport({ width: 1280, height: 800 });
    b.page.on('pageerror', e => {
        // Filter ResizeObserver loop noise — harmless and floods the log.
        if (/ResizeObserver/i.test(e.message)) return;
        stats.pageErrors++;
        logB(b, `PAGEERROR: ${e.message.substring(0, 200)}`);
    });
    await b.page.goto(VIEWER + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await installDocReadyListeners(b.page);

    // Wait for prewarm (the iframe's ready flag).
    for (let i = 0; i < 480; i++) {
        await sleep(500);
        try {
            const fr = await getEditorFrame(b.page);
            if (fr && await fr.evaluate(() => !!window.__wasmPrewarmReady)) {
                logB(b, `prewarm ready (${(i*0.5).toFixed(1)}s)`);
                return;
            }
        } catch (e) {}
    }
    throw new Error(`b${b.id} prewarm timed out`);
}

async function openDoc(b, fixture) {
    // Wait for the file element to appear in the viewer's list.
    await b.page.waitForFunction(n =>
        !!document.querySelector(`.file[data-name="${n}"]`),
        { timeout: 30000 }, fixture.name);
    // Snapshot the iframe canvas BEFORE clicking so we can detect when
    // the new doc has rendered (more reliable than wasm-loader internals
    // for hot-switches between similar-looking docs).
    let preCanvas = '';
    try {
        const fr = await getEditorFrame(b.page);
        if (fr) preCanvas = await fr.evaluate(() => {
            const c = document.querySelector('canvas');
            if (!c) return '';
            const url = c.toDataURL('image/png');
            return url.substring(200, 1500);
        }).catch(() => '');
    } catch (e) {}
    b._preOpenCanvas = preCanvas;
    await b.page.evaluate(n => {
        document.querySelector(`.file[data-name="${n}"]`).click();
    }, fixture.name);
    // Give the viewer's openFile() time to fetch + post the RelaySwitchRoom
    // and update iframe.src — the hot-switch path resets
    // __wasmPrewarmReady to false inside the iframe's hashchange handler.
    // If we polled immediately we could see the still-true value from the
    // previous doc and mistake it for the new doc being ready.
    await sleep(500);
}

async function focusCanvas(page, docType) {
    // Send LO Core mouse events so we land in text-edit mode for the
    // active doc type. Coords are in twips (1/20 of a point).
    //
    // - Writer: single click places the caret in the body. Centre is fine.
    // - Calc: single click selects a cell; first keystroke enters cell edit.
    //   Click near top-left so we land on a real cell of the visible region
    //   regardless of which sheet/zoom we got.
    // - Impress: a SINGLE click on a placeholder selects it; a double click
    //   enters text-edit mode. We use the title region (upper area of a
    //   default slide) where most templates put a placeholder.
    const fr = await getEditorFrame(page);
    if (!fr) return;
    let x = 10000, y = 7000, count = 1;
    if (docType === 'calc') {
        x = 1500; y = 1500;            // first/second cell, top-left
    } else if (docType === 'impress') {
        x = 8000; y = 3500; count = 2; // title placeholder, double-click
    }
    try {
        await fr.evaluate((cx, cy, cnt) => {
            if (!globalThis.TheFakeWebSocket || !globalThis.TheFakeWebSocket.send) return;
            globalThis.TheFakeWebSocket.send(
                `mouse type=buttondown x=${cx} y=${cy} count=${cnt} buttons=1 modifier=0`);
            globalThis.TheFakeWebSocket.send(
                `mouse type=buttonup x=${cx} y=${cy} count=${cnt} buttons=1 modifier=0`);
        }, x, y, count);
    } catch (e) {}
}

async function typeChars(page, text) {
    const fr = await getEditorFrame(page);
    if (!fr) throw new Error('no editor frame');
    for (const ch of text) {
        // Brief retry — FakeWebSocket can be momentarily absent right after
        // a hot-switch / cold-reload until relay-adapter rewires it.
        let lastErr;
        for (let attempt = 0; attempt < 10; attempt++) {
            try {
                await fr.evaluate(c => {
                    if (!globalThis.TheFakeWebSocket || !globalThis.TheFakeWebSocket.send)
                        throw new Error('TheFakeWebSocket not ready');
                    globalThis.TheFakeWebSocket.send('textinput id=0 text=' + c);
                }, ch);
                lastErr = null;
                break;
            } catch (e) { lastErr = e; await sleep(150); }
        }
        if (lastErr) throw lastErr;
        await sleep(120);
    }
}

// Wait until page's char count >= baseline + delta, returns final count
// or -1 on timeout.
async function waitForCharCountAtLeast(page, baseline, delta, timeoutMs) {
    const target = baseline + delta;
    const t0 = Date.now();
    let last = baseline;
    while (Date.now() - t0 < timeoutMs) {
        const c = await getCharCount(page);
        if (c >= target) return c;
        last = c;
        await sleep(300);
    }
    return last;
}

// ── Main loop ──────────────────────────────────────────────────────────
function pickNextDoc(b) {
    // With STAY_PROBABILITY chance, stay (return same doc — caller will
    // skip the open step). Otherwise pick a random different doc.
    if (b.currentDoc && Math.random() < STAY_PROBABILITY) {
        return FIXTURES.find(f => f.name === b.currentDoc);
    }
    let pick;
    do { pick = FIXTURES[Math.floor(Math.random() * FIXTURES.length)]; }
    while (FIXTURES.length > 1 && pick.name === b.currentDoc);
    return pick;
}

async function browserRound(b, r) {
    stats.rounds++;
    const fixture = pickNextDoc(b);
    const stayed = (b.currentDoc === fixture.name);

    // OPEN (if needed)
    if (!stayed) {
        if (b.currentDoc) docState[b.currentDoc].peers.delete(b.id);
        const sameType = fixture.type === b._lastType;
        const baselineInitTick = await getInitTick(b.page);
        try {
            await openDoc(b, fixture);
            stats.opens++;
        } catch (e) {
            recordFail(`b${b.id} r${r} open ${fixture.name}`, e.message.substring(0, 80));
            stats.docLoadFailures++;
            return;
        }
        const took = await waitForDocReady(b.page, fixture.name,
            baselineInitTick, b._preOpenCanvas, sameType ? 30000 : 90000);
        b._lastType = fixture.type;
        if (took < 0) {
            const reason = took === -2 ? 'no-FakeWebSocket' : 'timeout';
            recordFail(`b${b.id} r${r} doc-ready ${fixture.name}`, reason);
            stats.docLoadFailures++;
            await snap(b.page, `b${b.id}_r${r}_open_${reason}_${fixture.name}`);
            return;
        }
        b.currentDoc = fixture.name;
        docState[fixture.name].peers.add(b.id);
        // Install the edit observer in the (possibly new) iframe so we
        // can detect propagation via `invalidatetiles:` (per-edit signal)
        // for non-Writer docs where char count doesn't change on every
        // edit.
        await installEditObserver(b.page);
        recordPass(`b${b.id} r${r} opened ${fixture.name}`, took + 'ms');
        logB(b, `opened ${fixture.name} in ${took}ms (switched, ${sameType ? 'hot' : 'cold'})`);
    } else {
        logB(b, `staying on ${fixture.name}`);
    }

    // Click into the canvas so typing has somewhere to land.
    await focusCanvas(b.page, fixture.type);
    await sleep(fixture.type === 'impress' ? 1500 : 250);

    // For Writer docs: char-count delta is the precise propagation signal.
    // For Calc / Impress: textinput often doesn't update #StateWordCount
    // (e.g. typing into a non-edit-mode cell), so we use the
    // `invalidatetiles:` event count (per-edit signal forwarded by the
    // relay-adapter) as a coarser propagation signal.
    const useCharCount = (fixture.type === 'writer');
    const peers = [...docState[fixture.name].peers].filter(id => id !== b.id);

    let myPreCount = -1, peerPreCount = {};
    let myPreTick  = 0,  peerPreTick = {};
    if (useCharCount) {
        myPreCount = await getCharCount(b.page);
        for (const pid of peers) peerPreCount[pid] = await getCharCount(BROWSERS[pid].page);
    } else {
        myPreTick = await getEditTick(b.page);
        for (const pid of peers) peerPreTick[pid] = await getEditTick(BROWSERS[pid].page);
    }

    // Type the marker. Use single digit per browser so the chars aren't
    // confused with surrounding text.
    const marker = String(b.id % 10).repeat(CHARS_PER_EDIT);
    try {
        await typeChars(b.page, marker);
    } catch (e) {
        recordFail(`b${b.id} r${r} typing ${fixture.name}`, e.message.substring(0, 80));
        stats.ownEditFailures++;
        await sleep(rnd(ROUND_SLEEP_MIN_MS, ROUND_SLEEP_MAX_MS));
        return;
    }
    stats.edits++;

    // Verify own.
    if (useCharCount) {
        const myAfter = await waitForCharCountAtLeast(b.page, myPreCount, CHARS_PER_EDIT, PEER_WAIT_MS);
        if (myAfter < myPreCount + CHARS_PER_EDIT) {
            recordFail(`b${b.id} r${r} own edit ${fixture.name}`,
                `pre=${myPreCount} after=${myAfter}`);
            stats.ownEditFailures++;
        } else {
            recordPass(`b${b.id} r${r} own edit visible`, `+${myAfter - myPreCount}`);
        }
    } else {
        const myAfterTick = await waitForEditTickAtLeast(b.page, myPreTick, PEER_WAIT_MS);
        if (myAfterTick < 0) {
            recordFail(`b${b.id} r${r} own edit ${fixture.name}`,
                `no invalidatetiles event after typing`);
            stats.ownEditFailures++;
        } else {
            recordPass(`b${b.id} r${r} own edit observed`,
                `tick ${myPreTick}→${myAfterTick}`);
        }
    }

    // Verify peers — but only those who are STILL on the doc when we
    // verify. Peers who switched docs mid-round legitimately won't see
    // the edit, and counting that as a failure produces noise rather
    // than real bugs.
    for (const pid of peers) {
        if (!docState[fixture.name].peers.has(pid)) {
            logB(b, `peer b${pid} left ${fixture.name} during verification — skipping`);
            continue;
        }
        if (useCharCount) {
            const peerAfter = await waitForCharCountAtLeast(
                BROWSERS[pid].page, peerPreCount[pid], CHARS_PER_EDIT, PEER_WAIT_MS);
            if (peerAfter < peerPreCount[pid] + CHARS_PER_EDIT) {
                // Re-check whether peer is still here (may have left during the wait)
                if (!docState[fixture.name].peers.has(pid)) {
                    logB(b, `peer b${pid} left ${fixture.name} during peer-wait — skipping`);
                    continue;
                }
                recordFail(`b${b.id} r${r} peer-prop ${fixture.name} → b${pid}`,
                    `pre=${peerPreCount[pid]} after=${peerAfter}`);
                stats.peerPropagationFailures++;
                await snap(BROWSERS[pid].page, `propfail_b${pid}_from_b${b.id}_r${r}_${fixture.name}`);
            } else {
                recordPass(`b${b.id} r${r} peer b${pid} got edit`,
                    `+${peerAfter - peerPreCount[pid]}`);
            }
        } else {
            const peerAfterTick = await waitForEditTickAtLeast(
                BROWSERS[pid].page, peerPreTick[pid], PEER_WAIT_MS);
            if (peerAfterTick < 0) {
                if (!docState[fixture.name].peers.has(pid)) {
                    logB(b, `peer b${pid} left ${fixture.name} during peer-wait — skipping`);
                    continue;
                }
                recordFail(`b${b.id} r${r} peer-prop ${fixture.name} → b${pid}`,
                    `no invalidatetiles on peer`);
                stats.peerPropagationFailures++;
                await snap(BROWSERS[pid].page, `propfail_b${pid}_from_b${b.id}_r${r}_${fixture.name}`);
            } else {
                recordPass(`b${b.id} r${r} peer b${pid} got edit`,
                    `tick ${peerPreTick[pid]}→${peerAfterTick}`);
            }
        }
    }

    await sleep(rnd(ROUND_SLEEP_MIN_MS, ROUND_SLEEP_MAX_MS));
}

const BROWSERS = [];
async function browserLoop(b, browser) {
    try {
        await openViewer(browser, b);
    } catch (e) {
        recordFail(`b${b.id} prewarm`, e.message.substring(0, 80));
        return;
    }
    for (let r = 0; r < N_ROUNDS; r++) {
        try {
            await browserRound(b, r);
        } catch (e) {
            recordFail(`b${b.id} r${r} round threw`, e.message.substring(0, 100));
            logB(b, `round ${r} threw: ${e.message.substring(0, 100)}`);
        }
    }
    if (b.currentDoc) docState[b.currentDoc].peers.delete(b.id);
    try { await b.ctx.close(); } catch (e) {}
}

(async () => {
    log('=== multi-doc stress test ===');
    log(`browsers=${N_BROWSERS} rounds=${N_ROUNDS} chars/edit=${CHARS_PER_EDIT}`);
    log(`fixtures: ${FIXTURES.map(f => f.name + '(' + f.type + ')').join(', ')}`);
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    // Verify fixtures exist.
    for (const f of FIXTURES) {
        const p = path.join(FIXTURES_DIR, f.src);
        if (!fs.existsSync(p)) {
            log('ERROR: missing fixture ' + p);
            process.exit(1);
        }
    }

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox',
               '--ignore-certificate-errors', '--enable-features=SharedArrayBuffer'],
    });

    // Upload all 6 documents to the viewer using a single setup page.
    const up = await browser.newPage();
    await up.goto(VIEWER + '/');
    for (const f of FIXTURES) {
        const bytes = fs.readFileSync(path.join(FIXTURES_DIR, f.src));
        await up.evaluate(async (n, arr) => {
            await fetch('/api/files/' + encodeURIComponent(n), {
                method: 'POST', body: new Blob([new Uint8Array(arr)]),
            });
        }, f.name, Array.from(bytes));
        log(`uploaded ${f.name} (${(bytes.length/1024).toFixed(0)}KB ${f.type})`);
    }
    await up.close();

    // Create browser objects.
    for (let i = 0; i < N_BROWSERS; i++) {
        BROWSERS.push({ id: i, page: null, ctx: null, currentDoc: null, _lastType: null });
    }

    // Launch with a stagger to spread prewarm load.
    const promises = [];
    for (let i = 0; i < N_BROWSERS; i++) {
        promises.push((async (idx) => {
            await sleep(idx * STARTUP_STAGGER_MS);
            await browserLoop(BROWSERS[idx], browser);
        })(i));
    }
    await Promise.all(promises);

    log('');
    log('=== Stress run summary ===');
    log(`rounds:                  ${stats.rounds}`);
    log(`document opens:          ${stats.opens}`);
    log(`edits:                   ${stats.edits}`);
    log(`doc-load failures:       ${stats.docLoadFailures}`);
    log(`own-edit failures:       ${stats.ownEditFailures}`);
    log(`peer-propagation fails:  ${stats.peerPropagationFailures}`);
    log(`page errors (non-RO):    ${stats.pageErrors}`);
    log(allPassed ? '✓ NO FAILURES' : '✗ FAILURES OCCURRED — see screenshots in ' + SHOT_DIR);

    await browser.close();
    process.exit(allPassed ? 0 : 1);
})();
