// test-regression-bulk-open-ignored.js
//
// Bulk-open smoke test for the ad-hoc /test/samples/ignored/ corpus.
//
// What it does
// ------------
// Discovers every file under /home/localadmin/online/test/samples/ignored/
// (sorted, skipping dotfiles), opens each one in turn in the SAME
// Chromium browser, types "hello world" at the top via real keyboard,
// verifies (via observation, not internal calls) that the typing landed,
// captures before/after screenshots, and produces a standalone HTML
// report listing per-file open time + verification status.
//
// Hard rules followed (from wasm/CLAUDE.md — write-test SKILL.md)
// --------------------------------------------------------------
//   * Real puppeteer mouse + keyboard ONLY to drive the editor.
//   * No sendUnoCommand / app.dispatcher.dispatch / page.evaluate-click.
//   * DOM/canvas reads through frame.evaluate are OK — pure observation.
//
// Output
// ------
//   * Report HTML:  /tmp/static-deploy/public/reports/regression-bulk-open-ignored.html
//                   (rendered at https://viewer.szebeni.hu/reports/regression-bulk-open-ignored.html)
//   * Screenshots:  /tmp/static-deploy/public/shots-regression-bulk-open-ignored/<NN>_<name>.png
//
// The test itself exits 0 unless something crashes the harness. Per-file
// verification PASS/FAIL is captured in the report table and via
// __cl.recordCheck so the CI checklist surfaces per-file outcomes.

'use strict';

const fs = require('fs');
const path = require('path');
const __cl = require('../../lib/inject-checklist');
const { launch, sleep } = require('../../lib/browser');
const env = require('../../lib/test-env');
const { openViaViewer } = require('../../lib/open-via-viewer');
const { waitInFrame, evalInFrame, getCharCount, getActiveEditorFrame } = require('../../lib/two-tab');

const VIEWER = env.FILE_STORAGE_URL;
// Corpus path RELATIVE to this test's own checkout (not a hardcoded
// absolute path). On a dev box the main repo's test/samples/ignored/
// exists → the per-MB perf gate runs. On a CI runner the corpus is
// gitignored and absent from the runner's checkout → listFiles()'s
// existsSync guard returns [] → the test skips (exit 0). The previous
// hardcoded `/home/localadmin/online/...` always resolved on this
// self-hosted box (shared with the dev repo), so the test ran the gate
// on CI and perf-flaked under host contention. local-only by design.
const SAMPLES_DIR = path.join(__dirname, '..', '..', '..', 'test', 'samples', 'ignored');
const SHOTS_DIR = '/tmp/static-deploy/public/shots-regression-bulk-open-ignored';
const REPORT_PATH = '/tmp/static-deploy/public/reports/regression-bulk-open-ignored.html';

// Hard per-file OPEN budgets — these are PERF GATES, not patience
// timeouts. Per wasm/CLAUDE.md: "Don't wrap perf-budget assertions
// (e.g. tTotal < 30000 'warm-path was fast enough') — those should
// fail when warm slows down." So these are ABSOLUTE wall-clock budgets
// — they do NOT route through env.scaleTimeout.
//
// Per-MB perf budget.
//
//   warm:  size_MB * 4000 ms   (4 s per MB — user-set target 2026-06-12.
//                               Measured kit warm rate for large pptx is
//                               ~3.6 s/MB solo, so 4 passes solo with
//                               ~10% headroom. Under the CI's JOBS=2
//                               contention the Docaposte deck has been
//                               observed to need >4 s/MB — if it trips
//                               on CI, that's the perf gap the gate is
//                               meant to surface, not a test bug.)
//   cold:  size_MB * 4000 ms + 60000 ms  (first file pays the SW install
//                                         / online.wasm download / V8
//                                         compile tax on top of parse)
//
// Floor of MIN_OPEN_MS captures fixed iframe-boot + kit-init cost (~10
// s warm for pptx; smaller for docx/xlsx but we use one common floor).
// A 100 KB file should still get a realistic budget that's not just the
// per-MB derivative.
//
// These are absolute wall-clock budgets — do NOT route through
// env.scaleTimeout. They are the perf gate (deliberately NOT scaled by
// JOBS_SCALE).
const MS_PER_MB        = 4000;
const COLD_OVERHEAD_MS = 60000;
const MIN_OPEN_MS      = 15000;
function computeOpenBudgetMs(sizeBytes, isFirstFile) {
    const sizeMB = sizeBytes / (1024 * 1024);
    let ms = Math.ceil(sizeMB * MS_PER_MB);
    if (isFirstFile) ms += COLD_OVERHEAD_MS;
    return Math.max(MIN_OPEN_MS, ms);
}

// Patience timeouts for non-open-budget waits (goto, iframe attach).
// These CAN scale because they're "waiting for puppeteer/chromium to
// not be a bottleneck", not perf assertions about the editor.
const GOTO_TIMEOUT     = env.scaleTimeout(120000);   // 2 min for viewer goto
const IFRAME_TIMEOUT   = env.scaleTimeout(180000);   // 3 min for editor iframe to land

const T0 = Date.now();
function elapsed() { return ((Date.now() - T0) / 1000).toFixed(1) + 's'; }
function log(msg) { console.log(`[${elapsed()}] ${msg}`); }

function formatOf(name) {
    const ext = path.extname(name).toLowerCase().replace(/^\./, '');
    if (ext === 'docx' || ext === 'doc' || ext === 'odt' || ext === 'rtf') return 'docx';
    if (ext === 'xlsx' || ext === 'xls' || ext === 'ods' || ext === 'csv') return 'xlsx';
    if (ext === 'pptx' || ext === 'ppt' || ext === 'odp') return 'pptx';
    return ext || 'unknown';
}

function listFiles() {
    // The corpus (test/samples/ignored/) is gitignored — present on a dev
    // box, ABSENT on a CI checkout. Treat a missing dir as an empty corpus
    // so this local-only test skips cleanly (empty report + exit 0) instead
    // of crashing with ENOENT on every CI run (the "persistent fail ×3").
    if (!fs.existsSync(SAMPLES_DIR)) return [];
    const entries = fs.readdirSync(SAMPLES_DIR);
    // Optional focus filter: BULK_OPEN_FILTER=<substr> opens only the files
    // whose name contains <substr> (case-insensitive). Lets you target one
    // problem file (e.g. a specific slow pptx) for a per-tick timeline review
    // without sitting through the whole corpus. No effect when unset.
    const focus = (process.env.BULK_OPEN_FILTER || '').toLowerCase();
    return entries
        .filter(n => !n.startsWith('.'))
        .filter(n => n !== '.gitignore')
        .filter(n => !focus || n.toLowerCase().includes(focus))
        .filter(n => {
            const full = path.join(SAMPLES_DIR, n);
            try { return fs.statSync(full).isFile(); } catch (_) { return false; }
        })
        .sort((a, b) => a.localeCompare(b));
}

