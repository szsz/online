// test-snapshot-milestones.js — produce a published report (HTML + screenshots)
// proving snapshot timings end-to-end for each doc type.
//
// For every (cold, warm) × (writer, calc, impress):
//   - run the session in SINGLE-USER mode (no relay) so timing isn't blurred
//     by relay handshake noise
//   - record every recognised milestone — both console-derived (loader:start,
//     emscripten:module_defined, calledRun, COOLWSD ENTERED, lok_init_2 done,
//     etc.) and DOM-derived (first <canvas> in iframe, status text appears,
//     doc-type-specific content verified)
//   - take a screenshot at each milestone — NOT just at the end — so each
//     row in the report shows the iframe's actual visual state at that
//     moment
//   - the terminal milestone is `content_verified`: iframe has a <canvas>
//     AND the status bar contains doc-type-specific text (\d+ words /
//     Sheet N of M / Slide N of M).  The session waits for this, not just
//     for `prewarm:ready` (which doesn't always fire).
//   - on timeout, dump the iframe DOM to a debug file so failures are
//     diagnosable from the report alone
//   - write all this to /tmp/hot-switch-report/snapshot-milestones/
//     which the viewer serves at /report/snapshot-milestones/
//
// Output: one section per doc type per phase, one row per milestone with
// the screenshot embedded.

'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const OUT_DIR = '/tmp/hot-switch-report/snapshot-milestones';
const T0 = Date.now();
// Cold sessions use the full timeout (cold can take 25-40s; we allow
// slack). Warm sessions get a tighter budget — passing warms complete
// in 10-15s; if a trial hasn't verified by 60s it's hung, no need to
// wait the full 180s.
// Iter 79: scaled via env.scaleTimeout — under JOBS_SCALE>1 the
// per-trial wait widens proportionally so the wrapper's "any-trial
// verified" gate gets the patience it needs under contention. The
// WARM_BUDGET_MS gate below stays unscaled; it's the actual perf
// regression detector and should fail when warm gets slow.
const TIMEOUT_MS = env.scaleTimeout(180000);
const WARM_TIMEOUT_MS = env.scaleTimeout(60000);
// Wall-time budget for a warm trial. Typical good runs verify in 7-11 s
// (writer/calc) and 9-12 s (impress). Under CPU contention from
// concurrent puppeteer Chromes (parallel test runner JOBS≥2, or the
// GitHub actions-runner running tests on the same host) we've seen
// impress warm at 17 s. The threshold below catches "warm is very
// slow" — either an intrinsic regression or environmental contention
// — and fails the run rather than silently passing on the
// "any-trial-verified" gate.
//
// Sources of slow warm we know of:
//   1. Concurrent puppeteer Chrome processes pegging CPU (parallel
//      runner with JOBS=2/4, or actions-runner running tests against
//      Azure on the same host)
//   2. /tmp filling up (Cache Storage flush stalls) — `df /tmp`
//   3. Plan-C parking interactions on impress (4× onLoad chain
//      observed in test-snapshot-cross-type warm-impress)
//
// Override with WARM_BUDGET_MS env if you're investigating something
// specific.
const WARM_BUDGET_MS = parseInt(process.env.WARM_BUDGET_MS || '20000', 10);
// Number of warm trials per cold session. Warm-restore is currently flaky
// (~33% pass rate, see project_warm_pthread_flake.md). One trial per
// iteration produces noisy data; N=3 lets us track pass-rate trends as
// recommendations land. Set WARM_TRIALS=1 for a fast smoke run.
const WARM_TRIALS = parseInt(process.env.WARM_TRIALS || '3', 10);

const DATA_DIR = path.join(__dirname, '..', 'test', 'data');

// Per doc type: what status text and what selector prove the document
// is actually rendered (not just a loading spinner).
const ALL_DOCS = [
    { tag: 'writer',  doc: 'new.docx',         label: 'Writer (.docx)',
      expectStatus: /\d+\s*words?/i,
      expectAssert: '#StateWordCount' },
    { tag: 'calc',    doc: 'testdoc.xlsx',     label: 'Calc (.xlsx)',
      expectStatus: /Sheet\s*\d+\s*of/i,
      expectAssert: '#StatusDocPos' },
    { tag: 'impress', doc: 'rare-fonts.pptx',  label: 'Impress (.pptx)',
      expectStatus: /(Slide\s*\d+|page\s*\d+\s*of)/i,
      expectAssert: 'canvas' },
];
// ONLY_DOC=writer|calc|impress to run a single doc type — used for
// isolation testing when one doc type appears to be the bad apple, so
// we can rule out state leaking from prior docs in the loop.
const DOCS = process.env.ONLY_DOC
    ? ALL_DOCS.filter(d => d.tag === process.env.ONLY_DOC)
    : ALL_DOCS;

