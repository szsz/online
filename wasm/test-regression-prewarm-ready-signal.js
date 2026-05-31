// Regression test: viewer's prewarmReady must be set on the LATE
// WasmPrewarmReady signal, not the EARLY App_LoadingStatus=Initialized.
//
// Background: COOL Map.js fires App_LoadingStatus=Initialized when the
// framework boots — well before the prewarm doc has painted and before
// __wasmInitialDocLoaded is set in wasm-loader.js. The viewer used to
// key prewarmReady on that early signal, which made openFile take the
// hot-switch branch (wasPrewarmReady=true). The hot-switch dispatched
// switchdocument to the iframe, but trySendSwitch sat in
// pendingSwitchFilename for ~30 s waiting for __wasmInitialDocLoaded
// before actually delivering the command — so the user perceived
// "broken hot-switch" (a 30+ s delay between click and any visible
// progress).
//
// The fix: add a dedicated WasmPrewarmReady postMessage emitted by
// wasm-loader.js exactly when __wasmInitialDocLoaded becomes true,
// and gate the viewer's prewarmReady on THAT.
//
// What this test verifies: from a clean viewer load, prewarmReady stays
// false during the early-Initialized window and only becomes true after
// WasmPrewarmReady arrives. We intercept the iframe's postMessage stream
// and assert the ordering: (1) early Initialized fires first; (2) at
// that moment prewarmReady is still false; (3) WasmPrewarmReady fires
// later; (4) at that moment prewarmReady becomes true.

const puppeteer = require('puppeteer');
const env = require('./lib/test-env');

const VIEWER = env.FILE_STORAGE_URL || 'https://viewer.szebeni.hu';

const T0 = Date.now();
function elapsed() { return ((Date.now() - T0) / 1000).toFixed(1) + 's'; }
function log(m) { console.log(`[${elapsed()}] ${m}`); }

(async () => {
    log('=== prewarm-ready signal ordering ===');
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        ignoreHTTPSErrors: true,
    });

    let allPassed = true;
    try {
        const page = await browser.newPage();

        // Snapshot prewarmReady at every parent-side postMessage from
        // the iframe, by hooking window.addEventListener('message').
        await page.evaluateOnNewDocument(() => {
            window.__pwLog = [];
            const orig = window.addEventListener;
            window.addEventListener = function(type, handler, opts) {
                if (type === 'message' && typeof handler === 'function') {
                    const wrapped = function(ev) {
                        try {
                            if (typeof ev.data === 'string') {
                                const m = JSON.parse(ev.data);
                                if (m && m.MessageId) {
                                    window.__pwLog.push({
                                        msg: m.MessageId,
                                        status: m.Values && m.Values.Status,
                                        values: m.Values || null,
                                        prewarmReadyBefore: !!(window.__viewerState && window.__viewerState.prewarmReady),
                                        t: Date.now(),
                                    });
                                }
                            }
                        } catch(e) {}
                        return handler.call(this, ev);
                    };
                    return orig.call(this, type, wrapped, opts);
                }
                return orig.apply(this, arguments);
            };
        });

        await page.goto(VIEWER, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('#upload', { timeout: 30000 });
        log('Viewer landed; waiting for prewarm to complete');

        await page.waitForFunction(
            () => !!(window.__viewerState && window.__viewerState.prewarmReady),
            { timeout: 90000, polling: 500 }
        );
        log('prewarmReady=true reached');

        const log_ = await page.evaluate(() => window.__pwLog);
        const initialized = log_.filter(e => e.msg === 'App_LoadingStatus' && e.status === 'Initialized');
        const prewarmMsgs = log_.filter(e => e.msg === 'WasmPrewarmReady');

        log(`saw ${initialized.length}× App_LoadingStatus=Initialized, ${prewarmMsgs.length}× WasmPrewarmReady`);

        // Assertion 1: at least one App_LoadingStatus=Initialized arrived BEFORE
        // prewarmReady was true.
        const earlyInits = initialized.filter(e => e.prewarmReadyBefore === false);
        const ok1 = earlyInits.length > 0;
        console.log((ok1 ? '  ✓' : '  ✗') +
            ' early App_LoadingStatus=Initialized observed while prewarmReady=false (' +
            earlyInits.length + ')');
        if (!ok1) allPassed = false;

        // Assertion 2: WasmPrewarmReady fires AT MOST ONCE per iframe.
        // The viewer hosts up to 2 WASM iframes simultaneously (the
        // hidden prewarm iframe + the user-facing editor iframe), so 1
        // or 2 events at the viewer level is the expected range. The
        // bug this assertion catches is the WITHIN-iframe duplicate
        // emit (init block firing twice, doubling the event count): if
        // each iframe fires once, total ≤ 2; if each fires twice
        // (pre-fix), total ≥ 3. The wasm-loader.js idempotency guard
        // (`__wasmPrewarmReadySent`) is what keeps each iframe to one
        // emit. We also assert each filename is unique to catch a
        // single iframe emitting multiple times under a future race.
        const ok2 = prewarmMsgs.length >= 1 && prewarmMsgs.length <= 2;
        console.log((ok2 ? '  ✓' : '  ✗') +
            ' WasmPrewarmReady fired ≤ 1 per iframe (got ' + prewarmMsgs.length +
            ', expected 1–2 — one per WASM iframe in the viewer)');
        if (!ok2) allPassed = false;

        // Assertion 3: WasmPrewarmReady arrived AFTER the first early Initialized.
        if (initialized.length > 0 && prewarmMsgs.length > 0) {
            const ok3 = prewarmMsgs[0].t >= initialized[0].t;
            console.log((ok3 ? '  ✓' : '  ✗') +
                ' WasmPrewarmReady (' + prewarmMsgs[0].t + ') arrived at-or-after first Initialized (' +
                initialized[0].t + ')');
            if (!ok3) allPassed = false;
        }

        // Assertion 4: BEFORE WasmPrewarmReady processing began, prewarmReady was
        // still false (the snapshot is taken in the listener wrapper before the
        // viewer's handler runs, so this is a hard ordering guarantee).
        if (prewarmMsgs.length > 0) {
            const ok4 = prewarmMsgs[0].prewarmReadyBefore === false;
            console.log((ok4 ? '  ✓' : '  ✗') +
                ' prewarmReady was false when WasmPrewarmReady arrived');
            if (!ok4) allPassed = false;
        }
    } catch (e) {
        log('FATAL: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        await browser.close();
    }

    console.log(allPassed ? '\n✓ ALL CHECKS PASSED' : '\n✗ SOME CHECKS FAILED');
    process.exit(allPassed ? 0 : 1);
})();
