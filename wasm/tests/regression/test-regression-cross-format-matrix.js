// Regression: Cross-Format Hot-Switch Matrix
//
// Drives the v2 viewer (sidebar UI, no JS hash-bridge hacks) through a
// 12-visit walk over 6 fixtures — 2 per doctype — that hits every one of
// the nine type-pair transitions (writer↔calc, writer↔impress,
// calc↔impress, plus same-type W↔W / C↔C / I↔I). Each fixture is opened
// exactly twice. After each click on a sidebar entry the test checks
// the editor iframe's status field for the new doctype's pattern AND
// the parent viewer's #document-name-input for the new filename. A
// per-step screenshot lands in shots-regression-cross-format-matrix/
// so the report renders the canvas state for every cell.
//
// Walk:
//   W1 W2 C1 C2 I1 I2 W1 I1 C1 W2 C2 I2
// 11 transitions, every type-pair covered, each doc opened twice.
'use strict';

const __cl = require('../../lib/inject-checklist');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');
const {
    seedRecentFiles, waitForSidebar, clickSidebarFile,
} = require('../../lib/v2-test-helper');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-cross-format-matrix';

const FIXTURE = {
    writer:  path.join(__dirname, '..', 'test', 'data', 'test document.docx'),
    calc:    path.join(__dirname, '..', 'test', 'data', 'testdoc.xlsx'),
    impress: path.join(__dirname, '..', 'test', 'data', 'testdoc.pptx'),
};

// Each entry has a stable id used for ordering, the doctype, and the
// human-readable filename that the title-bar should display. The base
// name (without extension) must appear in #document-name-input.
const DOCS = [
    { id: 'W1', type: 'writer',  name: 'cf-writer-1.docx'  },
    { id: 'W2', type: 'writer',  name: 'cf-writer-2.docx'  },
    { id: 'C1', type: 'calc',    name: 'cf-calc-1.xlsx'    },
    { id: 'C2', type: 'calc',    name: 'cf-calc-2.xlsx'    },
    { id: 'I1', type: 'impress', name: 'cf-impress-1.pptx' },
    { id: 'I2', type: 'impress', name: 'cf-impress-2.pptx' },
];
const BY_ID = Object.fromEntries(DOCS.map(d => [d.id, d]));

// 12-visit walk. Transitions:
//   W1→W2 (WW)  W2→C1 (WC)  C1→C2 (CC)  C2→I1 (CI)
//   I1→I2 (II)  I2→W1 (IW)  W1→I1 (WI)  I1→C1 (IC)
//   C1→W2 (CW)  W2→C2 (WC)  C2→I2 (CI)
// All nine type-pairs covered; W2/C2/I2 also exercise same-type same-doc-2.
const WALK = ['W1', 'W2', 'C1', 'C2', 'I1', 'I2', 'W1', 'I1', 'C1', 'W2', 'C2', 'I2'];

const STATUS_MATCH = {
    writer:  s => /\b\d+\s+characters?\b/.test(s.wc),
    calc:    s => /Sheet\s+\d+\s+of\s+\d+/.test(s.sd),
    impress: s => /Slide\s+\d+\s+of\s+\d+/i.test((s.slideStatus || '') + ' ' + (s.sd || '')),
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

function getEditorFrame(page, requireFileId) {
    for (const fr of page.frames()) {
        const u = fr.url();
        if (u.includes('cool.html') && (!requireFileId || u.includes(requireFileId))) return fr;
    }
    return null;
}

async function getEditorStatus(page, fileId) {
    const fr = getEditorFrame(page, fileId);
    if (!fr) return null;
    try {
        return await fr.evaluate(() => ({
            wc: document.querySelector('#StateWordCount')?.textContent.trim() || '',
            sd: document.querySelector('#StatusDocPos')?.textContent.trim() || '',
            slideStatus: document.querySelector('#SlideStatus')?.textContent.trim() || '',
        }));
    } catch (_) { return null; }
}

async function getDocName(page, fileId) {
    // #document-name-input lives inside the editor iframe (cool.html), not
    // on the parent viewer page. Reading from the parent always returns
    // empty. Filter the iframe by fileId so we don't latch onto the
    // prewarm-blank's frame and read its (empty) title.
    const fr = getEditorFrame(page, fileId);
    if (!fr) return '';
    return fr.evaluate(() => {
        const input = document.querySelector('#document-name-input');
        const wopi = window.app && window.app.map && window.app.map['wopi'];
        return input?.value || (wopi && wopi.BaseFileName) || '';
    }).catch(() => '');
}

async function waitForDoctype(page, doc, timeoutMs) {
    const matcher = STATUS_MATCH[doc.type];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const s = await getEditorStatus(page, doc.fileId);
        if (s && matcher(s)) return s;
        await sleep(500);
    }
    return null;
}

