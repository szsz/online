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

const __cl = require('./lib/inject-checklist');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');
const {
    seedRecentFiles, waitForSidebar, clickSidebarFile,
} = require('./lib/v2-test-helper');

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

async function getDocName(page) {
    return page.evaluate(() =>
        document.querySelector('#document-name-input')?.value || ''
    ).catch(() => '');
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

async function waitForName(page, expectedBase, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
        last = await getDocName(page);
        if (last.includes(expectedBase)) return last;
        await sleep(250);
    }
    return last;
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
        await page.goto(VIEWER + '/#file=' + first.b64urlSecret,
            { waitUntil: 'domcontentloaded', timeout: env.scaleTimeout(60000) });
        const initStatus = await waitForDoctype(page, first, env.scaleTimeout(240000));
        check(`step 0 ${first.id}: ${first.type} status visible`, !!initStatus,
              initStatus ? '' : 'no status pattern');
        const initName = await waitForName(page, baseName(first.name), env.scaleTimeout(30000));
        check(`step 0 ${first.id}: title shows "${baseName(first.name)}"`,
              initName.includes(baseName(first.name)),
              `inputValue=${initName}`);
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

            const tCell = Date.now();
            await clickSidebarFile(page, next.fileId);

            // Wait for the editor iframe to reflect the new doctype.
            const status = await waitForDoctype(page, next, env.scaleTimeout(120000));
            const dt = Date.now() - tCell;

            // Check the title bar, with its own settle window — the title
            // can lag the doc-loaded signal by a few seconds.
            const observed = status ? await waitForName(page, baseName(next.name),
                env.scaleTimeout(30000)) : await getDocName(page);

            const stepNum = String(i).padStart(2, '0');
            const suffix = status && observed.includes(baseName(next.name)) ? '' : '_FAIL';
            await page.screenshot({
                path: `${SHOT_DIR}/${stepNum}_${next.id}_${next.type}${suffix}.png`,
            });

            check(`step ${i} ${tag}: ${next.type} status visible (${dt}ms)`, !!status,
                  status ? '' : `no status pattern in ${env.scaleTimeout(120000) / 1000}s`);
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
