// Diagnostic harvest: ribbon vs sidebar iconview rendersCache delivery.
//
// What this test does (NOT a regression — always passes):
//   1. Opens a docx via the viewer in a real Chromium.
//   2. Waits for the editor iframe + ribbon + sidebar to settle.
//   3. Flips window.__l10nIconviewDebug = true inside the editor
//      iframe — that's the flag added in iter 10 to
//      Util.OnDemandRenderer that emits one console line per
//      iconview/treeview/combobox entry render with cache state
//      (hit / miss / no-entry / no-images-map / cacheKeys count).
//   4. Forces the ribbon Styles dropdown OPEN so the iconview
//      requests renders for every visible style entry.
//   5. Captures the console stream from the editor iframe for
//      ~3 seconds, filters to [OnDemandRenderer] lines, aggregates
//      the cache-state distribution per controlId.
//   6. Writes the breakdown to /tmp/static-deploy/public/reports/
//      iconview-rendercache-diag.json so iter 6 (deferred ribbon-
//      sidebar fix) has the data it needs.
//
// Why this is its own iter:
//   The ribbon Styles iconview placeholder text issue (#195) had
//   conflicting hypotheses — kit-side image emission missing, vs
//   browser-side cache lookup keyed wrong, vs sidebar populating
//   rendersCache before ribbon is even visible. The diagnostic
//   ground-truth dump separates those: if cacheKeys for the ribbon's
//   controlId is 0 every time it fires, kit isn't emitting; if
//   cacheKeys grows but the specific entryId we want isn't in the
//   map, the keying is wrong; if cacheKeys is populated and entryId
//   matches, the placeholder swap path is broken downstream.

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

const VIEWER  = env.FILE_STORAGE_URL;
// Reuse the existing custom-styles fixture — it has the most stylesview
// entries (built-ins + 5 custom paragraph styles), which gives the
// largest sample of cache-state events in one harvest run.
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'custom-styles.docx');
const NAME    = `iconview-rendercache-diag-${Date.now()}.docx`;
const REPORT_PATH = '/tmp/static-deploy/public/reports/iconview-rendercache-diag.json';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

