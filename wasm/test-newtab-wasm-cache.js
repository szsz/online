// Diagnostic: does a SECOND tab in the SAME browser re-download online.wasm?
//
// User-reported on staging (2026-05-06): warm second-visit takes ~30 s, with
// a 27 s "still waiting on run dependencies: wasm-instantiate" gap. The HTTP
// cache should serve online.wasm with `cache-control: immutable`, and the V8
// WebAssembly compile cache should be hot inside the same browser process —
// so a same-browser new tab should restore in ~10 s, not ~30 s.
//
// This test compares three openings of the same file:
//   tab1  — cold visit; expect full transferSize and a 25–60 s load
//   tab2  — same browser context as tab1; HTTP cache + V8 compile cache hot.
//           If tab2 re-downloads online.wasm, that's the bug we're chasing.
//   tab3  — separate browser context (no shared cache); should mirror tab1.
//
// We measure two things per tab:
//   a) `online.<hash>.wasm` resource timing → transferSize, decodedBodySize
//   b) Time from navigation to `snapshot:signal restored` in the iframe
//      console (or `dom:first_canvas` if snapshot path isn't used).

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');

const VIEWER  = env.FILE_STORAGE_URL;
const FIXTURE = path.join(__dirname, '..', 'test', 'data', 'test document.docx');
const NAME    = `newtab-cache-${Date.now()}.docx`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0    = Date.now();
const log   = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