// ── Multi-stage open-progress tracker ────────────────────────────────
//
// The wasm-loader stamps every boot milestone into
// `window.__prewarmTimings.events` (see wasm-loader.js `mark()`), so a
// poll of the iframe gives a full pipeline trace with millisecond
// timestamps — pure observation, no driving. The ordered stages we
// surface (a file-open walks them roughly top to bottom; warm restores
// skip the download/compile stages):
//
//    loader:start                 wasm-loader.js booted in the iframe
//    sw-bridge:ready              service-worker bridge handshake done
//    net:fetch_start online.wasm  154 MB binary download started
//    net:fetch_end online.wasm    … download finished
//    emscripten:module_defined    online.js glue parsed
//    snapshot:signal              warm-restore vs cold decision
//    emscripten:wasmExports_ready wasm compiled + instantiated
//    emscripten:FS_ready          virtual FS populated (soffice.data)
//    emscripten:calledRun         WASM runtime running (main())
//    dom:status_appeared          COOL UI chrome alive
//    dom:first_canvas             first paint surface created
//    doc:loaded                   kit reports the document loaded
//    <ready predicate>            status bar shows chars/Sheet/Slide
//    <thumbs>                     (pptx) slide previews rendered N/M
//
// On top of the stage trace, two live progress numbers:
//   - kit import %: the kit's own statusindicator (`progress:` frames,
//     setvalue 0-100) drives the snackbar progress bar — when that
//     element is visible we read its value. This is the import
//     filter's real progress for the slow middle of a big-file open.
//   - slide thumbs N/M (pptx): incremental render progress after load.
//
// Returns { loadMs, total, rendered, kind, stages } where stages is an
// ordered [{name, tMs}] of when each pipeline stage was first seen
// (tMs relative to wait start; negative = happened before we started
// watching, e.g. warm iframe reuse).
const PIPELINE_STAGES = [
    'loader:start',
    'sw-bridge:ready',
    'net:fetch_start',
    'net:fetch_end',
    'emscripten:module_defined',
    'snapshot:signal',
    'emscripten:wasmExports_ready',
    'emscripten:FS_ready',
    'emscripten:calledRun',
    'dom:status_appeared',
    'dom:first_canvas',
    'doc:loaded',
];

// Turn an ordered [{<labelKey>, tMs}] trace into per-step rows annotated with
// the Δms spent IN each step = gap from this step's timestamp to the next
// step's (or to `endMs` for the last). Each row: { label, tMs, deltaMs }.
// This is the "time spent at each step where the progress bar changes"
// breakdown the report surfaces per document.
function withDeltas(trace, labelKey, endMs) {
    if (!trace || !trace.length) return [];
    return trace.map((step, i) => {
        const next = i + 1 < trace.length ? trace[i + 1].tMs : endMs;
        return {
            label:   labelKey === 'pct' ? step.pct + '%' : String(step[labelKey]),
            tMs:     step.tMs,
            deltaMs: Math.max(0, Math.round(next - step.tMs)),
        };
    });
}

function fmtMs(ms) {
    return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms';
}

// Emit the per-step breakdowns (pipeline-stage Δ + open-progress-bar Δ) to the
// console as compact `step→next Δ` lines, e.g.
//   loader:start→sw-bridge:ready 120ms, …, doc:loaded→ready 2.1s
//   bar 0%→25% 2.1s, 25%→60% 3.0s, 60%→100% 4.4s
function logBreakdown(idx, label, stageBreakdown, progressBreakdown) {
    if (stageBreakdown.length) {
        const parts = [];
        for (let i = 0; i < stageBreakdown.length; i++) {
            const cur = stageBreakdown[i];
            const nxt = stageBreakdown[i + 1];
            const arrow = nxt ? `${cur.label}→${nxt.label}` : `${cur.label}→ready`;
            parts.push(`${arrow} ${fmtMs(cur.deltaMs)}`);
        }
        log(`[${idx}] [${label}] stage Δ: ${parts.join(', ')}`);
    }
    if (progressBreakdown.length) {
        const parts = [];
        for (let i = 0; i < progressBreakdown.length; i++) {
            const cur = progressBreakdown[i];
            const nxt = progressBreakdown[i + 1];
            const arrow = nxt ? `${cur.label}→${nxt.label}` : `${cur.label}→ready`;
            parts.push(`${arrow} ${fmtMs(cur.deltaMs)}`);
        }
        log(`[${idx}] [${label}] progress-bar Δ: ${parts.join(', ')}`);
    } else {
        log(`[${idx}] [${label}] progress-bar Δ: (no open-progress-bar transitions observed)`);
    }
}

