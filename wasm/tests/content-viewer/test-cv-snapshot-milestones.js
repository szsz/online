// test-cv-snapshot-milestones.js — the single-user snapshot-milestones test,
// adapted to run against the Tresorit content-viewer instead of our viewer.
//
// Drives content-preview's standalone /collabora-tester UI (real file <input>,
// no backend) for each doc type, records editor load milestones (console +
// iframe DOM) + screenshots, and renders a report. Unlike the original
// (tests/snapshot/test-snapshot-milestones.js) there is no HEAPU8 snapshot /
// warm-restore in this build, so "warm" here means the 2nd open with the
// service worker's asset cache primed (WASM still cold-inits).
//
// Two verdicts per session:
//   - content_verified : iframe has <canvas> AND doc-type status text
//                        (proves the document parsed + the status bar filled)
//   - editor_interactive: content-preview's "Opening document…" overlay has
//                        cleared on the top page (proves the editor actually
//                        became usable — this is the signal that hangs when
//                        activation never completes: "waiting for editor").
//
// Usage:
//   node wasm/tests/content-viewer/test-cv-snapshot-milestones.js [base-url]
//   BASE_URL=https://wasm-viewer-test.azurewebsites.net node ...  (default)
//   ONLY_DOC=writer  WARM_TRIALS=1  node ...

'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const env = require('../../lib/test-env');
const { openViaContentViewer } = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const OUT_DIR = '/tmp/content-viewer-report/snapshot-milestones';
const DATA_DIR = path.join(__dirname, '..', '..', '..', 'test', 'data');
const T0 = Date.now();

const COLD_BUDGET_MS = parseInt(process.env.COLD_BUDGET_MS || '150000', 10);
const WARM_BUDGET_MS = parseInt(process.env.WARM_BUDGET_MS || '120000', 10);
const WARM_TRIALS = parseInt(process.env.WARM_TRIALS || '1', 10);
// How long after content_verified we keep polling for the overlay to clear
// before declaring the editor "not interactive" (reproduces waiting-for-editor).
const INTERACTIVE_GRACE_MS = parseInt(process.env.INTERACTIVE_GRACE_MS || '30000', 10);

const ALL_DOCS = [
    { tag: 'writer',  doc: 'new.docx',        label: 'Writer (.docx)',  expectStatus: /\d+\s*words?/i,        expectAssert: '#StateWordCount' },
    { tag: 'calc',    doc: 'testdoc.xlsx',    label: 'Calc (.xlsx)',    expectStatus: /Sheet\s*\d+\s*of/i,    expectAssert: '#StatusDocPos' },
    { tag: 'impress', doc: 'rare-fonts.pptx', label: 'Impress (.pptx)', expectStatus: /(Slide\s*\d+|page\s*\d+\s*of)/i, expectAssert: 'canvas' },
];
const DOCS = process.env.ONLY_DOC ? ALL_DOCS.filter(d => d.tag === process.env.ONLY_DOC) : ALL_DOCS;

