// test-snapshot-cross-type.js — exercise the warm-restore code path
// across all four meaningful cases:
//
//   Session A (cold)    : open writer.docx  → snapshot saves
//   Session B (warm)    : open same writer.docx          → wall_writer_same
//   Session C (warm)    : open different writer2.docx    → wall_writer_diff
//   Session D (warm)    : open calc.xlsx                 → wall_calc
//   Session E (warm)    : open impress.pptx              → wall_impress
//
// Each session is a real puppeteer browser launch (separate
// userDataDir-shared-process), so navigation and Cache-Storage
// behaviour match a real user closing-and-reopening the tab.
//
// Per session we record three timestamps:
//   t_first_canvas   — first <canvas> appears in the iframe DOM
//   t_status        — status indicator (word count / Sheet N / Slide N)
//                      first becomes non-blank
//   t_content_ok    — doc-type-specific content assertion fires
//
// Plus an absolute wall = navigation→t_content_ok.  This is the
// number we care about (not prewarm:ready, which is loosely
// defined). Goal: t_content_ok ≤ 5 s on every warm session.
//
// The test does NOT bypass the viewer or call any internal JS
// directly — every action is driven by puppeteer page.goto() and
// page.evaluate that observes (does not mutate) the iframe tree.

'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-snapshot-cross-type';
const T0 = Date.now();
const TIMEOUT_MS = 120000;  // per session — 2 min cap

const DATA_DIR = path.join(__dirname, '..', 'test', 'data');
const CASES = [
    { tag: 'cold-writer', kind: 'cold',
      doc: 'new.docx',          docType: 'writer',
      // Cold uses 'new.docx' (1-page, 2 words) — same as previous test.
      expectStatus: /\d+\s*words?/i,
      expectAssert: '#StateWordCount',         // existence implies writer chrome
    },
    { tag: 'warm-same-writer', kind: 'warm',
      doc: 'new.docx',          docType: 'writer',
      expectStatus: /\d+\s*words?/i,
      expectAssert: '#StateWordCount',
    },
    { tag: 'warm-diff-writer', kind: 'warm',
      doc: 'template.docx',     docType: 'writer',
      expectStatus: /\d+\s*words?/i,
      expectAssert: '#StateWordCount',
    },
    { tag: 'warm-calc', kind: 'warm',
      doc: 'testdoc.xlsx',      docType: 'calc',
      expectStatus: /Sheet\s*\d+\s*of/i,
      expectAssert: '#StatusDocPos',           // calc uses #StatusDocPos for "Sheet 1 of 1"
    },
    { tag: 'warm-impress', kind: 'warm',
      doc: 'rare-fonts.pptx',   docType: 'impress',
      // impress status can vary — accept "Slide N", "Slide N of M", or just any slide indicator
      expectStatus: /(Slide\s*\d+|page\s*\d+\s*of)/i,
      // Don't pin to a specific selector for impress — `canvas` + status match is enough.
      expectAssert: 'canvas',
    },
];