async function waitForName(page, fileId, expectedBase, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
        last = await getDocName(page, fileId);
        if (last.includes(expectedBase)) return last;
        await sleep(250);
    }
    return last;
}

// Read the parent viewer's shield-drop counter (purpose-built signal,
// see viewer-public/index.html hideShield: a monotonic counter that
// increments every time #editor-shield is removed from the user's view).
async function readShieldDropCount(page) {
    return page.evaluate(() => window.__shieldDropCount || 0).catch(() => 0);
}

// Wait for the user-visible doc to actually paint. Required signals:
//   • EITHER window.__shieldDropCount > preClickCount (the parent's
//     #editor-shield dropped after our click — fires for cross-type and
//     fresh deep-link opens), OR the iframe's wasm-loading-overlay has
//     cleared (covers the same-type new-iframe path where the parent
//     shield is never raised because the in-iframe wasm-loader handles
//     the bootstrap entirely).
//   • The iframe's <canvas> has non-zero width/height — paint ran.
async function waitForCanvasPainted(page, fileId, preCount, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const fr = getEditorFrame(page, fileId);
        if (fr) {
            const dropCount = await readShieldDropCount(page);
            const shieldSignal = dropCount > preCount;
            const inner = await fr.evaluate(() => {
                const o = document.getElementById('wasm-loading-overlay');
                const overlayUp = !!o && o.offsetParent !== null
                    && getComputedStyle(o).opacity !== '0';
                const c = document.querySelector('canvas');
                return {
                    overlayUp,
                    canvasOk: !!c && c.width > 0 && c.height > 0,
                };
            }).catch(() => ({ overlayUp: true, canvasOk: false }));
            if ((shieldSignal || !inner.overlayUp) && inner.canvasOk) return true;
        }
        await sleep(200);
    }
    return false;
}

function baseName(filename) {
    return filename.replace(/\.[^.]+$/, '');
}