// Console-derived milestones: regex matched against each console line.
const CONSOLE_MILESTONES = [
    { id: 'nav_start',           label: 'Navigation start',                    re: /loader:start\b/ },
    { id: 'snapshot_exists',     label: 'Snapshot found in Cache Storage',     re: /snapshot:exists/ },
    { id: 'snapshot_not_found',  label: 'No snapshot (cold)',                  re: /snapshot:not_found/ },
    { id: 'wasm_compile_done',   label: 'WASM module compiled (V8)',           re: /emscripten:module_defined/ },
    { id: 'fs_ready',            label: 'Emscripten FS ready',                 re: /emscripten:FS_ready/ },
    { id: 'soffice_data',        label: 'soffice.data fetched',                re: /xhr_loadend soffice\.data/ },
    { id: 'heap_loaded',         label: 'HEAPU8 restored (warm only)',         re: /snapshot:heap_loaded/ },
    { id: 'warm_reset',          label: 'Warm-restore mutex resets done',      re: /WARM_DBG: YieldMutex reset OK/ },
    { id: 'called_run',          label: 'callMain reached',                    re: /emscripten:calledRun/ },
    { id: 'main_entry',          label: 'wasmapp main() entry',                re: /TIMING: wasmapp main\(\) entry/ },
    { id: 'coolwsd_spawned',     label: 'COOLWSD thread spawned',              re: /TIMING: main: COOLWSD thread spawned/ },
    { id: 'coolwsd_entered',     label: 'COOLWSD thread entered body',         re: /TIMING: COOLWSD thread ENTERED/ },
    { id: 'coolwsd_run',         label: 'COOLWSD::run starting',               re: /TIMING: COOLWSD::run\(\) starting/ },
    { id: 'innerinit_start',     label: 'innerInitialize START',               re: /TIMING: innerInitialize START/ },
    { id: 'innerinit_done',      label: 'innerInit done',                      re: /TIMING: innerInit: config done/ },
    { id: 'prisoner',            label: 'Prisoner thread started',             re: /TIMING: prisoner thread started/ },
    { id: 'hullo_recv',          label: 'HULLO received from JS',              re: /TIMING: HULLO received/ },
    { id: 'hullo_connected',     label: 'HULLO socket connected',              re: /TIMING: HULLO connected/ },
    { id: 'lok_init_2',          label: 'lok_init_2 done',                     re: /TIMING: lok_init_2 done(?! \()/ },
    { id: 'second_init',         label: 'lok_init_2 SECOND_INIT done',         re: /TIMING: lok_init_2 done \(SECOND_INIT\)/ },
    { id: 'execute_starting',    label: 'wasmshim:Execute_starting',           re: /TIMING: wasmshim:Execute_starting/ },
    { id: 'onload_start',        label: 'onLoad (loadComponentFromURL) start', re: /TIMING: onLoad \(loadComponentFromURL\) starting/ },
    { id: 'onload_done',         label: 'onLoad done',                         re: /TIMING: onLoad done\b/ },
    { id: 'doc_status',          label: 'documentStatus computed',             re: /TIMING: post documentStatus/ },
    { id: 'loaded_session',      label: 'Loaded session (status+tiles to JS)', re: /TIMING: Loaded session/ },
    { id: 'first_doc_painted',   label: 'firstDocPainted returned',            re: /TIMING: kit: firstDocPainted returned/ },
    { id: 'snapshot_capturing',  label: 'Snapshot capturing HEAPU8 (cold)',    re: /snapshot:capturing/ },
    { id: 'snapshot_captured',   label: 'Snapshot bytes captured (cold)',      re: /snapshot:captured/ },
    { id: 'snapshot_saved',      label: 'Snapshot saved to Cache Storage',     re: /snapshot:saved/ },
    { id: 'doc_loaded',          label: 'doc:loaded (canvas painted in iframe)', re: /\[profile \+\d+ms\] doc:loaded/ },
    { id: 'prewarm_ready',       label: 'prewarm:ready (paint detected)',         re: /\[profile \+\d+ms\] prewarm:ready/ },
    { id: 'document_ready_log',  label: 'viewer: Document ready: <file>',         re: /\[viewer\] Document ready:/ },
];

// DOM-derived milestones: produced from polling the iframe document.
const DOM_MILESTONES = [
    { id: 'dom_canvas',        label: 'First <canvas> in iframe (DOM)' },
    { id: 'dom_status_text',   label: 'Status bar populated (DOM)' },
    { id: 'content_verified',  label: 'Document content VERIFIED in iframe DOM' },
    { id: 'shield_dropped',    label: 'Viewer overlay removed — document visible' },
];

const ALL_MILESTONES = [...CONSOLE_MILESTONES, ...DOM_MILESTONES];

const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(m) {
    console.log('[' + ((Date.now() - T0) / 1000).toFixed(1) + 's] ' + m);
}

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

// Probe the parent page for the viewer overlay state. Returns true once
// the viewer's #editor-shield is genuinely no longer visible — i.e. the
// moment the user actually sees the document instead of the spinner.
//
// Earlier versions checked `cs.display === 'none' || !classList.contains('active')`
// which was racy: tryDropShield first sets the label to "Ready" + 100%
// for 200 ms, then calls hideShield(). The element retains `display:flex`
// during the "Ready" window, so screenshots taken when the probe matched
// still showed the spinner. Using offsetWidth/Height + computed display
// catches the genuine hidden state and avoids the brief "Ready" flash.
async function probeShieldDropped(page) {
    try {
        return await page.evaluate(() => {
            const sh = document.getElementById('editor-shield');
            if (!sh) return true;
            const cs = window.getComputedStyle(sh);
            if (cs.display === 'none') return true;
            if (cs.visibility === 'hidden') return true;
            if (parseFloat(cs.opacity || '1') === 0) return true;
            if (sh.offsetWidth === 0 || sh.offsetHeight === 0) return true;
            return false;
        });
    } catch (e) { return false; }
}

// Probe the editor iframe for DOM evidence that the document has rendered.
// Returns { hasCanvas, statusText, statusMatches, assertExists } or
// { hasCanvas:false, ... } if the iframe isn't reachable yet.
async function probeIframe(page, expectStatus, expectAssert) {
    try {
        const frames = page.frames();
        const editorFrame = frames.find(f =>
            (f.url() || '').includes('cool.html')
            || (f.url() || '').includes('/browser/'));
        if (!editorFrame || editorFrame.isDetached()) {
            return { hasCanvas: false, statusText: '', statusMatches: false, assertExists: false };
        }
        return await editorFrame.evaluate((statusRegexSrc, statusRegexFlags, assertSel) => {
            const canvases = document.querySelectorAll('canvas');
            const hasCanvas = canvases.length > 0;
            let statusText = '';
            document.querySelectorAll('[id*="tatus"]').forEach(el => {
                const t = (el.textContent || '').trim();
                if (t) statusText += ' ' + t;
            });
            ['#StateWordCount', '#StatusDocPos', '#PageStatus'].forEach(sel => {
                const el = document.querySelector(sel);
                if (el && el.textContent && el.textContent.trim()) {
                    statusText += ' ' + el.textContent.trim();
                }
            });
            const re = new RegExp(statusRegexSrc, statusRegexFlags);
            const statusMatches = re.test(statusText);
            const assertEl = document.querySelector(assertSel);
            return { hasCanvas, statusText: statusText.substring(0, 300),
                     statusMatches, assertExists: !!assertEl };
        }, expectStatus.source, expectStatus.flags, expectAssert);
    } catch (e) {
        return { hasCanvas: false, statusText: '', statusMatches: false, assertExists: false,
                 error: e.message };
    }
}

async function captureSession({ browser, fileUrl, sessionTag, kind, expectStatus, expectAssert,
                                timeoutMs }) {
    timeoutMs = timeoutMs || TIMEOUT_MS;
    const sessDir = path.join(OUT_DIR, sessionTag);
    ensureDir(sessDir);
    const page = await browser.newPage();
    page.on('dialog', d => d.accept().catch(() => {}));

    const consoleLines = [];
    page.on('console', m => {
        const t = m.text();
        consoleLines.push({ t: Date.now(), line: t.substring(0, 600) });
    });
    page.on('pageerror', e =>
        consoleLines.push({ t: Date.now(), line: 'PAGEERROR: ' + (e.message || '').substring(0, 600) }));

    await page.setCacheEnabled(true);
    await page.setViewport({ width: 1280, height: 900 });

    // navigation. The warm-restore watchdog (wasm-loader.js) reloads the
    // iframe when warm hangs, which can race puppeteer's navigation
    // tracking and surface as a TimeoutError on goto. Catch that — the
    // polling loop below recovers regardless.
    const navStart = Date.now();
    try {
        await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: env.scaleTimeout(30000) });
    } catch (e) {
        consoleLines.push({ t: Date.now(), line: 'NAV_GOTO_ERR: ' + (e.message || '') });
    }

    // milestone state
    const hits = {};         // id → ms-from-navStart
    const screenshots = {};  // id → relative path
    let lastDomProbe = { hasCanvas: false, statusText: '', statusMatches: false, assertExists: false };

    async function recordMilestone(id, atTimestamp, opts = {}) {
        if (hits[id] !== undefined) return;
        hits[id] = atTimestamp - navStart;
        const tStr = String(hits[id]).padStart(7, '0');
        const fname = `${tStr}-${id}.png`;
        const fpath = path.join(sessDir, fname);
        // For terminal milestones, give the page a moment to repaint
        // before screenshotting. tryDropShield first sets the overlay to
        // "Ready" + 100% for 200 ms before actually hiding it; without a
        // settle delay the screenshot at shield_dropped still shows
        // "Ready" instead of the document.
        if (opts.settleMs) await sleep(opts.settleMs);
        try { await page.screenshot({ path: fpath, fullPage: false }); } catch (e) {}
        screenshots[id] = path.relative(OUT_DIR, fpath);
    }

    const deadline = navStart + timeoutMs;
    let consoleCursor = 0;  // Don't drain — process from a moving cursor so
                            // the full log survives for the debug dump.

    while (Date.now() < deadline) {
        // 1. Scan new console lines for console milestones.
        while (consoleCursor < consoleLines.length) {
            const ev = consoleLines[consoleCursor++];
            for (const m of CONSOLE_MILESTONES) {
                if (hits[m.id] !== undefined) continue;
                if (m.re.test(ev.line)) {
                    await recordMilestone(m.id, ev.t);
                }
            }
        }

        // 2. Poll iframe DOM. This is what verifies the document is
        //    actually rendered, not just a "loading…" spinner. Without
        //    this check the report can't tell the difference between
        //    "warm session in progress" and "warm session hung after
        //    callMain". Probe is read-only — never mutates the iframe.
        const probe = await probeIframe(page, expectStatus, expectAssert);
        lastDomProbe = probe;
        const now = Date.now();
        if (hits.dom_canvas === undefined && probe.hasCanvas) {
            await recordMilestone('dom_canvas', now);
        }
        if (hits.dom_status_text === undefined && probe.statusText.trim().length > 0) {
            await recordMilestone('dom_status_text', now);
        }
        if (hits.content_verified === undefined && probe.hasCanvas && probe.statusMatches) {
            await recordMilestone('content_verified', now);
        }
        // 2b. Wait for viewer overlay to drop. Only valid AFTER
        //     content_verified — otherwise we get false positives during
        //     the brief prewarm window where #editor-shield is hidden
        //     before openFileBySecret has run (see viewer/index.html
        //     WasmPrewarmReady handler: `if (!currentFile) hideShield()`).
        //     Once the user's document is verified in the iframe,
        //     shield_dropped means the document is actually *visible*,
        //     not behind the spinner.
        if (hits.shield_dropped === undefined && hits.content_verified !== undefined) {
            const dropped = await probeShieldDropped(page);
            // settle 350ms — tryDropShield's "Ready 100%" label phase
            // lasts 200ms before the actual hideShield() call, plus a
            // frame for the compositor.
            if (dropped) await recordMilestone('shield_dropped', now, { settleMs: 350 });
        }

        // 3. Exit conditions.
        //    - Warm: wait for shield_dropped (terminal milestone — proves
        //      the document is visible, not just rendered behind overlay),
        //      then 1s buffer.
        //    - Cold: also need snapshot_saved before exit, since the cold
        //      session's job is to write the snapshot to Cache Storage;
        //      without that, warm has nothing to read.
        const terminal = hits.shield_dropped !== undefined
                         ? hits.shield_dropped : hits.content_verified;
        if (terminal !== undefined) {
            const buffer = (kind === 'cold') ? 5000 : 1500;
            if (kind === 'cold' && hits.snapshot_saved === undefined) {
                // Keep waiting.
            } else if (hits.shield_dropped === undefined &&
                       Date.now() - (navStart + hits.content_verified) > 30000) {
                // Don't wait forever for shield drop — content is verified
                // in the iframe, that's enough to call the test done if
                // the parent overlay never goes away.
                break;
            } else if (hits.shield_dropped !== undefined &&
                       Date.now() - (navStart + hits.shield_dropped) > buffer) {
                break;
            }
        }
        // Tight polling for sharper milestone resolution. The 200 ms tick
        // used to be enough; with warm visible-at now in the 6-9 s range
        // a 200 ms uncertainty is ~3 % of the metric, big enough to mask
        // sub-second deltas between iterations. 50 ms keeps protocol
        // pressure low (CDP RPC cost is microseconds) but shrinks the
        // recorded-vs-actual gap to <1 %.
        await sleep(50);
    }

    // Final screenshot. Prefer the content_verified shot if present —
    // that's what the user wants to see ("did the document actually
    // render?"). Otherwise capture whatever is on screen at end as
    // evidence of the failure mode.
    const finalShot = path.join(sessDir, 'final.png');
    try { await page.screenshot({ path: finalShot, fullPage: false }); } catch (e) {}

    // Save console log + DOM debug. If content_verified didn't fire,
    // the debug.json shows what the iframe DOM looked like at end —
    // critical for diagnosing "stuck on Opening document…" failures.
    fs.writeFileSync(path.join(sessDir, 'console.log'),
        consoleLines.map(e => `[+${e.t - navStart}ms] ${e.line}`).join('\n'));
    fs.writeFileSync(path.join(sessDir, 'debug.json'), JSON.stringify({
        sessionTag, kind, navStart, totalMs: Date.now() - navStart,
        contentVerified: hits.content_verified !== undefined,
        contentVerifiedAt: hits.content_verified !== undefined
            ? (hits.content_verified / 1000).toFixed(2) + 's' : null,
        shieldDropped: hits.shield_dropped !== undefined,
        shieldDroppedAt: hits.shield_dropped !== undefined
            ? (hits.shield_dropped / 1000).toFixed(2) + 's' : null,
        finalDomProbe: lastDomProbe,
        consoleLines: consoleLines.length,
    }, null, 2));

    await page.close();

    return { hits, screenshots, navStart, totalMs: Date.now() - navStart,
             lastDomProbe, consoleLines: consoleLines.length };
}