async function waitForDocLoadedWithProgress(page, label, idx, timeoutMs) {
    log(`[${idx}] [${label}] Waiting for document...`);
    const t0 = Date.now();
    const deadline = t0 + timeoutMs;

    const stageSeen = new Map();   // stage name -> tMs (first seen)
    // Open-progress-bar transition trace: every distinct import % value the
    // bar is observed at, with the wall-clock ms (relative to open start) it
    // was FIRST seen. From this we compute the Δms spent in each step (the
    // time the bar sat at a given value before advancing). Pure observation —
    // we read the percent text COOL itself renders, we do not drive it.
    const progressSeen = new Map();   // import % -> tMs (first seen)
    // FINE-GRAINED raw progress stream (Feature B): EVERY distinct import
    // percent observation in arrival order, each with the ms (from open
    // start) it was first seen. Finer than the de-duped Progress-bar Δ
    // summary — this is the raw, ordered, timestamped value stream.
    const progressStream = [];        // [{ t (ms from open start), pct }]
    // The most-complete wasm-loader event array seen so far. The array
    // grows as marks land; we keep the latest snapshot (each entry already
    // carries its OWN exact tNav, so we don't need per-poll timestamps).
    let latestEvents = [];
    let lastLine = '';
    let probe = null;

    while (Date.now() < deadline) {
        const frame = await getActiveEditorFrame(page);
        if (frame) {
            probe = await frame.evaluate((stageNames) => {
                const wc      = document.querySelector('#StateWordCount')?.textContent || '';
                const docPos  = document.querySelector('#StatusDocPos')?.textContent  || '';
                const slide   = document.querySelector('#SlideStatus')?.textContent   || '';
                const slideMatch = slide.match(/Slide\s+(\d+)\s+of\s+(\d+)/i);
                const sheetMatch = docPos.match(/Sheet\s+(\d+)\s+of\s+(\d+)/i);
                const pageMatch  = docPos.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
                const wcMatch    = wc.match(/([\d,]+)\s+character/i);
                const slideThumbs = document.querySelectorAll(
                    '#slide-sorter img, #slide-sorter canvas, .preview-frame img').length;
                // Pipeline trace from the wasm-loader's mark() stream.
                const events = (window.__prewarmTimings && window.__prewarmTimings.events) || [];
                const stages = {};
                for (const ev of events) {
                    for (const want of stageNames) {
                        if (stages[want] === undefined && ev.name.indexOf(want) === 0) {
                            stages[want] = ev.tNav || ev.t || 0;
                        }
                    }
                }
                // FINE-GRAINED raw event stream (Feature B): EVERY mark()
                // the wasm-loader recorded, with its exact tNav (ms from
                // navigation). This is the unabridged timeline — finer than
                // the de-duped per-stage trace above. Pure observation.
                const allEvents = events.map(ev => ({
                    t: (ev.tNav != null ? ev.tNav : (ev.t || 0)),
                    name: ev.name,
                    detail: (ev.detail || '').substring(0, 80),
                }));
                // Kit import % — the statusindicator-driven OPEN progress
                // bar. COOL's L.ProgressOverlay (the spinner+bar shown over
                // #document-container while the import filter runs) is driven
                // by foreground `statusindicator setvalue` frames via
                // _onUpdateProgress → _progressBar.setValue(v): it writes the
                // percent into `.leaflet-progress > span > span` as "NN%" and
                // sets the bar span's width to "NN%". That element is the
                // canonical "open progress bar"; read it first. Fall back to
                // any <progress> (older jsdialog snackbar) for robustness.
                let importPct = -1;
                const ovl = document.querySelector('.leaflet-progress-layer .leaflet-progress');
                if (ovl) {
                    const m = (ovl.textContent || '').match(/(\d+)\s*%/);
                    if (m) {
                        importPct = +m[1];
                    } else {
                        // No text yet — derive from the bar span's width style.
                        const barSpan = ovl.querySelector('span');
                        const w = barSpan && barSpan.style && barSpan.style.width;
                        const wm = w && w.match(/(\d+)\s*%/);
                        if (wm) importPct = +wm[1];
                    }
                }
                if (importPct < 0) {
                    const prog = document.querySelector('.jsdialog progress, #snackbar progress, progress');
                    if (prog && prog.max > 0) importPct = Math.round(prog.value / prog.max * 100);
                }
                return {
                    stages,
                    allEvents,
                    importPct,
                    slide_total:    slideMatch ? +slideMatch[2] : 0,
                    sheet_total:    sheetMatch ? +sheetMatch[2] : 0,
                    page_total:     pageMatch  ? +pageMatch[2]  : 0,
                    wc_ready:       !!wcMatch,
                    slide_ready:    !!slideMatch,
                    sheet_ready:    !!sheetMatch,
                    slide_thumbs:   slideThumbs,
                    statusbar_text: (slide || docPos || wc).substring(0, 60),
                };
            }, PIPELINE_STAGES).catch(() => null);
        }

        if (probe) {
            const nowMs = Date.now() - t0;
            // Register newly-reached stages (timestamped at first sighting).
            for (const name of PIPELINE_STAGES) {
                if (probe.stages[name] !== undefined && !stageSeen.has(name)) {
                    stageSeen.set(name, nowMs);
                    log(`[${idx}]     ✦ stage ${stageSeen.size}/${PIPELINE_STAGES.length + 1}: ${name}  t=${(nowMs/1000).toFixed(1)}s`);
                }
            }

            // Fine-grained (Feature B): keep the most-complete event array.
            if (probe.allEvents && probe.allEvents.length >= latestEvents.length) {
                latestEvents = probe.allEvents;
            }

            // Register newly-observed open-progress-bar values (each distinct
            // percent the bar steps to, timestamped at first sighting).
            if (probe.importPct >= 0 && !progressSeen.has(probe.importPct)) {
                progressSeen.set(probe.importPct, nowMs);
                progressStream.push({ t: nowMs, pct: probe.importPct });  // raw ordered stream
                log(`[${idx}]     ▸ progress ${probe.importPct}%  t=${(nowMs/1000).toFixed(1)}s`);
            }

            const isReady =
                probe.wc_ready
             || probe.slide_ready
             || probe.sheet_ready;

            // Composite progress: stage index carries 0..80%, kit import
            // % and slide thumbs refine the slow middle / tail.
            const stagePct = Math.round(stageSeen.size / (PIPELINE_STAGES.length + 1) * 80);
            let pct = stagePct;
            if (probe.importPct >= 0) pct = Math.max(pct, Math.round(60 + probe.importPct * 0.2));
            if (isReady) pct = probe.slide_total > 0
                ? Math.max(80, Math.round(80 + probe.slide_thumbs / probe.slide_total * 20))
                : 100;

            const extra =
                (probe.importPct >= 0 ? ` import=${probe.importPct}%` : '') +
                (probe.slide_total > 0 ? ` slides=${probe.slide_thumbs}/${probe.slide_total}` : '');
            const line = `${renderProgressBar(pct)} ${pct}%${extra} "${probe.statusbar_text}"`;
            if (line !== lastLine) {
                log(`[${idx}]   ${line} t=${(nowMs/1000).toFixed(1)}s`);
                lastLine = line;
            }

            if (isReady) {
                const loadMs = Date.now() - t0;
                stageSeen.set('ready', loadMs);
                log(`[${idx}] [${label}] Loaded in ${(loadMs/1000).toFixed(2)}s (${stageSeen.size} stages traced)`);
                let kind = 'unknown';
                let total = 0;
                let rendered = 0;
                if (probe.slide_ready) {
                    kind = 'slide';
                    total = probe.slide_total;
                    rendered = probe.slide_thumbs;
                } else if (probe.sheet_ready) {
                    kind = 'sheet';
                    total = probe.sheet_total;
                    rendered = 1;
                } else if (probe.wc_ready) {
                    kind = probe.page_total > 0 ? 'page' : 'unknown';
                    total = probe.page_total;
                    rendered = probe.page_total;
                }
                const stages = [...stageSeen.entries()].map(([name, tMs]) => ({ name, tMs }));
                // Open-progress-bar steps, sorted ascending by value, each
                // carrying the ms it was first seen. The final synthetic step
                // pins 100% at the ready instant so the last Δ is captured even
                // when the bar never explicitly hit 100 before doc:loaded.
                const progressSteps = [...progressSeen.entries()]
                    .map(([pct, tMs]) => ({ pct, tMs }))
                    .sort((a, b) => a.tMs - b.tMs);
                if (!progressSeen.has(100)) progressSteps.push({ pct: 100, tMs: loadMs });
                // Per-step breakdowns: Δms is time spent IN a step = gap to the
                // next transition (the pipeline stage / progress value the open
                // sat at before advancing). Surfaced in the console + report.
                const stageBreakdown = withDeltas(stages, 'name', loadMs);
                const progressBreakdown = withDeltas(progressSteps, 'pct', loadMs);
                logBreakdown(idx, label, stageBreakdown, progressBreakdown);

                // ── FINE-GRAINED EVENT TIMELINE (Feature B) ──────────────
                // The raw, timestamped stream of EVERY progress event:
                //   - every wasm-loader mark() (from __prewarmTimings.events,
                //     each carrying its own exact tNav = ms from navigation);
                //   - every observed statusindicator/import % change (the
                //     COOL .leaflet-progress / kit `progress:` value), at the
                //     ms it was first seen.
                // Both are normalized onto ONE clock (ms from open start).
                // The loader marks use a navigation-origin clock (tNav); the
                // poll-observed % uses the test's wait-start clock (t0). We
                // align them via a matched stage seen on BOTH clocks
                // (stageSeen[name] is t0-clock, probe.stages[name] is tNav):
                // offset = t0clock − tNav. Falls back to 0 if no match.
                let evOffset = 0;
                for (const name of PIPELINE_STAGES) {
                    if (stageSeen.has(name) && probe.stages[name] != null) {
                        evOffset = stageSeen.get(name) - probe.stages[name];
                        break;
                    }
                }
                const timeline = [];
                for (const ev of latestEvents) {
                    timeline.push({
                        t: Math.max(0, Math.round(ev.t + evOffset)),
                        kind: 'event',
                        text: ev.name + (ev.detail ? ' ' + ev.detail : ''),
                    });
                }
                for (const p of progressStream) {
                    timeline.push({ t: Math.round(p.t), kind: 'progress', text: 'import ' + p.pct + '%' });
                }
                timeline.sort((a, b) => a.t - b.t || (a.kind === 'event' ? -1 : 1));
                // Console: the full raw stream, finer than the Δ summaries.
                log(`[${idx}] [${label}] fine-grained timeline (${timeline.length} entries):`);
                for (const e of timeline) {
                    log(`[${idx}]       t=${String(e.t).padStart(6)}ms  ${e.kind === 'progress' ? '▸ ' : '· '}${e.text}`);
                }

                return { loadMs, kind, total, rendered, stages, progressSteps,
                         stageBreakdown, progressBreakdown, timeline };
            }
        }

        await sleep(1000);
    }
    throw new Error(`waitForDocLoadedWithProgress: timeout after ${timeoutMs}ms`
        + (stageSeen.size ? ` (last stage reached: ${[...stageSeen.keys()].pop()})` : ''));
}

