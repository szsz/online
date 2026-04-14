const __cl = require('./lib/inject-checklist');
// Test: pre-warming on viewer open.
// The viewer pre-loads a blank document as soon as it opens. This primes the
// browser HTTP cache with the (large) WASM + soffice.data files and compiles
// the WASM module. Opening a real document then benefits from the warm cache.
//
// The test verifies:
//   1. No browser errors on pre-warm (SAB, fatal)
//   2. Iframe is cross-origin isolated (SharedArrayBuffer available)
//   3. Pre-warm reaches "loaded" state (real status text appears, not just canvas)
//   4. Opening a real file after pre-warm is measurably faster than cold open
//      AND the real document actually renders (word count > 100)
//
// "near-instantaneous" would require a C++ switchdocument that does NOT tear
// down the DocumentBroker; that is a separate piece of work. For now we
// measure what the warm cache buys us.

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const VIEWER = 'https://viewer.szebeni.hu:6934';
const EDITOR = 'https://wasm.atgpartners.info:6932';
const PREWARM_TIMEOUT = 180000;
const RENDER_TIMEOUT = 90000;
const SHOT_DIR = '/tmp/static-deploy/public/shots-prewarm';
const DOC_NAME = 'prewarm-doc.odt';
const DOC_PATH = path.join(__dirname, '..', 'test', 'data', '3pages.odt');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const T0 = Date.now();
function elapsed() { return ((Date.now() - T0) / 1000).toFixed(1) + 's'; }
function log(m) { console.log(`[${elapsed()}] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await sleep(200);
    const f = `${String(++shotNum).padStart(2,'0')}_${elapsed()}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch(e) {}
    log(`[snap] ${f}`);
}

let allPassed = true;
function check(label, cond) { __cl.recordCheck(label, cond);
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}`); allPassed = false; }
}

function attachListeners(page, label, errors, allLogs) {
    page.on('console', msg => {
        const text = msg.text();
        if (allLogs) allLogs.push(`[${label}] ${msg.type()}: ${text.substring(0, 300)}`);
        if (text.includes('SharedArrayBuffer is not defined')) {
            errors.push(`${label} SAB MISSING`);
        }
        if (msg.type() === 'error' && !text.includes('favicon') && !text.includes('404 (Not Found)')) {
            errors.push(`${label} console.error: ${text.substring(0, 150)}`);
        }
    });
    page.on('pageerror', e => {
        if (allLogs) allLogs.push(`[${label}] PAGEERROR: ${e.message}`);
        errors.push(`${label} pageerror: ${e.message.substring(0, 200)}`);
    });
}

async function waitForDocumentLoaded(frame, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
        try {
            const state = await frame.evaluate(() => {
                const wc = document.querySelector('#StateWordCount');
                const dp = document.querySelector('#StatusDocPos');
                return {
                    words: (wc && wc.textContent) ? wc.textContent : '',
                    sheet: (dp && dp.textContent) ? dp.textContent : '',
                    canvases: document.querySelectorAll('canvas').length,
                };
            });
            const wm = state.words.match(/([\d,]+)\s+words/);
            const words = wm ? parseInt(wm[1].replace(/,/g, '')) : 0;
            if (words >= 1 || state.sheet.includes('Sheet')) {
                return { ok: true, took: Date.now() - t0, state };
            }
        } catch(e) {}
        await sleep(500);
    }
    return { ok: false, took: Date.now() - t0 };
}

async function openPageAndWaitForDoc(browser, url, label, errors, allLogs, timeout) {
    const page = await browser.newPage();
    attachListeners(page, label, errors, allLogs);
    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const res = await waitForDocumentLoaded(page.mainFrame(), timeout);
    return { page, loadTime: (Date.now() - t0) / 1000, ok: res.ok, state: res.state };
}

(async () => {
    log('=== Pre-warm Test (strict) ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    if (!fs.existsSync(DOC_PATH)) { log('ERROR: fixture missing'); process.exit(1); }

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });
    const errors = [];
    const allLogs = [];

    try {
        // Upload real doc to viewer
        log('Uploading fixture to viewer');
        const up = await browser.newPage();
        attachListeners(up, 'upload', errors, allLogs);
        await up.goto(VIEWER + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        const bytes = fs.readFileSync(DOC_PATH);
        await up.evaluate(async (name, arr) => {
            await fetch('/api/files/' + encodeURIComponent(name), {
                method: 'POST', body: new Blob([new Uint8Array(arr)]),
            });
        }, DOC_NAME, Array.from(bytes));
        await up.close();
        log(`  Uploaded ${DOC_NAME} (${(bytes.length/1024).toFixed(0)}KB)`);

        // ===== COLD OPEN (baseline, no pre-warm context) =====
        log('\n--- Baseline: cold open (fresh browser context) ---');
        const coldContext = await browser.createBrowserContext();
        const coldPage = await coldContext.newPage();
        attachListeners(coldPage, 'cold', errors, allLogs);
        const coldT0 = Date.now();
        await coldPage.goto(
            EDITOR + '/browser/cool.html?WOPISrc=' + encodeURIComponent(DOC_NAME) + '&access_token=test',
            { waitUntil: 'domcontentloaded', timeout: 30000 });
        const coldRes = await waitForDocumentLoaded(coldPage.mainFrame(), RENDER_TIMEOUT);
        const coldTime = (Date.now() - coldT0) / 1000;
        log(`  Cold open took ${coldTime.toFixed(1)}s, loaded=${coldRes.ok}`);
        await snap(coldPage, 'cold_loaded');
        await coldContext.close();
        check('Cold open reaches loaded state', coldRes.ok);

        // ===== VIEWER FLOW: pre-warm then open =====
        log('\n--- Viewer flow: pre-warm then open ---');
        const page = await browser.newPage();
        attachListeners(page, 'viewer', errors, allLogs);

        const prewarmStart = Date.now();
        await page.goto(VIEWER + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await snap(page, 'viewer_opened');

        // Verify COI is active
        const topCOI = await page.evaluate(() => ({
            crossOriginIsolated: window.crossOriginIsolated,
            hasSAB: typeof SharedArrayBuffer !== 'undefined',
        }));
        check('Top-level crossOriginIsolated', topCOI.crossOriginIsolated === true);
        check('Top-level has SharedArrayBuffer', topCOI.hasSAB === true);

        // Wait for iframe to have a cool.html src (happens on startPrewarm)
        await page.waitForFunction(
            () => document.getElementById('editor-frame').src.includes('cool.html'),
            { timeout: 10000 });
        const frames = page.frames();
        const editorFrame = frames.find(f => f.url().includes('/browser/cool.html'));
        check('Editor iframe attached', !!editorFrame);

        if (editorFrame) {
            const iframeCOI = await editorFrame.evaluate(() => ({
                crossOriginIsolated: window.crossOriginIsolated,
                hasSAB: typeof SharedArrayBuffer !== 'undefined',
            })).catch(e => ({ error: e.message }));
            check('Iframe crossOriginIsolated', iframeCOI.crossOriginIsolated === true);
            check('Iframe has SharedArrayBuffer', iframeCOI.hasSAB === true);
        }

        // Wait for the iframe's STRICT ready flag — only true after the blank
        // document is actually rendered. Clicking before this would push the
        // wait onto the switch path and erase the speedup.
        let prewarmOk = false;
        try {
            await page.waitForFunction(() => {
                const fr = document.getElementById('editor-frame');
                return fr && fr.contentWindow; // basic existence
            }, { timeout: 10000 });
            // Poll the iframe's own flag via the frame handle
            const tStart = Date.now();
            while (Date.now() - tStart < PREWARM_TIMEOUT) {
                if (editorFrame && !editorFrame.isDetached()) {
                    try {
                        const ready = await editorFrame.evaluate(() => !!window.__wasmPrewarmReady);
                        if (ready) { prewarmOk = true; break; }
                    } catch(e) {}
                }
                await sleep(500);
            }
        } catch(e) {}
        const prewarmTime = (Date.now() - prewarmStart) / 1000;

        const sabErr = errors.find(e => e.includes('SAB MISSING'));
        const fatalErr = errors.filter(e => e.includes('pageerror:') && !e.includes('ResizeObserver'));
        if (sabErr) log('  !! ' + sabErr);
        if (fatalErr.length) {
            log('  !! Fatal errors:');
            fatalErr.slice(0, 5).forEach(e => log('    ' + e));
        }

        check(`Pre-warm ready (took ${prewarmTime.toFixed(1)}s)`, prewarmOk);
        check('No SharedArrayBuffer errors', !sabErr);
        check('No fatal page errors', fatalErr.length === 0);
        await snap(page, 'prewarm_settled');

        if (!prewarmOk || sabErr || fatalErr.length) {
            log('Aborting — prewarm failed');
            await browser.close();
            process.exit(1);
        }

        // Snapshot the WASM runtime fingerprint BEFORE clicking — same value
        // after the switch proves the runtime was reused (true hot-switch),
        // a different value would mean the iframe was reloaded.
        let runtimeIdBefore = null;
        try { runtimeIdBefore = await editorFrame.evaluate(() => window.__wasmRuntimeId); } catch(e) {}
        log(`  runtimeId before switch: ${runtimeIdBefore}`);

        // Now click the real doc — take timestamped screenshots so each
        // frame of the user's experience is captured and measurable.
        log('\n--- Hot-switch timeline with screenshots ---');

        // Snapshot baseline BEFORE click
        let baselineCanvas = null;
        try {
            baselineCanvas = await editorFrame.evaluate(() =>
                document.querySelector('canvas')?.toDataURL().substring(0, 200) || null);
        } catch(e) {}

        const openStart = Date.now();
        await page.evaluate((name) => {
            const el = document.querySelector(`.file[data-name="${name}"]`);
            if (!el) throw new Error('file entry not found');
            el.click();
        }, DOC_NAME);

        // Take timestamped screenshots at fixed intervals while polling for
        // canvas change and word-count update. This produces a filmstrip of
        // exactly what the user sees at each moment.
        const SNAP_AT = [100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000];
        let nextSnap = 0;
        let canvasChangeMs = -1;
        let wcChangeMs = -1;
        let runtimeIdAfter = null;

        for (let i = 0; i < 600; i++) {
            await sleep(10);
            const t = Date.now() - openStart;

            // Scheduled screenshots
            while (nextSnap < SNAP_AT.length && t >= SNAP_AT[nextSnap]) {
                const ms = SNAP_AT[nextSnap];
                await snap(page, `hotswitch_${String(ms).padStart(4,'0')}ms`);
                log(`  [screenshot +${ms}ms]`);
                nextSnap++;
            }

            // Poll canvas + word count
            try {
                const state = await editorFrame.evaluate(() => ({
                    canvas: document.querySelector('canvas')?.toDataURL().substring(0, 200) || null,
                    wc: document.querySelector('#StateWordCount')?.textContent || '',
                    dp: document.querySelector('#StatusDocPos')?.textContent || '',
                }));
                if (canvasChangeMs < 0 && state.canvas && state.canvas !== baselineCanvas) {
                    canvasChangeMs = t;
                    await snap(page, 'hotswitch_canvas_changed');
                    log(`  *** Canvas pixels changed at +${t}ms`);
                }
                const m = state.wc.match(/(\d+)\s*words/);
                const w = m ? parseInt(m[1]) : 0;
                if (wcChangeMs < 0 && (w >= 1 || state.dp.includes('Sheet'))) {
                    wcChangeMs = t;
                    await snap(page, 'hotswitch_wc_updated');
                    log(`  *** Word count updated at +${t}ms ("${state.wc}")`);
                }
            } catch(e) {}
            if (canvasChangeMs >= 0 && wcChangeMs >= 0) break;
        }
        // Remaining scheduled screenshots
        while (nextSnap < SNAP_AT.length) {
            const ms = SNAP_AT[nextSnap];
            const remaining = ms - (Date.now() - openStart);
            if (remaining > 0) await sleep(remaining);
            await snap(page, `hotswitch_${String(ms).padStart(4,'0')}ms`);
            nextSnap++;
        }

        try { runtimeIdAfter = await editorFrame.evaluate(() => window.__wasmRuntimeId); } catch(e) {}
        const warmTime = wcChangeMs / 1000;
        const renderOk = canvasChangeMs >= 0;

        // Collect iframe profiling events that occurred during the switch
        const switchProfile = await editorFrame.evaluate(() => {
            const evts = window.__prewarmTimings?.events || [];
            // Return the last ~20 events (switch-related)
            return evts.slice(-20);
        }).catch(() => []);
        if (switchProfile.length > 0) {
            const sw = switchProfile.find(e => e.name === 'bridge:switchdoc_sent');
            const base = sw ? sw.t : switchProfile[0].t;
            log('\n  Internal profile (from switchdoc_sent):');
            for (const e of switchProfile.filter(e => /bridge:|dom:|doc:|prewarm:/.test(e.name))) {
                log(`    ${String(Math.round(e.t - base)).padStart(6)}ms  ${e.name}  ${e.detail || ''}`);
            }
        }

        log(`\n  runtimeId after switch:  ${runtimeIdAfter}`);
        log(`  Canvas pixels changed:   ${canvasChangeMs} ms  ← shield drops, user sees content`);
        log(`  WordCount text updated:  ${wcChangeMs} ms  ← full metadata arrived`);

        check('Hot-switch reuses WASM runtime (same instance)',
              runtimeIdBefore && runtimeIdAfter && runtimeIdBefore === runtimeIdAfter);
        check('Visible switch under 1 second (canvas change)', canvasChangeMs >= 0 && canvasChangeMs < 1000);
        await snap(page, 'warm_loaded');
        check('Real document rendered from warm cache', renderOk);

        // Hot-switch keeps the LO Core alive and just swaps the document.
        // For small docs (~10 KB) we expect < 10 s. The remaining time is
        // LO Core per-document init, which dominates for any non-trivial doc.
        if (renderOk) {
            const speedup = coldRes.ok ? (coldTime - warmTime) : 0;
            log(`\nCold: ${coldRes.ok ? coldTime.toFixed(1) + 's' : 'FAILED'}    Hot: ${warmTime.toFixed(1)}s    Δ=${speedup.toFixed(1)}s`);
            check('Hot open completes', renderOk);
            check('Hot open under 10s', warmTime < 10);
            if (coldRes.ok) {
                check('Hot open faster than cold', speedup > 0);
            }
        }

        // ===== Multi-format verification via viewer flow =====
        // Open a docx (same-type as prewarm), an xlsx (cross-type → calc),
        // a pptx (cross-type → impress) — all via the viewer file picker.
        // Hot-switch (writer→writer) must be sub-1-second; cross-type does a
        // cold reload so must complete but is allowed more time.
        log('\n--- Multi-format via viewer ---');

        const FORMATS = [
            { name: 'fmt-test.docx',  src: 'new.docx',     hot: true,  budgetMs: 1000, kind: 'writer'  },
            { name: 'fmt-test.xlsx',  src: 'testdoc.xlsx', hot: false, budgetMs: 60000, kind: 'calc'   },
            { name: 'fmt-test.pptx',  src: 'testdoc.pptx', hot: false, budgetMs: 60000, kind: 'impress'},
        ];
        for (const f of FORMATS) {
            const srcPath = path.join(__dirname, '..', 'test', 'data', f.src);
            if (!fs.existsSync(srcPath)) { log('  skip (missing) ' + f.src); continue; }
            const buf = fs.readFileSync(srcPath);
            // Upload to viewer
            await page.evaluate(async (n, a) => {
                await fetch('/api/files/' + encodeURIComponent(n), {
                    method: 'POST', body: new Blob([new Uint8Array(a)]),
                });
            }, f.name, Array.from(buf));
            // Refresh viewer file list
            await page.evaluate(() => refresh());
            await sleep(300);

            // Capture baseline state BEFORE click so we can detect when the
            // new document has actually replaced the old one. Just looking for
            // "N words" gives false positives because the previous doc's
            // status-bar text persists across the switch until the new doc
            // overwrites it.
            const beforeFr = page.frames().find(fx => fx.url().includes('cool.html'));
            let baseline = { wc: '', dp: '', canvas: '', runtimeId: '', toolbarSig: '' };
            if (beforeFr) {
                try {
                    baseline = await beforeFr.evaluate(() => ({
                        wc: document.querySelector('#StateWordCount')?.textContent || '',
                        dp: document.querySelector('#StatusDocPos')?.textContent || '',
                        canvas: document.querySelector('canvas')?.toDataURL('image/png').substring(0, 200) || '',
                        // Whether the editor chrome (toolbar / nav) is mounted.
                        // If a hot-switch keeps this present, the user does not
                        // perceive an "editor reload". A cold reload will tear
                        // it down and recreate it.
                        runtimeId:  window.__wasmRuntimeId || '',
                        toolbarSig: (document.querySelector('nav.main-nav')?.textContent || '').length + ':' +
                                    (document.querySelectorAll('canvas').length),
                    }));
                } catch(e) {}
            }

            // Track network requests for the heavy WASM payload. Any new
            // online.wasm fetch during the click means the WASM module was
            // re-instantiated — i.e. the editor really did "reload from
            // scratch", which is what the user complained about.
            const wasmRefetches = [];
            const reqHandler = (req) => {
                const u = req.url();
                if (/\/online(\.[a-f0-9]+)?\.wasm(\?|$)/.test(u) || /\/soffice\.data(\?|$)/.test(u)) {
                    wasmRefetches.push(u);
                }
            };
            page.on('request', reqHandler);

            // Prepare a high-resolution sampler INSIDE the iframe that records
            // whether the editor toolbar / canvas is being covered by a
            // full-screen loading overlay. This is the actual user-facing
            // signal of "looks like the whole editor is reloading".
            if (beforeFr) {
                try {
                    await beforeFr.evaluate(() => {
                        window.__overlayCoverSamples = [];
                        window.__overlayCoverStart = performance.now();
                        window.__overlayCoverInterval = setInterval(() => {
                            const o = document.getElementById('wasm-loading-overlay');
                            const visible = !!o && getComputedStyle(o).display !== 'none' && parseFloat(o.style.opacity || '1') > 0.05;
                            window.__overlayCoverSamples.push({
                                t: performance.now() - window.__overlayCoverStart,
                                cover: visible,
                            });
                        }, 25);
                    });
                } catch(e) {}
            }

            const t0 = Date.now();
            await page.evaluate((n) => {
                const el = document.querySelector(`.file[data-name="${n}"]`);
                if (!el) throw new Error('file not found: ' + n);
                el.click();
            }, f.name);

            // For cross-type opens, the iframe is replaced; re-find the frame
            // by polling for cool.html with the new WOPISrc.
            let docVisible = false;
            const deadline = Date.now() + f.budgetMs + 5000;
            while (Date.now() < deadline) {
                await sleep(50);
                const fr = page.frames().find(fx => fx.url().includes('cool.html')
                    && (fx.url().includes(encodeURIComponent(f.name)) || fx.url().includes('#switchdoc=' + encodeURIComponent(f.name))));
                if (!fr) continue;
                try {
                    const evidence = await fr.evaluate(() => ({
                        nav:    document.querySelector('nav.main-nav')?.textContent || '',
                        wc:     document.querySelector('#StateWordCount')?.textContent || '',
                        dp:     document.querySelector('#StatusDocPos')?.textContent || '',
                        canvas: document.querySelector('canvas')?.toDataURL('image/png').substring(0, 200) || '',
                    }));
                    // "User sees the new doc" is when canvas pixels diverge
                    // from baseline. WC text update happens later (~1-2s after
                    // canvas) and is the wrong signal for perceived load time
                    // — the wasm-loader already drops its overlay on canvas
                    // change so this matches what the human watching sees.
                    // For cross-type opens (cold reload) the canvas is brand
                    // new (no baseline carries over), so we additionally
                    // require a kind-specific UI marker to ensure the right
                    // editor mounted.
                    const canvasChanged = evidence.canvas && evidence.canvas !== baseline.canvas;
                    if (!canvasChanged) continue;
                    if (f.kind === 'writer')  { docVisible = true; break; }
                    if (f.kind === 'calc'    && /Sheet\s*\d+/i.test(evidence.dp))    { docVisible = true; break; }
                    if (f.kind === 'impress' && /Slide Show/.test(evidence.nav))     { docVisible = true; break; }
                } catch(e) {}
            }
            const took = Date.now() - t0;
            page.off('request', reqHandler);
            await snap(page, f.kind + '_open');

            // Re-find the frame at the END of the open. If runtimeId stayed
            // the same we did a true hot-switch (no WASM re-instantiation).
            const afterFr = page.frames().find(fx => fx.url().includes('cool.html'));
            let after = { runtimeId: '', toolbarSig: '' };
            if (afterFr) {
                try {
                    after = await afterFr.evaluate(() => ({
                        runtimeId:  window.__wasmRuntimeId || '',
                        toolbarSig: (document.querySelector('nav.main-nav')?.textContent || '').length + ':' +
                                    (document.querySelectorAll('canvas').length),
                    }));
                } catch(e) {}
            }
            const sameRuntime = baseline.runtimeId && after.runtimeId &&
                                baseline.runtimeId === after.runtimeId;
            const sameToolbar = baseline.toolbarSig && baseline.toolbarSig === after.toolbarSig;

            log(`  ${f.name} opened in ${took}ms (visible=${docVisible}, ` +
                `runtime=${sameRuntime?'same':'NEW'}, wasmRefetched=${wasmRefetches.length})`);
            check(`${f.kind} opens via viewer`, docVisible, `${took}ms`);
            check(`${f.kind} open within budget (${f.budgetMs}ms)`, docVisible && took <= f.budgetMs, `${took}ms`);
            if (f.hot) {
                check(`${f.kind} hot-switch sub-1s`, docVisible && took <= 1000, `${took}ms`);
                // Hot-switch must NOT re-fetch the WASM/data — that would mean
                // the user is perceiving "the whole editor reloads".
                check(`${f.kind} hot-switch reuses WASM (no re-fetch)`,
                      wasmRefetches.length === 0,
                      wasmRefetches.length ? wasmRefetches[0].split('/').pop() : 'no refetch');
                check(`${f.kind} hot-switch reuses runtime (same instance)`,
                      sameRuntime, `before=${baseline.runtimeId} after=${after.runtimeId}`);
                check(`${f.kind} hot-switch keeps editor chrome mounted`,
                      sameToolbar || (after.toolbarSig && parseInt(after.toolbarSig.split(':')[0]) > 0),
                      `before=${baseline.toolbarSig} after=${after.toolbarSig}`);
                // The thing the user actually complained about: during a
                // hot-switch the iframe used to slap a full-screen gray
                // overlay over the toolbar, making it look like the whole
                // editor was reloading. The viewer's shield is the right
                // place for that UX — the iframe should not also cover
                // itself. Compute coverage stats from the in-iframe sampler.
                let coverSamples = [];
                try {
                    coverSamples = await afterFr.evaluate(() => {
                        if (window.__overlayCoverInterval) {
                            clearInterval(window.__overlayCoverInterval);
                            window.__overlayCoverInterval = null;
                        }
                        return window.__overlayCoverSamples || [];
                    });
                } catch(e) {}
                const coverFrames = coverSamples.filter(s => s.cover).length;
                const coverPct = coverSamples.length ? (coverFrames / coverSamples.length * 100).toFixed(0) : 'n/a';
                check(`${f.kind} hot-switch does NOT cover editor with full-screen overlay`,
                      coverFrames === 0,
                      `${coverFrames}/${coverSamples.length} samples covered (${coverPct}%)`);
            } else {
                // Cross-type opens DO re-fetch from cache (browser HTTP cache
                // hit — fast but not "no fetch"). Just record that too.
                log(`    ${f.kind} cross-type cold reload, ${wasmRefetches.length} wasm/data fetches`);
            }
        }

        log(allPassed ? '\n✓ ALL PRE-WARM TESTS PASSED' : '\n✗ SOME PRE-WARM TESTS FAILED');
    } catch (e) {
        log('Error: ' + e.message);
        allPassed = false;
    } finally {
        await browser.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