function formatRow(milestone, hits, screenshots, prevId, isTerminal) {
    if (hits[milestone.id] === undefined) {
        return `<tr class="missed"><td>${milestone.label}</td><td>—</td><td>—</td><td></td></tr>`;
    }
    const t = hits[milestone.id];
    const delta = prevId && hits[prevId] !== undefined ? (t - hits[prevId]) : null;
    const shot = screenshots[milestone.id]
        ? `<a href="${screenshots[milestone.id]}" target="_blank">
             <img class="shot" src="${screenshots[milestone.id]}" alt="${milestone.id}" loading="lazy" />
           </a>`
        : '';
    const cls = isTerminal ? ' class="terminal"' : '';
    return `<tr${cls}><td>${milestone.label}</td>
                <td>+${(t/1000).toFixed(2)} s</td>
                <td>${delta !== null ? '+' + delta + ' ms' : '—'}</td>
                <td>${shot}</td></tr>`;
}

function emitSessionHtml(docTag, kind, label, result, subdirOverride) {
    const subdir = subdirOverride || `${docTag}-${kind}`;
    const { hits, screenshots, totalMs, lastDomProbe } = result;
    const verified = hits.content_verified !== undefined;
    const dropped  = hits.shield_dropped !== undefined;
    let banner;
    if (dropped) {
        banner = `<p class="ok">✓ Document VISIBLE at +${(hits.shield_dropped/1000).toFixed(2)}s
                  (DOM verified at +${(hits.content_verified/1000).toFixed(2)}s; viewer overlay dropped at
                  +${(hits.shield_dropped/1000).toFixed(2)}s)</p>`;
    } else if (verified) {
        banner = `<p class="warn">⚠ DOM verified at +${(hits.content_verified/1000).toFixed(2)}s
                  but viewer overlay never dropped — user would still see a spinner.</p>`;
    } else {
        banner = `<p class="fail">✗ Document NOT verified — final iframe DOM had
                  canvas=${lastDomProbe.hasCanvas}, statusMatches=${lastDomProbe.statusMatches},
                  statusText=<code>${(lastDomProbe.statusText || '(empty)').substring(0, 120)}</code></p>`;
    }

    let prevId = null;
    let rows = '';
    for (const m of ALL_MILESTONES) {
        if (hits[m.id] === undefined) continue;
        const isTerminal = (m.id === 'shield_dropped') ||
                           (m.id === 'content_verified' && !dropped);
        rows += formatRow(m, hits, screenshots, prevId, isTerminal);
        prevId = m.id;
    }
    return `
    <section id="${subdir}">
      <h2>${label} — ${kind.toUpperCase()} session</h2>
      ${banner}
      <p class="summary">Total wall: <strong>${(totalMs/1000).toFixed(2)} s</strong>.
         Click any thumbnail for full size. The <span class="terminal-tag">highlighted row</span>
         is the moment the document was actually verified rendered in the iframe DOM.</p>
      <table class="milestones">
        <thead><tr><th>Milestone</th><th>t since nav</th><th>Δ since prev</th><th>Screenshot</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="raw"><a href="${subdir}/console.log">raw console log</a> ·
         <a href="${subdir}/debug.json">debug.json</a> ·
         <a href="${subdir}/final.png">final screenshot</a></p>
    </section>`;
}