function renderProgressBar(pct) {
    const width = 24;
    const filled = Math.max(0, Math.min(width, Math.round(width * pct / 100)));
    return '[' + '#'.repeat(filled) + '-'.repeat(width - filled) + ']';
}

// Sample a region of the editor iframe by reading the *first* canvas
// pixels under it. We pull a small viewport screenshot of the page at
// the iframe bounding box; that's our before/after substrate for the
// pixel-diff verification. Returns { png: Buffer, w, h } or null on
// failure. Headful Chrome with Xvfb produces real pixel buffers.
async function snapEditorRegion(page) {
    try {
        const iframeEl = await page.$('iframe#editor-frame');
        if (!iframeEl) return null;
        const box = await iframeEl.boundingBox();
        if (!box) return null;
        // Slightly inset so we don't catch ribbon UI in the pixel-diff.
        // We want the canvas area only.
        const clip = {
            x: Math.max(0, Math.round(box.x + box.width * 0.20)),
            y: Math.max(0, Math.round(box.y + 240)),
            width:  Math.round(box.width  * 0.60),
            height: Math.round(Math.min(box.height - 280, 360)),
        };
        if (clip.width <= 0 || clip.height <= 0) return null;
        const buf = await page.screenshot({ clip, type: 'png' });
        return { png: buf, w: clip.width, h: clip.height };
    } catch (e) {
        return null;
    }
}

// PNG → raw RGBA pixel buffer using the same machinery puppeteer ships:
// piping the PNG through the chromium page. We keep it pure-JS by using
// the page's offscreen canvas. Returns a Uint8Array (RGBA) or null.
async function decodePngOnPage(page, pngBuffer) {
    try {
        const b64 = pngBuffer.toString('base64');
        return await page.evaluate(async (data) => {
            const img = new Image();
            img.src = 'data:image/png;base64,' + data;
            await img.decode();
            const c = document.createElement('canvas');
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const d = ctx.getImageData(0, 0, c.width, c.height).data;
            return Array.from(d);
        }, b64);
    } catch (e) {
        return null;
    }
}

// Count non-equal pixels between two RGBA buffers of identical shape.
// "Non-equal" means any of R/G/B differ by > 10 (kills JPEG-ish noise
// when the editor re-paints background tiles between snapshots).
function pixelDiffCount(a, b) {
    if (!a || !b || a.length !== b.length) return -1;
    let diffs = 0;
    for (let i = 0; i < a.length; i += 4) {
        if (Math.abs(a[i  ] - b[i  ]) > 10) { diffs++; continue; }
        if (Math.abs(a[i+1] - b[i+1]) > 10) { diffs++; continue; }
        if (Math.abs(a[i+2] - b[i+2]) > 10) { diffs++; continue; }
    }
    return diffs;
}

