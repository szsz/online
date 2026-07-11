// test-cv-regression-iconview-rendercache-diag.js — diagnostic harvest of
// ribbon/sidebar iconview rendersCache delivery, run through the content
// viewer's /collabora-tester flow.
//
// Migrated from wasm/tests/regression/test-regression-iconview-rendercache-diag.js
// — legacy version retired.
//
// This is a DIAGNOSTIC, not a regression: it always exits 0. It opens a
// custom-styles docx through the real content-viewer tester, flips the
// editor's window.__l10nIconviewDebug flag so Util.OnDemandRenderer emits one
// console line per iconview/treeview/combobox entry render with its cache
// state (hit / miss / no-entry / no-images-map / cacheKeys count), forces the
// stylesview entries to render (scroll + open the Styles dropdown), captures
// the [OnDemandRenderer] console stream, and writes a per-controlId cache-
// state breakdown to a JSON report so downstream work (the deferred ribbon-
// sidebar iconview fix, #195) has ground-truth data.
//
// Only the harness changed: the legacy version opened the doc via the viewer
// deep link (uploadV2 + `/?singleuser#file=<secret>`); this version uploads
// through the tester's real file <input> and reads the same debug console
// stream from the SW-proxied editor iframe. The debug flag is installed via
// page.evaluateOnNewDocument (propagates to the nested editor iframe) so it is
// set BEFORE OnDemandRenderer.setupOnDemandRenderer fires on the first tile.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-iconview-rendercache-diag.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, waitCvInteractive, cvEditorFrame } = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'custom-styles.docx');
const REPORT_PATH = '/tmp/content-viewer-report/iconview-rendercache-diag.json';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

(async () => {
    log('=== CV Diag: iconview rendersCache delivery harvest ===');

    if (!fs.existsSync(FIXTURE)) { log(`SKIP: fixture missing: ${FIXTURE}`); process.exit(0); }
    log('viewer: ' + BASE);

    const { browser } = await launch({ headless: 'new' });
    // Collect the editor iframe's [OnDemandRenderer] diagnostic lines. In the
    // content viewer the editor iframe is same-origin (SW-proxied), so its
    // console events bubble to the top page's 'console' listener.
    const events = [];
    const onConsole = m => {
        const t = m.text();
        if (t.startsWith('[OnDemandRenderer]')) events.push(t);
    };

    try {
        const page = await browser.newPage();
        // CRITICAL: set the debug flag BEFORE any iframe JS runs.
        // page.evaluateOnNewDocument propagates the script to every nested
        // frame (including the editor iframe) via CDP, so the flag is true
        // when OnDemandRenderer.setupOnDemandRenderer fires on the first tile.
        await page.evaluateOnNewDocument(() => { window.__l10nIconviewDebug = true; });
        page.on('console', onConsole);

        // Larger viewport → more stylesview entries visible → larger sample.
        await openViaContentViewer(browser, BASE, FIXTURE, {
            page, iframeTimeout: 60000, viewport: { width: 1600, height: 1000 },
        });
        if (!(await waitCvInteractive(page, LOAD_BUDGET))) { log('editor never interactive'); process.exit(0); }

        let frame = cvEditorFrame(page);
        for (let i = 0; i < 90 && !frame; i++) { await sleep(1000); frame = cvEditorFrame(page); }
        if (!frame) { log('editor frame never resolved'); process.exit(0); }
        await sleep(4000); // settle for stylesview population

        // Belt-and-braces: re-set in case the iframe document was recreated
        // mid-load (the editor navigates cool.html a couple of times).
        await frame.evaluate(() => { window.__l10nIconviewDebug = true; }).catch(() => {});
        log(`debug flag locked in; ${events.length} events captured during initial mount`);

        // Force lazy renders: bring every stylesview entry into view once so
        // its IntersectionObserver-gated render fires.
        await frame.evaluate(() => {
            const sv = document.getElementById('stylesview');
            if (!sv) return;
            for (const e of sv.querySelectorAll('.ui-iconview-entry')) {
                e.scrollIntoView({ block: 'nearest', behavior: 'instant' });
            }
        }).catch(() => {});
        await sleep(2000);

        // Also open the Styles dropdown (a different controlId from the strip).
        for (const sel of ['#stylesview-dropdown-image', '#paragraph-styles-button', '.notebookbar #stylesview-arrow']) {
            const handle = await frame.$(sel).catch(() => null);
            if (handle) { try { await handle.click(); log(`clicked ${sel}`); break; } catch (_) {} }
        }
        await sleep(2000);

        await frame.evaluate(() => { window.__l10nIconviewDebug = false; }).catch(() => {});

        // Aggregate by (controlType, controlId) → cache-state distribution.
        const byControl = new Map();
        for (const ev of events) {
            const m = ev.match(/controlType=(\S+) controlId=(\S+) entryId=(\d+) cacheState=(\S+) cacheKeys=(\d+)/);
            if (!m) continue;
            const [, controlType, controlId, , state] = m;
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
        const summary = Array.from(byControl.values()).sort((a, b) => b.events - a.events);

        log(`captured ${events.length} OnDemandRenderer events across ${summary.length} controls`);
        for (const s of summary) {
            const parts = Object.entries(s.states).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' ');
            log(`  ${s.controlType.padEnd(10)} ${s.controlId.padEnd(40)} ${parts}`);
        }

        fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
        fs.writeFileSync(REPORT_PATH, JSON.stringify({
            fixture: path.basename(FIXTURE),
            capturedAt: new Date().toISOString(),
            totalEvents: events.length,
            controls: summary,
            sampleEvents: events.slice(0, 50),
        }, null, 2));
        log(`report written: ${REPORT_PATH}`);
    } catch (e) {
        log(`ERROR: ${(e && e.message) || e}`);
        // Diag tests should not fail the suite on transient errors.
    } finally {
        try { await browser.close(); } catch (_) {}
    }
    process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(0); });