(async () => {
    // Don't wipe at start — keep the previous run's index.html and
    // session subdirs in place so /report/snapshot-milestones/ never
    // 404s mid-run. Each session captureSession writes to its own
    // subdir (writer-cold/, calc-warm-1/, etc.) which gets overwritten
    // when that session runs. index.html itself only gets rewritten at
    // the end of the run, so the URL keeps serving the previous
    // completed report's index.html until the new one is ready.
    //
    // Trade-off: during a run, the live index.html links to subdirs
    // that may have stale data (overwritten partway). But the link is
    // back up the moment the run finishes, which is the important
    // thing — no 404 windows.
    //
    // Old session subdirs from a longer prior run (e.g. impress-warm
    // when the new run only does writer) WOULD linger. Sweep any
    // session subdir from previous runs that's not in this run's plan,
    // so the report stays consistent.
    const knownTags = new Set();
    for (const d of DOCS) {
        knownTags.add(`${d.tag}-cold`);
        for (let i = 1; i <= WARM_TRIALS; i++) {
            knownTags.add(WARM_TRIALS === 1 ? `${d.tag}-warm` : `${d.tag}-warm-${i}`);
        }
    }
    if (fs.existsSync(OUT_DIR)) {
        for (const entry of fs.readdirSync(OUT_DIR)) {
            const full = path.join(OUT_DIR, entry);
            if (fs.statSync(full).isDirectory() && !knownTags.has(entry)) {
                try { fs.rmSync(full, { recursive: true, force: true }); } catch (e) {}
            }
        }
    } else {
        ensureDir(OUT_DIR);
    }
    log(`=== Snapshot milestone report ===`);
    log(`Output dir: ${OUT_DIR} (preserving prior index.html until end of run)`);

    const uploads = {};
    for (const d of DOCS) {
        const docPath = path.join(DATA_DIR, d.doc);
        if (!fs.existsSync(docPath)) {
            log(`MISSING ${docPath} — abort`);
            process.exit(2);
        }
        const bytes = fs.readFileSync(docPath);
        uploads[d.doc] = await uploadV2(VIEWER, d.doc, bytes);
        log(`Uploaded ${d.doc}: ${uploads[d.doc].fileId.substring(0,8)}…`);
    }

    const results = {};
    for (const d of DOCS) {
        log('');
        log(`============ ${d.label} ============`);
        const userDataDir = path.join(os.tmpdir(),
            'snapshot-milestones-' + d.tag + '-' + Date.now() + '-' + process.pid);
        fs.mkdirSync(userDataDir, { recursive: true });
        const launchOpts = {
            headless: 'new', protocolTimeout: TIMEOUT_MS + 60000,
            userDataDir,
            args: ['--no-sandbox', '--ignore-certificate-errors',
                   '--enable-features=SharedArrayBuffer'],
        };
        const up = uploads[d.doc];
        const fileUrl = VIEWER + '/?singleuser&planc=1#file=' + up.b64urlSecret;

        // Cold session
        log(`[${d.tag}] cold session ...`);
        let browser = await puppeteer.launch(launchOpts);
        const cold = await captureSession({
            browser, fileUrl, sessionTag: `${d.tag}-cold`, kind: 'cold',
            expectStatus: d.expectStatus, expectAssert: d.expectAssert });
        log(`[${d.tag}] cold done: ${(cold.totalMs/1000).toFixed(2)} s, ` +
            `${Object.keys(cold.hits).length} milestones, ` +
            `verified=${cold.hits.content_verified !== undefined}`);
        // Cold writes the 162-184 MB snapshot blob to Cache Storage
        // (which is IndexedDB-backed). Hypothesis from prior iterations:
        // warm "all-3-trials-fail" lockstep failures correlate with cold
        // sessions where IDB hadn't fully committed the blob when the
        // browser closed. Bumped from 3s + 2s = 5s total to 10s + 5s =
        // 15s total to give IDB time to flush.
        await sleep(10000);
        await browser.close();
        await sleep(5000);

        // Warm session(s) — N trials so flake rate is measurable. The
        // "primary" warm result for the report is the first PASSING run,
        // or the last attempt if all fail. All trials are kept so the
        // overview table can show pass-rate per doc type.
        const warmTrials = [];
        for (let i = 1; i <= WARM_TRIALS; i++) {
            log(`[${d.tag}] warm session ${i}/${WARM_TRIALS} ...`);
            browser = await puppeteer.launch(launchOpts);
            const tag = WARM_TRIALS === 1
                ? `${d.tag}-warm`
                : `${d.tag}-warm-${i}`;
            const w = await captureSession({
                browser, fileUrl, sessionTag: tag, kind: 'warm',
                expectStatus: d.expectStatus, expectAssert: d.expectAssert,
                timeoutMs: WARM_TIMEOUT_MS });
            log(`[${d.tag}] warm ${i} done: ${(w.totalMs/1000).toFixed(2)} s, ` +
                `${Object.keys(w.hits).length} milestones, ` +
                `verified=${w.hits.content_verified !== undefined}`);
            warmTrials.push({ tag, result: w });
            await browser.close();
            await sleep(1000);
        }
        // Pick "primary" — first passing trial, or first overall if none passed.
        const primaryWarm = warmTrials.find(t =>
            t.result.hits.content_verified !== undefined) || warmTrials[0];
        const warm = primaryWarm.result;

        results[d.tag] = { label: d.label, cold, warm,
                           warmTrials, primaryWarmTag: primaryWarm.tag };

        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
    }

    // Emit single-page HTML report.
    let body = '';
    for (const d of DOCS) {
        body += emitSessionHtml(d.tag, 'cold', d.label, results[d.tag].cold);
        // Emit each warm trial as its own section so a flake is visible
        // (one trial passes, two hang, etc.). Section IDs include the
        // trial number; sessionTag in captureSession already wrote
        // screenshots to the matching subdir.
        const trials = results[d.tag].warmTrials;
        for (let i = 0; i < trials.length; i++) {
            const t = trials[i];
            const trialSuffix = trials.length === 1 ? '' : ` (trial ${i+1}/${trials.length})`;
            // Reuse emitSessionHtml but pass the per-trial sessionTag-derived
            // subdir name so screenshot paths resolve correctly.
            body += emitSessionHtml(
                t.tag.replace(`${d.tag}-`, ''),  // 'warm' or 'warm-1' etc
                'warm',  // banner kind label
                d.label + trialSuffix,
                t.result,
                t.tag);  // pass actual subdir
        }
    }

    let summary = `<table class="overview"><thead><tr>
        <th>Doc</th>
        <th>Cold visible at</th>
        <th>Warm pass-rate</th>
        <th>Warm visible (per trial)</th></tr></thead><tbody>`;
    for (const d of DOCS) {
        const r = results[d.tag];
        const coldVer = r.cold.hits.content_verified !== undefined;
        const coldCell = `<td class="${coldVer ? 'ok' : 'fail'}">${
            coldVer ? '✓ +' + (r.cold.hits.content_verified/1000).toFixed(2) + 's' : '✗'}</td>`;
        const passes = r.warmTrials.filter(t =>
            t.result.hits.content_verified !== undefined).length;
        const total = r.warmTrials.length;
        const rateClass = passes === total ? 'ok'
                       : passes === 0 ? 'fail' : 'warn';
        const rateCell = `<td class="${rateClass}">${passes}/${total}</td>`;
        const trialsCell = '<td>' + r.warmTrials.map(t => {
            const v = t.result.hits.content_verified;
            return v !== undefined
                ? `<span class="ok">${(v/1000).toFixed(2)}s</span>`
                : `<span class="fail">✗</span>`;
        }).join(' · ') + '</td>';
        summary += `<tr>
            <td>${d.label}</td>
            ${coldCell}
            ${rateCell}
            ${trialsCell}
        </tr>`;
    }
    summary += `</tbody></table>`;

    const html = `<!doctype html>
<html><head><meta charset="utf-8" />
<title>Snapshot milestone report</title>
<style>
  body { font-family: -apple-system,Segoe UI,Roboto,sans-serif; max-width: 1100px;
         margin: 2rem auto; padding: 0 1rem; color: #222; }
  h1 { border-bottom: 2px solid #333; padding-bottom: .3em; }
  h2 { margin-top: 2.5rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left;
           vertical-align: middle; font-size: 14px; }
  th { background: #f4f4f4; }
  table.overview td:nth-child(n+2) { font-variant-numeric: tabular-nums; text-align: right; }
  table.milestones td:nth-child(2), table.milestones td:nth-child(3)
    { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
  img.shot { max-width: 220px; max-height: 130px; border: 1px solid #ccc;
             cursor: zoom-in; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  img.shot:hover { box-shadow: 0 2px 6px rgba(0,0,0,.2); }
  .missed td { color: #aaa; }
  tr.terminal td { background: #e7f6e7; font-weight: 600; }
  .summary { color: #555; }
  .terminal-tag { background: #e7f6e7; padding: 0 .3em; }
  .raw { font-size: 12px; color: #777; margin-top: .3em; }
  a:link, a:visited { color: #0366d6; }
  .ok   { color: #22863a; font-weight: 600; }
  .warn { color: #b08800; font-weight: 600; }
  .fail { color: #cb2431; font-weight: 600; }
</style>
</head><body>
<h1>Snapshot milestone report</h1>
<p>Generated ${new Date().toISOString()}. Each doc type ran in single-user
mode (<code>?singleuser&amp;planc=1</code>). Cold session creates the
Cache-Storage snapshot; warm session immediately reuses it.</p>
<p>Each session is verified by polling the iframe DOM for a
&lt;canvas&gt; AND a doc-type-specific status string
(<code>\\d+ words</code> for writer, <code>Sheet N of M</code> for calc,
<code>Slide N of M</code> for impress). The
<span class="terminal-tag">highlighted row</span> in each session table
is when that verification fired; its screenshot is proof the document
actually rendered.</p>

<h2>Overview</h2>
${summary}
${body}

</body></html>`;

    fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html);
    log(`Report written: ${OUT_DIR}/index.html`);
    log(`URL: https://viewer.szebeni.hu/report/snapshot-milestones/`);

    // Pass-rate summary line so iterate.sh tail catches it.
    const passRates = Object.entries(results).map(([tag, r]) => {
        const passes = r.warmTrials.filter(t =>
            t.result.hits.content_verified !== undefined).length;
        return `${tag}=${passes}/${r.warmTrials.length}`;
    });
    log(`Warm pass-rate: ${passRates.join(' ')}`);

    // Compute best warm wall time per doc type. The "best" (fastest
    // verified trial) is the meaningful metric — single-trial flakes
    // shouldn't fail the run, but persistent slow warm should.
    const warmBudgets = Object.entries(results).map(([tag, r]) => {
        const verifiedTimes = r.warmTrials
            .map(t => t.result.hits.content_verified)
            .filter(v => v !== undefined);
        const best = verifiedTimes.length ? Math.min(...verifiedTimes) : null;
        const ok = best !== null && best <= WARM_BUDGET_MS;
        return { tag, best, ok, all: verifiedTimes };
    });
    log(`Warm budget (≤ ${(WARM_BUDGET_MS/1000).toFixed(0)} s):`);
    for (const w of warmBudgets) {
        const bestStr = w.best !== null ? (w.best/1000).toFixed(2) + 's' : '— (no verified trial)';
        const allStr = w.all.length ? '[' + w.all.map(v => (v/1000).toFixed(2)+'s').join(', ') + ']' : '[]';
        log(`  ${w.tag}: best=${bestStr} ${w.ok ? 'PASS' : 'FAIL'} ${allStr}`);
    }
    const allWarmInBudget = warmBudgets.every(w => w.ok);
    if (!allWarmInBudget) {
        log('');
        log('!!! WARM IS SLOW. Likely causes:');
        log('  1. Concurrent puppeteer Chromes on the same host (parallel');
        log('     runner with JOBS≥2, OR the GitHub actions-runner running');
        log('     tests against Azure simultaneously). Check `pgrep -af chrome`.');
        log('  2. /tmp full — Cache Storage flushes stall. Check `df /tmp`.');
        log('  3. A real LO Core / Online warm-restore regression.');
        log('  Override the budget for one-off investigation:');
        log(`     WARM_BUDGET_MS=30000 node wasm/test-snapshot-milestones.js`);
    }

    // Exit 0 only if EVERY doc type had ≥1 cold pass AND ≥1 verified
    // warm trial AND the best verified warm trial is within budget.
    const allOk = Object.values(results).every(r =>
        r.cold.hits.content_verified !== undefined &&
        r.warmTrials.some(t => t.result.hits.content_verified !== undefined))
        && allWarmInBudget;
    process.exit(allOk ? 0 : 1);
})().catch(e => {
    log('FATAL: ' + (e.stack || e.message || e));
    process.exit(2);
});