function log(m) {
    console.log('[' + ((Date.now() - T0) / 1000).toFixed(1) + 's] ' + m);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Wait for the iframe to render *something* and report the three
// timestamps. Polls page.evaluate every 200 ms; gives up at TIMEOUT_MS.
//
// Returns { t_first_canvas, t_status, t_content_ok }
// (each ms-from-navigation) or { error: <string> } on timeout.
async function dumpIframeStatus(page) {
    try {
        const f = page.frames().find(f =>
            (f.url() || '').includes('cool.html') || (f.url() || '').includes('/browser/'));
        if (!f || f.isDetached()) return '(no iframe)';
        return await f.evaluate(() => {
            const out = [];
            const sels = ['#StateWordCount', '#StatusDocPos', '#PageStatus',
                          '#StatusBar', '.cool-statusbar', '#statusbar',
                          'footer', '.statusbar', '[id*="tatus"]', '[class*="tatus"]'];
            for (const sel of sels) {
                document.querySelectorAll(sel).forEach(el => {
                    const t = (el.textContent || '').trim().substring(0, 80);
                    if (t) out.push(sel + '=[' + t + ']');
                });
            }
            return out.join(' | ').substring(0, 500);
        });
    } catch (e) { return '(probe error: ' + e.message + ')'; }
}

async function waitForContentLoaded(browser, page, navStart, c) {
    // Impress's warm-restore path can re-run loadComponentFromURL
    // multiple times before the slide indicator stabilises. The 120 s
    // base budget is too tight on this host. Bump for impress only.
    const caseTimeout = c.docType === 'impress' ? 240000 : TIMEOUT_MS;
    const deadline = Date.now() + caseTimeout;
    let t_first_canvas = null, t_status = null, t_content_ok = null;
    while (Date.now() < deadline) {
        // The editor iframe is cross-origin (wasm.atgpartners.info vs the
        // viewer host). page.evaluate on the parent can't see its DOM.
        // page.frames() returns OOPIF handles directly; iframe.evaluate
        // runs in the iframe's own context and bypasses the same-origin
        // check entirely.
        const frames = page.frames();
        const editorFrame = frames.find(f =>
            (f.url() || '').includes('cool.html')
            || (f.url() || '').includes('/browser/'));
        let probe = { hasCanvas: false, statusText: '', statusMatches: false, assertExists: false };
        if (editorFrame && !editorFrame.isDetached()) {
            try {
                probe = await editorFrame.evaluate((statusRegexSrc, statusRegexFlags, assertSel) => {
                    const canvases = document.querySelectorAll('canvas');
                    const hasCanvas = canvases.length > 0;
                    const docLoadedFlag = !!window.__wasmInitialDocLoaded;
                    // Look for status text in any element whose id contains
                    // "tatus" (StatusBar, StatusbarItem*, etc.) — captures
                    // both the per-item slide indicator and writer/calc
                    // word/sheet counts. Test BAILS if it matches early
                    // false-positives (e.g. "Status Bar" header) — the
                    // regex enforces the doc-type-specific shape (\d+
                    // words for writer, Sheet N for calc, Slide N for
                    // impress) so toolbars / menus don't pass.
                    let statusText = '';
                    document.querySelectorAll('[id*="tatus"]').forEach(el => {
                        const t = (el.textContent || '').trim();
                        if (t) statusText += ' ' + t;
                    });
                    // Specific known-good items as backup.
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
                             statusMatches, assertExists: !!assertEl,
                             docLoadedFlag };
                }, c.expectStatus.source, c.expectStatus.flags, c.expectAssert);
            } catch (e) {
                // Frame can become detached during navigation — retry next tick.
                probe = { hasCanvas: false, statusText: '', statusMatches: false, assertExists: false };
            }
        }
        const now = Date.now() - navStart;
        if (t_first_canvas === null && probe.hasCanvas) t_first_canvas = now;
        if (t_status === null && probe.statusMatches) t_status = now;
        // content_ok requires canvas painted AND status text matches the
        // doc-type-specific regex (\d+ words / Sheet N of M / Slide N of M).
        // The regex is the strict check — it fails on toolbar / menu text
        // ("Slide Show" alone, "Page Break", etc.) that doesn't have the
        // status-bar shape. wasm-loader's __wasmInitialDocLoaded flag is
        // a secondary signal; we don't require it because some loader
        // paths set it late or skip it (e.g. impress UI variant).
        if (t_content_ok === null && probe.statusMatches && probe.hasCanvas) {
            t_content_ok = now;
            return { t_first_canvas, t_status, t_content_ok, statusText: probe.statusText };
        }
        await sleep(200);
    }
    const lastDump = await dumpIframeStatus(page);
    return { error: 'TIMEOUT after ' + caseTimeout + 'ms; last DOM: ' + lastDump,
             t_first_canvas, t_status, t_content_ok };
}