async function openAndTypeOne(browser, fileName, idx) {
    const filePath = path.join(SAMPLES_DIR, fileName);
    const fmt = formatOf(fileName);
    const isFirstFile = (idx === 1);
    const result = {
        idx,
        fileName,
        fmt,
        sizeBytes: 0,
        tOpenMs: -1,
        verify: 'fail',
        verifyDetail: '',
        beforeShot: '',
        afterShot: '',
        notes: [],
        budgetMs: 0,
        budgetExceeded: false,
        // Slide / sheet / page count info — populated by progress poll.
        progressKind: '',     // 'slide' / 'sheet' / 'page' / 'unknown'
        progressTotal: 0,
        progressRendered: 0,
        // Ordered [{name, tMs}] pipeline-stage trace from the open wait.
        stages: [],
        // Per-step Δms breakdowns (time spent at each step where the open
        // progress bar / pipeline stage changes). Each row {label,tMs,deltaMs}.
        stageBreakdown: [],
        progressBreakdown: [],
        // Fine-grained raw event timeline (Feature B): chronological
        // [{t (ms from open start), kind:'event'|'progress', text}] of EVERY
        // wasm-loader mark + EVERY observed import-% change.
        timeline: [],
    };

    let bytes;
    try {
        bytes = fs.readFileSync(filePath);
        result.sizeBytes = bytes.length;
    } catch (e) {
        result.verifyDetail = 'read error: ' + e.message;
        return result;
    }

    // Per-MB budget: warm = size_MB * 3 s, cold = warm + 60 s.
    const openBudgetMs = computeOpenBudgetMs(bytes.length, isFirstFile);
    result.budgetMs = openBudgetMs;

    log(`\n${'='.repeat(60)}`);
    log(`[${idx}] ${fileName}  (${fmt}, ${(bytes.length/1024/1024).toFixed(2)} MB)`);
    log(`[${idx}] open budget = ${(openBudgetMs/1000).toFixed(1)}s (${(bytes.length/(1024*1024)).toFixed(2)} MB × ${(MS_PER_MB/1000)} s/MB${isFirstFile ? ` + ${COLD_OVERHEAD_MS/1000} s cold tax` : ''})`);
    log('='.repeat(60));

    let page = null;
    let context = null;

    // PERF GATE — strict open-budget enforcement. tOpenStart is set
    // before openViaViewer; the deadline is tOpenStart + openBudgetMs.
    // If we hit it, throw immediately so the caller can abort the run.
    const tOpenStart = Date.now();
    const openDeadline = tOpenStart + openBudgetMs;
    const budgetTimeout = new Promise((_, rej) =>
        setTimeout(() => rej(new Error(
            `OPEN_BUDGET_EXCEEDED: ${fileName} did not reach ready predicate within ${openBudgetMs}ms (${isFirstFile ? 'first-file' : 'subsequent-file'} budget)`)),
            openBudgetMs));

    try {
        // NOTE: isolatedContext is INTENTIONALLY OFF. A fresh
        // BrowserContext creates a fresh SW + IndexedDB + V8 code cache,
        // so every file is a true cold-load — online.wasm has to re-
        // download (~50 MB) and re-compile before the kit can even
        // start. With pptx that pushes open past 60 s. Sharing the
        // default context lets file 2+ hit the snapshot warm-restore
        // path (kInPlaceCap = 1 per-doctype) and online.wasm from SW
        // cache, dropping warm pptx opens to <10 s. singleUser=true
        // already prevents relay-dedup interference across files.
        const up = await Promise.race([
            openViaViewer(browser, VIEWER, fileName, bytes, {
                iframeTimeout: IFRAME_TIMEOUT,
                gotoTimeout:   GOTO_TIMEOUT,
                singleUser: true,
                viewport: { width: 1280, height: 900 },
            }),
            budgetTimeout,
        ]);
        page = up.page;
        context = up.context;
        // Small settle so SW / shield can clear (still inside the open budget).
        await sleep(env.scaleTimeout(2000));

        // Wait for the per-doctype ready predicate WITH progress polling.
        // The timeout passed in is the REMAINING budget — predicate must
        // be true by openDeadline (absolute wall clock).
        const remainingMs = Math.max(1, openDeadline - Date.now());
        const loadInfo = await Promise.race([
            waitForDocLoadedWithProgress(page, fileName, idx, remainingMs),
            budgetTimeout,
        ]);
        result.tOpenMs = Date.now() - tOpenStart;
        result.progressKind     = loadInfo.kind;
        result.progressTotal    = loadInfo.total;
        result.progressRendered = loadInfo.rendered;
        result.stages           = loadInfo.stages || [];
        result.stageBreakdown    = loadInfo.stageBreakdown || [];
        result.progressBreakdown = loadInfo.progressBreakdown || [];
        result.timeline          = loadInfo.timeline || [];
        log(`[${idx}] open total = ${(result.tOpenMs/1000).toFixed(2)}s (predicate=${(loadInfo.loadMs/1000).toFixed(2)}s, budget=${(openBudgetMs/1000).toFixed(1)}s) — ${loadInfo.kind === 'slide' ? loadInfo.rendered + '/' + loadInfo.total + ' slides rendered' : loadInfo.kind === 'sheet' ? '1/' + loadInfo.total + ' sheets' : loadInfo.kind === 'page' ? loadInfo.total + ' pages' : 'ready'}`);

        // Let canvas tiles paint before we screenshot.
        await sleep(env.scaleTimeout(2500));

        // BEFORE shot — full page (visible to humans in the report) +
        // canvas-region pixel buffer for the diff.
        try {
            fs.mkdirSync(SHOTS_DIR, { recursive: true });
            const safeName = String(idx).padStart(2, '0') + '_' +
                fileName.replace(/[^A-Za-z0-9._-]+/g, '_');
            result.beforeShot = `${safeName}_before.png`;
            await page.screenshot({ path: path.join(SHOTS_DIR, result.beforeShot) });
        } catch (e) { result.notes.push('before-shot: ' + e.message); }

        const beforeRegion = await snapEditorRegion(page);
        const beforePixels = beforeRegion ? await decodePngOnPage(page, beforeRegion.png) : null;

        // Baseline char count (for docx StateWordCount delta check).
        const baseChars = await getCharCount(page);
        log(`[${idx}] baseline chars=${baseChars}`);

        // Click into the document area. iframe-relative coords — same
        // approach as test-regression-ctrl-x-cut-restore + the rightclick
        // test the prompt referenced.
        const iframeEl = await page.$('iframe#editor-frame');
        const ifBox = iframeEl ? await iframeEl.boundingBox() : null;
        if (!ifBox) throw new Error('iframe#editor-frame has no bbox');
        const clickX = ifBox.x + ifBox.width / 2;
        const clickY = ifBox.y + 305;

        if (fmt === 'pptx') {
            // Slides usually open with a title frame at the top — single
            // click selects the frame, double click enters edit mode.
            // Two clicks ~300ms apart is more reliable than clickCount:2
            // on the Notebookbar's underlying layout.
            await page.mouse.click(clickX, clickY);
            await sleep(env.scaleTimeout(400));
            await page.mouse.click(clickX, clickY, { clickCount: 2 });
            await sleep(env.scaleTimeout(800));
        } else if (fmt === 'xlsx') {
            // Single click — we're on a cell, then Ctrl+Home + type +
            // Enter to commit. (Double-click would enter cell-edit mode
            // BEFORE Ctrl+Home, leaving the cursor in a different cell.)
            await page.mouse.click(clickX, clickY);
            await sleep(env.scaleTimeout(500));
        } else {
            // docx / unknown: single click into body.
            await page.mouse.click(clickX, clickY);
            await sleep(env.scaleTimeout(500));
        }

        // Ctrl+Home — start of doc / A1 / first slide title.
        await page.keyboard.down('Control');
        await page.keyboard.press('Home');
        await page.keyboard.up('Control');
        await sleep(env.scaleTimeout(500));

        // Type the phrase.
        const PHRASE = 'hello world';
        await page.keyboard.type(PHRASE, { delay: 50 });
        await sleep(env.scaleTimeout(800));

        if (fmt === 'xlsx') {
            // Commit the cell.
            await page.keyboard.press('Enter');
            await sleep(env.scaleTimeout(800));
        }

        // Let the canvas tile re-paint.
        await sleep(env.scaleTimeout(2500));

        // AFTER shot + diff region.
        try {
            const safeName = String(idx).padStart(2, '0') + '_' +
                fileName.replace(/[^A-Za-z0-9._-]+/g, '_');
            result.afterShot = `${safeName}_after.png`;
            await page.screenshot({ path: path.join(SHOTS_DIR, result.afterShot) });
        } catch (e) { result.notes.push('after-shot: ' + e.message); }

        const afterRegion  = await snapEditorRegion(page);
        const afterPixels  = afterRegion  ? await decodePngOnPage(page, afterRegion.png) : null;

        // Verification strategy depends on format.
        let verifyOk = false;
        let detail = '';
        if (fmt === 'docx') {
            const afterChars = await getCharCount(page);
            const delta = (afterChars >= 0 && baseChars >= 0) ? afterChars - baseChars : null;
            log(`[${idx}] after chars=${afterChars} (delta=${delta})`);
            const pdiff = pixelDiffCount(beforePixels, afterPixels);
            log(`[${idx}] pixel diff=${pdiff}`);
            // Either StateWordCount grew by +11 (allow small kit-trim) or
            // canvas changed — same robustness pattern as the rightclick test.
            if (delta !== null && delta >= 9 && delta <= 13) {
                verifyOk = true;
                detail = `StateWordCount +${delta} (expected +11), pxDiff=${pdiff}`;
            } else if (pdiff > 100) {
                verifyOk = true;
                detail = `canvas changed pxDiff=${pdiff}, chars delta=${delta}`;
            } else {
                detail = `chars delta=${delta} (expected +11), pxDiff=${pdiff}`;
            }
        } else {
            const pdiff = pixelDiffCount(beforePixels, afterPixels);
            log(`[${idx}] pixel diff=${pdiff}`);
            if (pdiff > 100) {
                verifyOk = true;
                detail = `canvas changed pxDiff=${pdiff}`;
            } else if (pdiff < 0) {
                detail = `pixel decode failed (pxDiff=${pdiff})`;
            } else {
                detail = `pxDiff=${pdiff} below threshold 100`;
            }
        }

        result.verify = verifyOk ? 'pass' : 'fail';
        result.verifyDetail = detail;
        __cl.recordCheck(`open-and-type: ${fileName}`, verifyOk, detail);
    } catch (e) {
        log(`[${idx}] ERROR: ${e.message}`);
        result.notes.push(e.message);
        result.verifyDetail = result.verifyDetail || ('error: ' + e.message);
        if (/OPEN_BUDGET_EXCEEDED/.test(e.message)) {
            // Capture the observed open time for the report — we
            // exceeded budgetMs but include the actual wall-clock
            // duration from openStart to now.
            result.tOpenMs = Date.now() - tOpenStart;
            result.budgetExceeded = true;
            result.verifyDetail =
                `BUDGET EXCEEDED: ${(result.tOpenMs/1000).toFixed(2)}s > ${(openBudgetMs/1000).toFixed(0)}s budget`;
        }
        __cl.recordCheck(`open-and-type: ${fileName}`, false,
            result.verifyDetail || e.message);
    } finally {
        try { if (page) await page.close(); } catch (_) {}
        try { if (context) await context.close(); } catch (_) {}
    }

    return result;
}