(async () => {
    log('=== Diag: iconview rendersCache delivery harvest ===');

    if (!fs.existsSync(FIXTURE)) {
        log(`SKIP: fixture missing: ${FIXTURE}`);
        process.exit(2);
    }

    const bytes = fs.readFileSync(FIXTURE);
    const up = await uploadV2(VIEWER, NAME, bytes);
    const url = `${VIEWER}/?singleuser#file=${up.b64urlSecret}`;
    log(`uploaded ${NAME} (${(bytes.length / 1024).toFixed(0)}KB)`);

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });

    // Diagnostic events flow up via console messages from the editor
    // iframe (Util.OnDemandRenderer's window.console.log call). We
    // collect them all here and parse after the observation window.
    const events = [];
    page.on('console', m => {
        const t = m.text();
        if (t.startsWith('[OnDemandRenderer]')) events.push(t);
    });

    // CRITICAL: set the debug flag BEFORE any iframe JS runs.
    // page.evaluateOnNewDocument installs the script via CDP's
    // Page.addScriptToEvaluateOnNewDocument and propagates it to
    // every nested frame too — including the editor iframe.
    // Without this, frame.evaluate(setFlag) runs AFTER the
    // OnDemandRenderer.setupOnDemandRenderer calls have already
    // fired (TileManager.appendAfterFirstTileTask runs them on the
    // first tile, well before our 4s settle window) and the flag
    // check returns false at every callsite — totalEvents=0.
    await page.evaluateOnNewDocument(() => {
        window.__l10nIconviewDebug = true;
    });

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded',
                              timeout: env.scaleTimeout(120000) });

        // Wait for the editor frame to become routable.
        let frame = null;
        for (let i = 0; i < 90 && !frame; i++) {
            frame = page.frames().find(f => f.url().includes('cool.html'));
            if (frame && !(await frame.$('#document-canvas').catch(() => null))) frame = null;
            if (!frame) await sleep(1000);
        }
        if (!frame) throw new Error('editor frame never loaded');
        await sleep(4000); // settle for stylesview population

        // Belt-and-braces: re-set in case the iframe document was
        // recreated mid-load (cool.html navigates inside the iframe
        // a couple of times during snapshot restore).
        await frame.evaluate(() => { window.__l10nIconviewDebug = true; });
        log(`debug flag locked in via evaluateOnNewDocument; ${events.length} events captured during initial mount`);

        // Force lazy renders: scroll the stylesview to the end then
        // back to the start so every offscreen entry intersects the
        // viewport at least once. Util.OnDemandRenderer uses an
        // IntersectionObserver, so the entries that never come into
        // view never request a render. Without this, only the
        // initially-visible entries get logged.
        await frame.evaluate(() => {
            const sv = document.getElementById('stylesview');
            if (!sv) return;
            const entries = sv.querySelectorAll('.ui-iconview-entry');
            for (const e of entries) {
                e.scrollIntoView({ block: 'nearest', behavior: 'instant' });
            }
        });
        await sleep(2000);

        // Also click the Styles dropdown if accessible — opens the
        // full picker (different controlId from the ribbon strip).
        const dropdownSelectors = [
            '#stylesview-dropdown-image',
            '#paragraph-styles-button',
            '.notebookbar #stylesview-arrow',
        ];
        for (const sel of dropdownSelectors) {
            const handle = await frame.$(sel).catch(() => null);
            if (handle) {
                try { await handle.click(); log(`clicked ${sel}`); break; }
                catch (_) {}
            }
        }
        await sleep(2000);

        // Stop receiving events now — anything past this is noise.
        await frame.evaluate(() => { window.__l10nIconviewDebug = false; });

        // Aggregate by (controlType, controlId) → cache-state
        // distribution. Each event line is:
        //   [OnDemandRenderer] controlType=X controlId=Y entryId=N
        //   cacheState=hit|miss|no-entry|no-images-map cacheKeys=K
        const byControl = new Map();
        for (const ev of events) {
            const m = ev.match(/controlType=(\S+) controlId=(\S+) entryId=(\d+) cacheState=(\S+) cacheKeys=(\d+)/);
            if (!m) continue;
            const [, controlType, controlId, , state, ] = m;
            const key = `${controlType}:${controlId}`;
            if (!byControl.has(key)) byControl.set(key, {
                controlType, controlId,
                states: { hit: 0, miss: 0, 'no-entry': 0, 'no-images-map': 0 },
                events: 0,
            });
            const e = byControl.get(key);
            e.states[state] = (e.states[state] || 0) + 1;
            e.events++;
        }

        const summary = Array.from(byControl.values())
                              .sort((a, b) => b.events - a.events);

        log(`captured ${events.length} OnDemandRenderer events across ${summary.length} controls`);
        for (const s of summary) {
            const parts = Object.entries(s.states)
                                .filter(([, n]) => n > 0)
                                .map(([k, n]) => `${k}=${n}`)
                                .join(' ');
            log(`  ${s.controlType.padEnd(10)} ${s.controlId.padEnd(40)} ${parts}`);
        }

        fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
        fs.writeFileSync(REPORT_PATH, JSON.stringify({
            fixture: NAME,
            capturedAt: new Date().toISOString(),
            totalEvents: events.length,
            controls: summary,
            // Keep first 50 raw lines for ad-hoc review.
            sampleEvents: events.slice(0, 50),
        }, null, 2));
        log(`report written: ${REPORT_PATH}`);

    } catch (e) {
        log(`ERROR: ${e.message}`);
        // Diag tests should not fail the suite on transient errors.
    } finally {
        try { await browser.close(); } catch (_) {}
    }

    process.exit(0);
})().catch(e => {
    console.error('FATAL', e);
    process.exit(0); // diag — never block the suite
});