(async () => {
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    log('=== Snapshot cross-type test (5 sessions) ===');

    // Upload all four docs once. Each gets its own fileId/secret.
    const uploads = {};
    for (const c of CASES) {
        if (uploads[c.doc]) continue;
        const docPath = path.join(DATA_DIR, c.doc);
        if (!fs.existsSync(docPath)) {
            log('  MISSING SAMPLE: ' + docPath + ' — aborting test');
            process.exit(2);
        }
        const bytes = fs.readFileSync(docPath);
        uploads[c.doc] = await uploadV2(VIEWER, c.doc, bytes);
        log('Uploaded ' + c.doc + ' → ' + uploads[c.doc].fileId.substring(0, 8) + '…');
    }

    // Persistent profile shared across sessions so Cache Storage / IndexedDB
    // / Disk Cache survive each browser close. This is what lets the warm
    // sessions actually find the cold session's snapshot.
    const USER_DATA_DIR = path.join(os.tmpdir(),
        'snapshot-cross-type-' + Date.now() + '-' + process.pid);
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    log('Persistent userDataDir: ' + USER_DATA_DIR);

    const launchOpts = {
        headless: 'new', protocolTimeout: TIMEOUT_MS + 60000,
        userDataDir: USER_DATA_DIR,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    };

    const results = [];

    for (const c of CASES) {
        log('');
        log('=== ' + c.tag + ' (' + c.kind + ') — ' + c.doc + ' ===');
        const browser = await puppeteer.launch(launchOpts);
        const page = await browser.newPage();
        page.on('dialog', d => d.accept().catch(() => {}));
        page.on('console', m => {
            const t = m.text();
            if (/\bTIMING:|\[profile\b|snapshot:|prewarm:ready|abort|RuntimeError|^WARM_DBG|WASM_THREAD|Pthread|wasmapp|onAbort/i.test(t)) {
                log('  [console/' + c.tag + '] ' + t.substring(0, 300));
            }
        });
        page.on('pageerror', e => log('  [pageerror/' + c.tag + '] ' + (e.message || '').substring(0, 300)));
        await page.setCacheEnabled(true);
        await page.setViewport({ width: 1280, height: 900 });

        const up = uploads[c.doc];
        const fileUrl = VIEWER + '/?planc=1#file=' + up.b64urlSecret;
        const navStart = Date.now();
        await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const r = await waitForContentLoaded(browser, page, navStart, c);
        const wall = Date.now() - navStart;
        const ok = !r.error && r.t_content_ok !== null;
        log(`  result: ${ok ? 'PASS' : 'FAIL'}  wall=${(wall/1000).toFixed(2)}s` +
            `  first_canvas=${r.t_first_canvas !== null ? (r.t_first_canvas/1000).toFixed(2)+'s' : '—'}` +
            `  status=${r.t_status !== null ? (r.t_status/1000).toFixed(2)+'s' : '—'}` +
            `  content_ok=${r.t_content_ok !== null ? (r.t_content_ok/1000).toFixed(2)+'s' : '—'}` +
            (r.error ? '  err=' + r.error : '') +
            (r.statusText ? '  status=[' + r.statusText.substring(0, 60) + ']' : ''));

        await page.screenshot({ path: SHOT_DIR + '/' + c.tag + '.png' }).catch(() => {});

        results.push({ tag: c.tag, kind: c.kind, doc: c.doc, ok, wall,
                       t_first_canvas: r.t_first_canvas, t_status: r.t_status,
                       t_content_ok: r.t_content_ok, error: r.error });

        // Give Cache.put time to actually persist to disk before closing.
        // Watching 'snapshot:saved' would be tighter but adds plumbing.
        if (c.kind === 'cold') {
            log('  cold session: holding 60s for snapshot persist…');
            await sleep(60000);
        }
        await browser.close();
        await sleep(2000);
    }

    log('');
    log('=== SUMMARY ===');
    const headers = ['session', 'kind', 'doc', 'ok', 'wall', 'first_canvas', 'status', 'content_ok'];
    log(headers.join('\t'));
    for (const r of results) {
        log([
            r.tag, r.kind, r.doc, r.ok ? 'PASS' : 'FAIL',
            (r.wall / 1000).toFixed(2) + 's',
            r.t_first_canvas !== null ? (r.t_first_canvas / 1000).toFixed(2) + 's' : '—',
            r.t_status        !== null ? (r.t_status        / 1000).toFixed(2) + 's' : '—',
            r.t_content_ok    !== null ? (r.t_content_ok    / 1000).toFixed(2) + 's' : '—',
        ].join('\t'));
    }

    const warm = results.filter(r => r.kind === 'warm');
    const allWarmPass = warm.every(r => r.ok);
    const maxWarm = Math.max(...warm.map(r => r.t_content_ok || 999999));
    log('');
    log('all-warm-pass: ' + allWarmPass + '   max-warm-content_ok: ' + (maxWarm/1000).toFixed(2) + 's');
    log('goal: max-warm-content_ok ≤ 5.00s');

    // Clean up the persistent userDataDir so we don't leak ~700 MB / run
    // into /tmp. Multi-run iteration loops were filling the disk and
    // degrading subsequent runs. Disk-only cleanup; results were already
    // recorded above.
    try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }); } catch (e) {}

    process.exit(allWarmPass && maxWarm <= 5000 ? 0 : 1);
})().catch(e => {
    log('FATAL: ' + (e.stack || e.message || e));
    process.exit(2);
});