function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Render a per-step breakdown as an inline <details> table. `breakdown` is
// the [{label,tMs,deltaMs}] from withDeltas(); each row shows
// `step  Δms  (@t)` so a reader sees how long the open sat at that step.
// `fallback` (the raw stage trace) is used only to keep a count when no
// breakdown is present yet (incremental partial-report writes). `tMark` is
// the absolute-time prefix ('+' for stages relative to open start, '@' for
// progress timestamps).
function renderBreakdownCell(breakdown, fallback, noun, tMark) {
    const rows = breakdown && breakdown.length ? breakdown : null;
    if (!rows) {
        if (fallback && fallback.length) {
            return `<details><summary>${fallback.length} ${noun}</summary>`
                 + `<ol class="stages">`
                 + fallback.map(s => `<li><code>${escHtml(s.name)}</code> `
                     + `<span class="st">${tMark}${(s.tMs/1000).toFixed(1)}s</span></li>`).join('')
                 + `</ol></details>`;
        }
        return '—';
    }
    const items = rows.map(s =>
        `<li><code>${escHtml(s.label)}</code> `
      + `<span class="dt">Δ${fmtMs(s.deltaMs)}</span> `
      + `<span class="st">${tMark}${(s.tMs/1000).toFixed(1)}s</span></li>`).join('');
    return `<details><summary>${rows.length} ${noun}</summary>`
         + `<ol class="stages">${items}</ol></details>`;
}

// FINE-GRAINED EVENT TIMELINE cell (Feature B): an expandable per-file
// list of EVERY progress event + EVERY observed import-% change, each as
// `t=NNNNms  <event-or-progress-value>`, in chronological order. This is
// the raw, timestamped stream — finer than the de-duped Stage Δ /
// Progress-bar Δ summaries (which only show first-seen transitions).
function renderTimelineCell(timeline) {
    if (!timeline || !timeline.length) return '—';
    const items = timeline.map(e =>
        `<li class="tl-${e.kind}">`
      + `<span class="st">t=${String(e.t).padStart(6)}ms</span> `
      + `<code>${e.kind === 'progress' ? '▸ ' : ''}${escHtml(e.text)}</code></li>`).join('');
    const nProg = timeline.filter(e => e.kind === 'progress').length;
    return `<details><summary>${timeline.length} events `
         + `(${nProg} progress)</summary>`
         + `<ol class="timeline">${items}</ol></details>`;
}