// Editor-internal console milestones (apply to the content-viewer embed too) +
// content-viewer-specific ones.
const CONSOLE_MILESTONES = [
    { id: 'sw_skipped',        label: 'content-viewer mode (sw-bridge skipped)', re: /sw-bridge:skipped/ },
    { id: 'cv_doc_written',    label: 'document written to FS (/local-file)',    re: /\[content-viewer\] wrote/ },
    { id: 'wasm_compile_done', label: 'WASM module compiled',                    re: /emscripten:module_defined/ },
    { id: 'called_run',        label: 'callMain reached',                        re: /emscripten:calledRun/ },
    { id: 'coolwsd_entered',   label: 'COOLWSD thread entered',                  re: /COOLWSD thread ENTERED/ },
    { id: 'lok_init_2',        label: 'lok_init_2 done',                         re: /lok_init_2 done(?! \()/ },
    { id: 'onload_done',       label: 'onLoad done',                             re: /TIMING: onLoad done\b/ },
    { id: 'first_doc_painted', label: 'firstDocPainted returned',               re: /firstDocPainted returned/ },
    { id: 'activation_pending',label: 'relay: activation pending (waiting…)',    re: /Activation pending: waiting/ },
    { id: 'doc_loaded_prof',   label: 'doc:loaded (canvas painted)',            re: /\[profile \+\d+ms\] doc:loaded/ },
];
const DOM_MILESTONES = [
    { id: 'dom_canvas',         label: 'First <canvas> in editor iframe' },
    { id: 'dom_status_text',    label: 'Status bar populated' },
    { id: 'content_verified',   label: 'Document content VERIFIED (canvas + status)' },
    { id: 'editor_interactive', label: 'Editor interactive (overlay cleared)' },
];
const ALL_MILESTONES = [...CONSOLE_MILESTONES, ...DOM_MILESTONES];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => console.log('[' + ((Date.now() - T0) / 1000).toFixed(1) + 's] ' + m);
const ensureDir = d => fs.mkdirSync(d, { recursive: true });

// The tester covers the editor iframe with a loading block (spinner +
// statusText) while uiState==='loading', and only reaches uiState==='loaded'
// on App_LoadingStatus/Document_Loaded — at which point it removes the spinner
// AND enables the Save button. That transition is the real "user can see and
// use the document" signal (the iframe itself un-hides early, on sendFileToSW,
// so iframe-visibility is NOT the signal). Probe both for robustness.
async function probeEditorInteractive(page) {
    try {
        return await page.evaluate(() => {
            const spinner = document.querySelector('[role="status"][aria-label="Loading"]');
            if (spinner) return false;                       // still uiState==='loading'
            const save = [...document.querySelectorAll('button')]
                .find(b => /^save$/i.test((b.textContent || '').trim()));
            return !!(save && !save.disabled);               // uiState==='loaded'
        });
    } catch (e) { return false; }
}

async function probeIframe(page, expectStatus, expectAssert) {
    try {
        const f = page.frames().find(fr => (fr.url() || '').includes('cool.html'));
        if (!f || f.isDetached()) return { hasCanvas: false, statusText: '', statusMatches: false };
        return await f.evaluate((reSrc, reFlags, sel) => {
            const hasCanvas = document.querySelectorAll('canvas').length > 0;
            let statusText = '';
            ['#StateWordCount', '#StatusDocPos', '#PageStatus', '#SlideStatus'].forEach(s => {
                const el = document.querySelector(s);
                if (el && el.textContent && el.textContent.trim()) statusText += ' ' + el.textContent.trim();
            });
            const statusMatches = new RegExp(reSrc, reFlags).test(statusText);
            return { hasCanvas, statusText: statusText.substring(0, 200), statusMatches };
        }, expectStatus.source, expectStatus.flags, expectAssert);
    } catch (e) { return { hasCanvas: false, statusText: '', statusMatches: false }; }
}

async function captureSession({ browser, docPath, sessionTag, expectStatus, expectAssert, budgetMs }) {
    const sessDir = path.join(OUT_DIR, sessionTag);
    ensureDir(sessDir);
    const consoleLines = [];
    let activationPendingLast = 0; // last elapsed seconds seen in a pending log
    const onConsole = m => {
        const t = m.text();
        consoleLines.push({ t: Date.now(), line: t.substring(0, 600) });
        const am = /Activation pending: waiting for (\w+) \((\d+)s\)/.exec(t);
        if (am) activationPendingLast = parseInt(am[2], 10);
    };

    const navStart = Date.now();
    let page, editorFrame;
    try {
        ({ page, editorFrame } = await openViaContentViewer(browser, BASE, docPath, {
            onConsole, viewport: { width: 1280, height: 900 }, iframeTimeout: 45000,
        }));
    } catch (e) {
        consoleLines.push({ t: Date.now(), line: 'OPEN_ERR: ' + (e.message || '') });
        return { hits: {}, screenshots: {}, navStart, totalMs: Date.now() - navStart, consoleLines, activationPendingLast, openError: e.message };
    }

    const hits = {}, screenshots = {};
    let consoleCursor = 0;
    async function record(id, at, settleMs) {
        if (hits[id] !== undefined) return;
        hits[id] = at - navStart;
        if (settleMs) await sleep(settleMs);
        const fp = path.join(sessDir, String(hits[id]).padStart(7, '0') + '-' + id + '.png');
        try { await page.screenshot({ path: fp }); screenshots[id] = path.relative(OUT_DIR, fp); } catch (e) {}
    }

    const deadline = navStart + budgetMs;
    let contentVerifiedAt = 0;
    while (Date.now() < deadline) {
        while (consoleCursor < consoleLines.length) {
            const ev = consoleLines[consoleCursor++];
            for (const m of CONSOLE_MILESTONES)
                if (hits[m.id] === undefined && m.re.test(ev.line)) await record(m.id, ev.t);
        }
        const probe = await probeIframe(page, expectStatus, expectAssert);
        const now = Date.now();
        if (hits.dom_canvas === undefined && probe.hasCanvas) await record('dom_canvas', now);
        if (hits.dom_status_text === undefined && probe.statusText.trim()) await record('dom_status_text', now);
        if (hits.content_verified === undefined && probe.hasCanvas && probe.statusMatches) {
            await record('content_verified', now);
            contentVerifiedAt = now;
        }
        if (hits.editor_interactive === undefined && await probeEditorInteractive(page)) {
            await record('editor_interactive', now, 300);
        }
        // Exit conditions:
        if (hits.editor_interactive !== undefined) {
            const sinceI = now - (navStart + hits.editor_interactive);
            // The doc-type status text (word/sheet/slide count) can populate a
            // second or two AFTER the editor is interactive (Save-enabled), so
            // don't bail the instant we're interactive — give content_verified a
            // bounded settle to be captured. Break once both are in, or after
            // 10s if the status genuinely never matches (a real failure).
            if (hits.content_verified !== undefined && sinceI > 1000) break;
            if (sinceI > 10000) break;
        }
        // content verified but the editor never became interactive (overlay
        // stuck) — reproduces "waiting for editor".
        if (hits.content_verified !== undefined && hits.editor_interactive === undefined
            && now - contentVerifiedAt > INTERACTIVE_GRACE_MS) break;
        await sleep(200);
    }

    // wire bytes (top + iframe)
    let wireBytes = 0;
    try {
        const top = await page.evaluate(() => performance.getEntriesByType('resource').reduce((s, e) => s + (e.transferSize || 0), 0));
        wireBytes += top;
        const f = page.frames().find(fr => (fr.url() || '').includes('cool.html'));
        if (f && !f.isDetached()) wireBytes += await f.evaluate(() => performance.getEntriesByType('resource').reduce((s, e) => s + (e.transferSize || 0), 0));
    } catch (e) {}

    try { await page.screenshot({ path: path.join(sessDir, 'final.png') }); } catch (e) {}
    fs.writeFileSync(path.join(sessDir, 'console.log'), consoleLines.map(e => `[+${e.t - navStart}ms] ${e.line}`).join('\n'));
    const totalMs = Date.now() - navStart;
    try { await page.close(); } catch (e) {}
    return { hits, screenshots, navStart, totalMs, consoleLines, activationPendingLast, wireBytes };
}

(async () => {
    ensureDir(OUT_DIR);
    log('=== content-viewer snapshot-milestones ===');
    log('viewer: ' + BASE + '   docs: ' + DOCS.map(d => d.tag).join(','));

    const results = {};
    for (const d of DOCS) {
        const docPath = path.join(DATA_DIR, d.doc);
        if (!fs.existsSync(docPath)) { log('MISSING ' + docPath); process.exit(2); }
        log(''); log('======== ' + d.label + ' ========');
        const userDataDir = path.join(os.tmpdir(), 'cv-snap-' + d.tag + '-' + Date.now() + '-' + process.pid);
        const launchOpts = { headless: 'new', protocolTimeout: COLD_BUDGET_MS + 60000, userDataDir,
            args: ['--no-sandbox', '--enable-features=SharedArrayBuffer'] };

        log('[' + d.tag + '] cold …');
        let browser = await puppeteer.launch(launchOpts);
        const cold = await captureSession({ browser, docPath, sessionTag: d.tag + '-cold', expectStatus: d.expectStatus, expectAssert: d.expectAssert, budgetMs: COLD_BUDGET_MS });
        log('[' + d.tag + '] cold: ' + (cold.totalMs / 1000).toFixed(1) + 's verified=' + (cold.hits.content_verified !== undefined) + ' interactive=' + (cold.hits.editor_interactive !== undefined) + (cold.openError ? ' OPEN_ERR=' + cold.openError : ''));
        await browser.close(); await sleep(1500);

        const warmTrials = [];
        for (let i = 1; i <= WARM_TRIALS; i++) {
            log('[' + d.tag + '] warm ' + i + '/' + WARM_TRIALS + ' …');
            browser = await puppeteer.launch(launchOpts);
            const w = await captureSession({ browser, docPath, sessionTag: WARM_TRIALS === 1 ? d.tag + '-warm' : d.tag + '-warm-' + i, expectStatus: d.expectStatus, expectAssert: d.expectAssert, budgetMs: WARM_BUDGET_MS });
            log('[' + d.tag + '] warm ' + i + ': ' + (w.totalMs / 1000).toFixed(1) + 's verified=' + (w.hits.content_verified !== undefined) + ' interactive=' + (w.hits.editor_interactive !== undefined));
            warmTrials.push(w);
            await browser.close(); await sleep(1000);
        }
        results[d.tag] = { label: d.label, cold, warmTrials };
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
    }

    // Report
    let rows = '';
    const sessionsOf = r => [['cold', r.cold], ...r.warmTrials.map((w, i) => [r.warmTrials.length === 1 ? 'warm' : 'warm-' + (i + 1), w])];
    let body = '';
    for (const d of DOCS) {
        for (const [kind, s] of sessionsOf(results[d.tag])) {
            const verified = s.hits.content_verified !== undefined;
            const interactive = s.hits.editor_interactive !== undefined;
            const banner = interactive
                ? `<p class="ok">✓ interactive at +${(s.hits.editor_interactive / 1000).toFixed(1)}s (verified +${(s.hits.content_verified / 1000).toFixed(1)}s)</p>`
                : verified
                    ? `<p class="fail">✗ doc verified at +${(s.hits.content_verified / 1000).toFixed(1)}s but editor NEVER became interactive — "Opening document…" overlay stuck (activation pending last seen ${s.activationPendingLast}s)</p>`
                    : `<p class="fail">✗ document NOT verified${s.openError ? ' (open error: ' + s.openError + ')' : ''}</p>`;
            let mrows = '';
            for (const m of ALL_MILESTONES) {
                if (s.hits[m.id] === undefined) continue;
                const shot = s.screenshots[m.id] ? `<a href="${s.screenshots[m.id]}"><img src="${s.screenshots[m.id]}" style="max-width:200px"/></a>` : '';
                mrows += `<tr><td>${m.label}</td><td>+${(s.hits[m.id] / 1000).toFixed(2)}s</td><td>${shot}</td></tr>`;
            }
            body += `<section><h2>${d.label} — ${kind.toUpperCase()}</h2>${banner}
              <p>total ${(s.totalMs / 1000).toFixed(1)}s · wire ${((s.wireBytes || 0) / 1048576).toFixed(1)}MB ·
                 <a href="${d.tag}-${kind}/console.log">console</a> · <a href="${d.tag}-${kind}/final.png">final</a></p>
              <table>${mrows}</table></section>`;
        }
    }
    const html = `<!doctype html><meta charset=utf-8><title>content-viewer snapshot-milestones</title>
      <style>body{font-family:system-ui;max-width:1000px;margin:2rem auto}table{border-collapse:collapse;width:100%}
      td,th{border:1px solid #ddd;padding:4px 8px;font-size:14px}.ok{color:#22863a;font-weight:600}.fail{color:#cb2431;font-weight:600}
      h2{margin-top:2rem}</style>
      <h1>content-viewer snapshot-milestones</h1><p>viewer: <code>${BASE}</code> · ${new Date().toISOString()}</p>${body}`;
    fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html);
    log(''); log('report: ' + OUT_DIR + '/index.html');

    // Verdict: EVERY session (cold + each warm trial) must verify the document
    // AND reach the interactive state (content-preview uiState==='loaded' /
    // Save enabled). The warm/fast-load path is where content-preview misses
    // the editor's Document_Loaded event and stays stuck "loading".
    let allOk = true;
    for (const d of DOCS) {
        const sessions = [['cold', results[d.tag].cold],
            ...results[d.tag].warmTrials.map((w, i) => ['warm' + (results[d.tag].warmTrials.length > 1 ? (i + 1) : ''), w])];
        for (const [kind, s] of sessions) {
            const v = s.hits.content_verified !== undefined;
            const inter = s.hits.editor_interactive !== undefined;
            const ok = v && inter;
            log('  ' + d.tag + '/' + kind + ': verified=' + v + ' interactive=' + inter + (ok ? ' PASS' : ' FAIL'));
            if (!ok) allOk = false;
        }
    }
    log(allOk ? 'ALL PASS' : 'FAIL (see report)');
    process.exit(allOk ? 0 : 1);
})().catch(e => { log('FATAL: ' + (e.stack || e)); process.exit(2); });