(async () => {
    log('=== Regression: Cross-Format Hot-Switch Matrix (v2 viewer, 6 fixtures) ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    // Sanity-check fixtures
    for (const [type, p] of Object.entries(FIXTURE)) {
        if (!fs.existsSync(p)) {
            log(`ERROR: fixture missing for ${type}: ${p}`);
            process.exit(1);
        }
    }

    // Upload all 6. Two fixtures per doctype share the same source bytes —
    // the test verifies routing/title/status, not pixel-distinct content.
    for (const doc of DOCS) {
        const bytes = fs.readFileSync(FIXTURE[doc.type]);
        const u = await uploadV2(VIEWER, doc.name, bytes);
        doc.fileId = u.fileId;
        doc.b64urlSecret = u.b64urlSecret;
        log(`  uploaded ${doc.name} (${doc.id}) → ${u.fileId.substring(0, 8)}…`);
    }

    const browser = await puppeteer.launch({
        headless: 'new',
        protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        page.on('console', m => {
            const t = m.text();
            if (/jserror|Pthread sent|unreachable|Cross-type:/.test(t)) {
                console.log('  [browser]', t.substring(0, 200));
            }
        });

        // Seed the sidebar with all 6 entries so they're visible from the
        // first paint — we never use any JS hash-bridge to drive the
        // switches; only sidebar clicks.
        await seedRecentFiles(page, DOCS.map(d => ({
            b64urlSecret: d.b64urlSecret,
            fileId: d.fileId,
            cachedName: d.name,
        })));

        // Step 0 — open the first doc via deep-link (#file=<secret>). This
        // is the only "URL-driven" step; from here on it's all sidebar
        // clicks. Equivalent to a user pasting a share link and then
        // navigating around via the sidebar.
        const first = BY_ID[WALK[0]];
        log(`\n--- Step 0: open ${first.id} (${first.name}) via #file= deep link ---`);
        const t0 = Date.now();
        // window.__shieldDropCount starts at 0 on a fresh viewer load and
        // increments on every hideShield(). For step 0 the deep-link load
        // counts as one shield up→down cycle, so we expect ≥ 1 by the time
        // the doc is painted.
        const preDrop0 = 0;
        await page.goto(VIEWER + '/#file=' + first.b64urlSecret,
            { waitUntil: 'domcontentloaded', timeout: env.scaleTimeout(60000) });
        const initStatus = await waitForDoctype(page, first, env.scaleTimeout(240000));
        check(`step 0 ${first.id}: ${first.type} status visible`, !!initStatus,
              initStatus ? '' : 'no status pattern');
        const initName = await waitForName(page, first.fileId, baseName(first.name), env.scaleTimeout(30000));
        check(`step 0 ${first.id}: title shows "${baseName(first.name)}"`,
              initName.includes(baseName(first.name)),
              `inputValue=${initName}`);
        // Two-stage settle before screenshot:
        //  (1) waitForCanvasPainted — gates on the parent's __shieldDropCount
        //      incrementing (purpose-built signal in viewer-public's
        //      hideShield) AND the iframe's wasm-loading-overlay clearing
        //      AND the canvas having non-zero dimensions (15 s budget).
        //  (2) Fixed 2 s sleep — wasm-loader fires updateProgress('Ready',100)
        //      150 ms before hideOverlay(), whose opacity transition is 0.4 s
        //      with a +500 ms DOM-removal delay. iframe-pool revive can also
        //      re-display the overlay briefly. 2 s clears every observed tail.
        await waitForCanvasPainted(page, first.fileId, preDrop0, env.scaleTimeout(15000));
        await sleep(2000);
        await page.screenshot({ path: `${SHOT_DIR}/00_${first.id}_${first.type}.png` });
        log(`step 0 done in ${Date.now() - t0}ms`);

        // Walk the remaining 11 transitions, sidebar-click only.
        for (let i = 1; i < WALK.length; i++) {
            const prev = BY_ID[WALK[i - 1]];
            const next = BY_ID[WALK[i]];
            const tag = `${prev.id}(${prev.type})→${next.id}(${next.type})`;
            log(`\n--- Step ${i}: ${tag} ---`);

            // Sidebar collapses after each open; expand it before clicking.
            await page.evaluate(() => document.body.classList.remove('docs-collapsed'));
            try {
                await waitForSidebar(page, next.fileId, env.scaleTimeout(15000));
            } catch (e) {
                check(`step ${i} ${tag}: sidebar entry visible`, false, e.message);
                await page.screenshot({ path: `${SHOT_DIR}/${String(i).padStart(2, '0')}_${next.id}_${next.type}_FAIL.png` });
                continue;
            }

            // Snapshot the shield-drop counter before the click so the
            // post-click wait can require it to increment (and not be
            // satisfied by a previous cell's drop).
            const preDrop = await readShieldDropCount(page);
            const tCell = Date.now();
            await clickSidebarFile(page, next.fileId);

            // Wait for the editor iframe to reflect the new doctype.
            // Doctype-specific budget — impress cold-load on Azure under
            // contention (JOBS=2) routinely runs 240-360 s, exceeding
            // the 180 s base used for writer/calc. Step 4 (calc→impress
            // first impress encounter) timed out at 360 s in
            // local-2026-05-07-27 while every subsequent step completed
            // in under 1 s. Impress gets a 360 s base (= 720 s under
            // JOBS=2) — 2× the observed worst-case; writer/calc stay at
            // 180 s since they cold-load in 30-60 s.
            const baseBudgetMs = next.type === 'impress' ? 360000 : 180000;
            const status = await waitForDoctype(page, next, env.scaleTimeout(baseBudgetMs));
            const dt = Date.now() - tCell;

            // Check the title bar, with its own settle window — the title
            // can lag the doc-loaded signal by a few seconds.
            const observed = status ? await waitForName(page, next.fileId, baseName(next.name),
                env.scaleTimeout(30000)) : await getDocName(page, next.fileId);

            // Wait for the iframe-pool's swap to actually paint before
            // screenshotting. The status field + title bar populate well
            // before #wasm-loading-overlay clears, so a screenshot taken
            // right after the assertions captures the "Ready" splash on
            // fast (≤1 s) cross-type / warm-restore swaps.
            if (status) {
                await waitForCanvasPainted(page, next.fileId, preDrop, env.scaleTimeout(15000));
                await sleep(2000);
            }

            const stepNum = String(i).padStart(2, '0');
            const suffix = status && observed.includes(baseName(next.name)) ? '' : '_FAIL';
            await page.screenshot({
                path: `${SHOT_DIR}/${stepNum}_${next.id}_${next.type}${suffix}.png`,
            });

            check(`step ${i} ${tag}: ${next.type} status visible (${dt}ms)`, !!status,
                  status ? '' : `no status pattern in ${env.scaleTimeout(180000) / 1000}s`);
            check(`step ${i} ${tag}: title shows "${baseName(next.name)}"`,
                  observed.includes(baseName(next.name)),
                  `inputValue=${observed}`);
        }

        await page.close();
    } catch (e) {
        log(`ERROR: ${e.stack || e.message}`);
        allPassed = false;
    } finally {
        await browser.close();
    }

    log('\n' + '='.repeat(50));
    log(allPassed ? '✓ ALL TRANSITIONS PASS' : '✗ SOME TRANSITIONS FAILED');
    log('='.repeat(50));
    process.exit(allPassed ? 0 : 1);
})();