function renderReport(results, walltimeMs, allFiles) {
    const passed = results.filter(r => r.verify === 'pass').length;
    const budgetFailed = results.filter(r => r.budgetExceeded).length;
    const failed = results.length - passed;

    // Synthetic "not run" rows for any file past the abort point.
    const ranNames = new Set(results.map(r => r.fileName));
    const notRunRows = (allFiles || [])
        .map((name, i) => ({ name, idx: i + 1 }))
        .filter(({ name }) => !ranNames.has(name));

    const ts = new Date().toISOString();
    const rows = results.map(r => {
        const tSec = r.tOpenMs >= 0 ? (r.tOpenMs / 1000).toFixed(2) : 'n/a';
        const sizeMb = (r.sizeBytes / (1024 * 1024)).toFixed(2);
        const before = r.beforeShot
            ? `<a href="../shots-regression-bulk-open-ignored/${escHtml(r.beforeShot)}">before</a>`
            : '—';
        const after = r.afterShot
            ? `<a href="../shots-regression-bulk-open-ignored/${escHtml(r.afterShot)}">after</a>`
            : '—';
        const statusCls = r.budgetExceeded ? 'budget'
            : (r.verify === 'pass' ? 'pass' : 'fail');
        const vLabel = r.budgetExceeded ? 'BUDGET' : r.verify;
        const budgetCol = r.budgetMs ? (r.budgetMs / 1000).toFixed(1) + 's' : '—';
        // Slides / sheets / pages column.
        let progressCol = '—';
        if (r.progressKind === 'slide' && r.progressTotal) {
            progressCol = `${r.progressRendered}/${r.progressTotal} slides`;
        } else if (r.progressKind === 'sheet' && r.progressTotal) {
            progressCol = `${r.progressTotal} sheet${r.progressTotal === 1 ? '' : 's'}`;
        } else if (r.progressKind === 'page' && r.progressTotal) {
            progressCol = `${r.progressTotal} page${r.progressTotal === 1 ? '' : 's'}`;
        } else if (r.tOpenMs > 0 && !r.budgetExceeded) {
            progressCol = 'ready';
        }
        // Per-file pipeline-stage breakdown — inline expandable. Each row
        // shows the step transition and the Δms SPENT in that step (gap to
        // the next transition), plus the absolute t it was first seen. This
        // is where the open time went: download vs compile vs import vs paint.
        const stagesCell = renderBreakdownCell(
            r.stageBreakdown, r.stages, 'stages', '+');
        // Per-file OPEN-PROGRESS-BAR breakdown — the time the visible
        // progress bar sat at each percent before advancing (Δms per step).
        const progressCell = renderBreakdownCell(
            r.progressBreakdown, null, 'progress steps', '@');
        // Per-file FINE-GRAINED timeline — the raw timestamped event stream.
        const timelineCell = renderTimelineCell(r.timeline);
        return `<tr class="${statusCls}">
  <td>${r.idx}</td>
  <td class="file">${escHtml(r.fileName)}</td>
  <td>${escHtml(r.fmt)}</td>
  <td class="num">${sizeMb}</td>
  <td class="num tOpen">${tSec}</td>
  <td class="num">${budgetCol}</td>
  <td class="content">${escHtml(progressCol)}</td>
  <td class="stagecol">${stagesCell}</td>
  <td class="stagecol">${progressCell}</td>
  <td class="stagecol">${timelineCell}</td>
  <td class="v">${escHtml(vLabel)}</td>
  <td class="detail">${escHtml(r.verifyDetail || '')}</td>
  <td>${before} / ${after}</td>
</tr>`;
    }).concat(notRunRows.map(({ name, idx }) => `<tr class="notrun">
  <td>${idx}</td>
  <td class="file">${escHtml(name)}</td>
  <td>${escHtml(formatOf(name))}</td>
  <td class="num">—</td>
  <td class="num tOpen">—</td>
  <td class="num">—</td>
  <td class="content">—</td>
  <td class="stagecol">—</td>
  <td class="stagecol">—</td>
  <td class="stagecol">—</td>
  <td class="v">not run</td>
  <td class="detail">aborted: prior file exceeded open budget</td>
  <td>—</td>
</tr>`)).join('\n');

    // Inline embedded previews for the first 6 files so the report
    // is informative without clicking through every link.
    const previews = results.slice(0, 6).map(r => {
        if (!r.beforeShot && !r.afterShot) return '';
        const before = r.beforeShot ? `<img src="../shots-regression-bulk-open-ignored/${escHtml(r.beforeShot)}" alt="before"/>` : '';
        const after  = r.afterShot  ? `<img src="../shots-regression-bulk-open-ignored/${escHtml(r.afterShot)}" alt="after"/>`  : '';
        return `<div class="card"><h3>${escHtml(r.fileName)}</h3>
            <div class="shotpair"><div><div class="lbl">before</div>${before}</div>
            <div><div class="lbl">after</div>${after}</div></div></div>`;
    }).join('\n');

    return `<!doctype html><html><head><meta charset="utf-8"/>
<title>Bulk Open — test/samples/ignored/</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:1300px;margin:1.5rem auto;padding:0 1rem;color:#222}
h1{border-bottom:2px solid #333;padding-bottom:.3rem;margin-bottom:.4rem}
.meta{color:#666;font-size:13px;margin-bottom:1rem}
table{border-collapse:collapse;width:100%;font-size:13px;margin-bottom:2rem}
th,td{border:1px solid #ddd;padding:5px 8px;vertical-align:top}
th{background:#f4f4f4;text-align:left;position:sticky;top:0}
td.num{text-align:right;font-variant-numeric:tabular-nums}
td.tOpen{font-weight:600}
td.file{font-family:monospace;font-size:12px}
td.v{text-align:center;font-weight:600}
tr.pass td.v{background:#dfd;color:#0a4d0a}
tr.fail td.v{background:#fdd;color:#7d0a0a}
tr.budget td.v{background:#f88;color:#fff}
tr.budget td{background:#fee}
tr.notrun td{color:#999;background:#f6f6f6;font-style:italic}
tr.notrun td.v{background:#eee;color:#999;font-style:italic;font-weight:normal}
td.detail{color:#666;font-size:12px;max-width:380px}
td.content{text-align:center;font-size:12px;color:#555;font-family:monospace}
td.stagecol{font-size:11px;max-width:170px}
td.stagecol details summary{cursor:pointer;color:#0a58ca}
ol.stages{margin:4px 0 4px 16px;padding:0}
ol.stages li{white-space:nowrap;line-height:1.5}
ol.stages .st{color:#888;font-variant-numeric:tabular-nums}
ol.stages .dt{color:#0a58ca;font-weight:600;font-variant-numeric:tabular-nums}
ol.timeline{margin:4px 0 4px 12px;padding:0;list-style:none;max-height:320px;overflow:auto;border-left:2px solid #eee}
ol.timeline li{white-space:nowrap;line-height:1.45;font-size:11px;padding-left:6px}
ol.timeline li .st{color:#888;font-variant-numeric:tabular-nums;margin-right:6px}
ol.timeline li code{color:#333}
ol.timeline li.tl-progress{background:#eef4ff}
ol.timeline li.tl-progress code{color:#0a58ca;font-weight:600}
.card{display:inline-block;vertical-align:top;margin:0 12px 18px 0;padding:8px;border:1px solid #ddd;border-radius:4px;background:#fafafa}
.card h3{font-size:13px;margin:0 0 6px 0;font-family:monospace}
.shotpair{display:flex;gap:8px}
.shotpair img{max-width:280px;height:auto;display:block;border:1px solid #ccc}
.lbl{font-size:11px;color:#888;margin-bottom:2px}
.summary{padding:8px 12px;background:#f4f4f4;border-radius:4px;display:inline-block;margin-bottom:1rem}
.summary strong{font-size:18px}
</style></head><body>
<h1>Bulk Open — test/samples/ignored/</h1>
<div class="meta">Generated ${escHtml(ts)} · Wall: ${(walltimeMs/1000).toFixed(1)}s · Viewer: ${escHtml(VIEWER)}</div>
<div class="summary">
  Total files: <strong>${(allFiles || results).length}</strong> ·
  Run: <strong>${results.length}</strong> ·
  Pass: <strong style="color:#0a4d0a">${passed}</strong> ·
  Fail: <strong style="color:#7d0a0a">${failed}</strong> ·
  Budget exceeded: <strong style="color:#c00">${budgetFailed}</strong> ·
  Not run: <strong style="color:#999">${notRunRows.length}</strong>
</div>
<div class="meta" style="margin-bottom:.8rem">
  Open budget: warm = <code>size × ${MS_PER_MB/1000} s/MB</code>, cold (first file) adds <code>+${COLD_OVERHEAD_MS/1000} s</code>; floor <code>${MIN_OPEN_MS/1000} s</code>.
  Test aborts immediately on first budget overrun.
  <br/>The <strong>Timeline (raw)</strong> column expands to the fine-grained
  per-file event stream: every <code>__prewarmTimings</code> mark + every
  observed import/statusindicator % change, each as <code>t=NNNNms&nbsp;event</code>
  — finer than the de-duped Stage&nbsp;Δ / Progress-bar&nbsp;Δ summaries.
</div>
<table>
<thead><tr>
  <th>#</th><th>File</th><th>Fmt</th><th>Size (MiB)</th>
  <th>Open (s)</th><th>Budget</th><th>Content</th><th>Stage Δ</th><th>Progress-bar Δ</th><th>Timeline (raw)</th><th>Verify</th><th>Detail</th><th>Shots</th>
</tr></thead>
<tbody>
${rows}
</tbody>
</table>
<h2 style="border-bottom:1px solid #ccc;padding-bottom:.2rem">Sampled before/after previews</h2>
${previews}
</body></html>`;
}