// Visit a URL on a fresh page. Captures iframe console events that mark the
// snapshot path, and resource timing for online.wasm + soffice.data inside
// the editor frame.
async function openAndMeasure(label, page, url, waitMs) {
    const tStart = Date.now();
    const events = [];
    page.on('console', m => {
        const t = m.text();
        if (/(snapshot:|wasm-instantiate|first_canvas|Document ready|main\(\) entry|warm_restore|emscripten:calledRun)/i.test(t)) {
            events.push(`[${((Date.now() - tStart) / 1000).toFixed(2)}s] ${t.substring(0, 200)}`);
        }
    });

    log(`[${label}] navigating to ${url.substring(0, 90)}…`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

    // Watchpoint: snapshot:signal restored OR a 60 s ceiling.
    const deadline = Date.now() + waitMs;
    let restoredAt = null;
    while (Date.now() < deadline) {
        const hit = events.find(e => /snapshot:signal restored|emscripten:calledRun/.test(e));
        if (hit) {
            restoredAt = (Date.now() - tStart) / 1000;
            break;
        }
        await sleep(500);
    }

    // Pull resource timing out of every same-origin frame we can reach.
    const resourcesPerFrame = [];
    for (const fr of page.frames()) {
        try {
            const rs = await fr.evaluate(() => {
                return performance.getEntriesByType('resource')
                    .filter(e => /online\.[0-9a-f]+\.wasm|soffice\.[0-9a-f]+\.data|wasm-loader\.[0-9a-f]+\.js|bundle\.[0-9a-f]+\.js/.test(e.name))
                    .map(e => ({
                        name: e.name.split('/').pop(),
                        transferSize: e.transferSize,
                        decodedBodySize: e.decodedBodySize,
                        encodedBodySize: e.encodedBodySize,
                        duration: Math.round(e.duration),
                    }));
            });
            if (rs && rs.length) resourcesPerFrame.push({ url: fr.url(), rs });
        } catch (_) { /* cross-origin frame, skip */ }
    }

    return { tStart, restoredAt, events, resourcesPerFrame };
}

function summarizeResources(label, resourcesPerFrame) {
    log(`[${label}] resource timings (per frame):`);
    if (resourcesPerFrame.length === 0) {
        log(`  (no same-origin frame had timings — probably reading from iframe was blocked)`);
        return;
    }
    for (const fr of resourcesPerFrame) {
        log(`  frame: ${fr.url.substring(0, 80)}…`);
        for (const r of fr.rs) {
            // Definition: transferSize === 0 && decodedBodySize > 0 ⇒ HTTP-cache hit.
            const cached = r.transferSize === 0 && r.decodedBodySize > 0;
            const tag = cached ? 'CACHED   ' : `NETWORK ${(r.transferSize / 1048576).toFixed(1)}MB`;
            log(`    ${r.name.padEnd(36)}  ${tag}  decoded=${(r.decodedBodySize / 1048576).toFixed(1)}MB  dur=${r.duration}ms`);
        }
    }
}

(async () => {
    log('=== Diag: same-browser new-tab WASM cache ===');

    if (!fs.existsSync(FIXTURE)) {
        log(`SKIP: fixture missing: ${FIXTURE}`);
        process.exit(2);
    }

    const bytes = fs.readFileSync(FIXTURE);
    const up    = await uploadV2(VIEWER, NAME, bytes);
    const url   = `${VIEWER}/?singleuser#file=${up.b64urlSecret}`;
    log(`uploaded ${NAME} (${(bytes.length / 1024).toFixed(0)}KB) → fileId=${up.fileId.substring(0, 12)}…`);
    log(`url:     ${url}`);

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    try {
        // ── TAB 1 (cold) — same default context ────────────────────────
        const ctx1 = browser.defaultBrowserContext();
        const tab1 = await ctx1.newPage();
        await tab1.setViewport({ width: 1280, height: 900 });
        const r1 = await openAndMeasure('tab1-cold', tab1, url, 90000);
        log(`[tab1-cold] restoredAt=${r1.restoredAt ?? 'NEVER'}s  events=${r1.events.length}`);
        summarizeResources('tab1-cold', r1.resourcesPerFrame);
        await tab1.close();

        // Pause briefly to let any deferred snapshot-save work settle.
        await sleep(3000);

        // ── TAB 2 (same browser context — should be warm) ──────────────
        // browser.newPage() ⇒ same default context ⇒ shared HTTP cache,
        // shared Cache Storage, shared Service Worker, shared V8 isolate.
        const tab2 = await ctx1.newPage();
        await tab2.setViewport({ width: 1280, height: 900 });
        const r2 = await openAndMeasure('tab2-sameCtx', tab2, url, 60000);
        log(`[tab2-sameCtx] restoredAt=${r2.restoredAt ?? 'NEVER'}s  events=${r2.events.length}`);
        summarizeResources('tab2-sameCtx', r2.resourcesPerFrame);
        await tab2.close();

        // ── INCOGNITO simulation: a fresh BrowserContext is the puppeteer
        // equivalent of a private window. Open TWO tabs in the SAME fresh
        // context — that mirrors "open file in incognito tab 1, then open
        // it again in incognito tab 2 of the same incognito session".
        // User reports this is the slow path (regression: used to be fast).
        const incognito = await browser.createBrowserContext();

        const tab3 = await incognito.newPage();
        await tab3.setViewport({ width: 1280, height: 900 });
        const r3 = await openAndMeasure('tab3-incog-cold', tab3, url, 90000);
        log(`[tab3-incog-cold] restoredAt=${r3.restoredAt ?? 'NEVER'}s  events=${r3.events.length}`);
        summarizeResources('tab3-incog-cold', r3.resourcesPerFrame);
        await tab3.close();

        await sleep(3000);

        // tab4 — second tab in SAME incognito context. Should be warm if
        // HTTP cache + Cache Storage + V8 compile cache work in incognito.
        const tab4 = await incognito.newPage();
        await tab4.setViewport({ width: 1280, height: 900 });
        const r4 = await openAndMeasure('tab4-incog-warm', tab4, url, 90000);
        log(`[tab4-incog-warm] restoredAt=${r4.restoredAt ?? 'NEVER'}s  events=${r4.events.length}`);
        summarizeResources('tab4-incog-warm', r4.resourcesPerFrame);
        await tab4.close();

        await incognito.close();

        // ── Verdict ────────────────────────────────────────────────────
        log('\n=== Verdict ===');
        const wasm = label => {
            const fr = label.resourcesPerFrame.flatMap(f => f.rs);
            return fr.find(r => /online\.[0-9a-f]+\.wasm/.test(r.name));
        };
        const dat = label => {
            const fr = label.resourcesPerFrame.flatMap(f => f.rs);
            return fr.find(r => /soffice\.[0-9a-f]+\.data/.test(r.name));
        };
        const fmt = (w, name) => w
            ? `${name.padEnd(12)} transfer=${(w.transferSize / 1048576).toFixed(1).padStart(5)}MB  decoded=${(w.decodedBodySize / 1048576).toFixed(1).padStart(5)}MB  dur=${String(w.duration).padStart(5)}ms`
            : `${name.padEnd(12)} (no-timing)`;

        for (const [name, r] of [['tab1-cold', r1], ['tab2-same', r2], ['tab3-incog1', r3], ['tab4-incog2', r4]]) {
            log(`${name.padEnd(12)} restored=${String(r.restoredAt ?? 'NEVER').padStart(7)}s`);
            log(`             ${fmt(wasm(r), 'online.wasm')}`);
            log(`             ${fmt(dat(r),  'soffice.data')}`);
        }

        // Compare incognito tab1 vs tab2 — that's the user's regression.
        const incogDelta = (r3.restoredAt && r4.restoredAt) ? (r3.restoredAt - r4.restoredAt).toFixed(1) : 'n/a';
        log(`\nIncognito warm-up: tab1=${r3.restoredAt}s → tab2=${r4.restoredAt}s (saved ${incogDelta}s on second visit)`);
        if (r4.restoredAt && r4.restoredAt > 15) {
            log('*** BUG REPRODUCED: incognito second-visit is still slow (>15s). ***');
            log(`    online.wasm  duration tab3=${wasm(r3)?.duration}ms  tab4=${wasm(r4)?.duration}ms`);
            log(`    soffice.data duration tab3=${dat(r3)?.duration}ms   tab4=${dat(r4)?.duration}ms`);
        } else if (r4.restoredAt && r4.restoredAt < 8) {
            log('✓ Incognito second-visit is fast — bug NOT reproduced in puppeteer incognito-simulation.');
        }
    } finally {
        await browser.close();
    }

    process.exit(0);
})();