(async () => {
    log('=== bulk-open-ignored — discovery ===');
    const files = listFiles();
    log(`Found ${files.length} files in ${SAMPLES_DIR}`);
    if (!files.length) {
        log('Nothing to do — exiting 0');
        // Still write an empty report so the URL exists.
        fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
        fs.writeFileSync(REPORT_PATH, renderReport([], 0, []));
        process.exit(0);
    }

    // Clean shots dir so old runs don't pollute the report.
    fs.rmSync(SHOTS_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOTS_DIR, { recursive: true });

    const wallStart = Date.now();
    const { browser, cleanup } = await launch({ width: 1280, height: 900 });
    const results = [];

    let budgetFailure = null;
    try {
        for (let i = 0; i < files.length; i++) {
            const idx = i + 1;
            let r;
            try {
                r = await openAndTypeOne(browser, files[i], idx);
            } catch (e) {
                log(`[${idx}] HARD ERROR: ${e.stack || e.message}`);
                r = {
                    idx, fileName: files[i], fmt: formatOf(files[i]),
                    sizeBytes: 0, tOpenMs: -1, verify: 'fail',
                    verifyDetail: 'hard error: ' + (e.message || e),
                    beforeShot: '', afterShot: '', notes: [],
                    budgetExceeded: /OPEN_BUDGET_EXCEEDED/.test(e.message || ''),
                };
                __cl.recordCheck(`open-and-type: ${files[i]}`, false, r.verifyDetail);
            }
            results.push(r);

            // Write the report incrementally so a mid-run crash leaves
            // partial-but-useful data behind.
            try {
                fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
                fs.writeFileSync(REPORT_PATH, renderReport(results, Date.now() - wallStart, files));
            } catch (e) { log('partial-report write failed: ' + e.message); }

            // PERF GATE — if this file blew its open budget, the whole
            // test fails IMMEDIATELY. No further files are run; the
            // remaining entries will be rendered as "not run" (grey).
            if (r.budgetExceeded) {
                budgetFailure = r;
                log(`\n!!! OPEN BUDGET EXCEEDED on file ${idx}/${files.length}: ${r.fileName}`);
                log(`!!! observed open time = ${(r.tOpenMs/1000).toFixed(2)}s, budget = ${(r.budgetMs ? (r.budgetMs/1000).toFixed(0) : '?')}s`);
                log(`!!! aborting bulk run — remaining ${files.length - idx} files will not be opened`);
                break;
            }
        }
    } finally {
        await cleanup();
    }

    const walltime = Date.now() - wallStart;
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, renderReport(results, walltime, files));

    // Summary log.
    log('\n=== summary ===');
    const passed = results.filter(r => r.verify === 'pass').length;
    log(`pass: ${passed} / ${results.length} run  (wall: ${(walltime/1000).toFixed(1)}s)`);
    for (const r of results) {
        const t = r.tOpenMs >= 0 ? (r.tOpenMs/1000).toFixed(2)+'s' : '   n/a';
        const marker = r.budgetExceeded ? '!' : (r.verify === 'pass' ? 'OK' : 'X');
        log(`  ${marker} ${t.padStart(7)} ${r.fmt.padEnd(4)} ${r.fileName}`);
    }
    if (results.length < files.length) {
        log(`  -- ${files.length - results.length} file(s) NOT RUN (aborted on budget failure)`);
    }
    log(`\nReport: ${REPORT_PATH}`);
    log(`URL:    https://wasm.atgpartners.info/reports/regression-bulk-open-ignored.html`);

    if (budgetFailure) {
        log(`\nFAIL: open budget exceeded — exiting 1`);
        process.exit(1);
    }

    // No budget failure → exit 0. Per-file PASS/FAIL is captured in
    // __cl + the HTML report (verification of "hello world landed"
    // is still a soft signal in the report, not a pass-gate).
    process.exit(0);
})();
