// test-cv-regression-writer-header-footer-remove.js — Writer header must be
// removable via the Format → Page Style dialog; smoke round-trip save check.
//
// Bug (LO core): in LOK mode SwWrtShell::ChangeHeaderOrFooter surfaced a
// modal DeleteHeaderDialog when un-ticking "Header on"; GetFrameWeld() is
// null under LOK so .run() returned RET_CANCEL synchronously → the
// SetFormatAttr that flips the header off was skipped → the header survived
// in the saved .docx. Fix: LO PR #30 gates bShowWarning on
// !LibreOfficeKit::isActive().
//
// WHAT IS VERIFIED (same subject as the legacy test):
//   0. Baseline fixture has NO <w:headerReference> / word/header*.xml.
//   1. Format tab → Page Style → Header tab → tick "Header on" → Apply →
//      save → the saved docx HAS <w:headerReference> + word/header*.xml.
//   2. Re-open the dialog → untick "Header on" → Apply → save → the saved
//      docx has NEITHER (the bug surface).
//
// Harness change vs legacy: save + readback used Ctrl+S → v2 ciphertext
// rotation → downloadV2. In the content viewer the tester's Save button
// exports the document as a browser download — we capture it via CDP
// Browser.setDownloadBehavior and unzip the downloaded bytes. The
// dirty-nudge before phase 2 is dropped: CV Save always exports the current
// document state (no rotation gate). All dialog interaction is real
// puppeteer mouse + keyboard.
//
// Migrated from wasm/tests/regression/test-regression-writer-header-footer-remove.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-regression-writer-header-footer-remove.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, waitCvInteractive } = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOCX = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const DL_DIR = '/tmp/cv-header-remove-downloads';
const SHOT_DIR = '/tmp/content-viewer-report/regression-writer-header-footer-remove';

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
const editorFrame = page => page.frames().find(f => (f.url() || '').includes('cool.html'));
let shotN = 0;
async function snap(page, name) {
    try { fs.mkdirSync(SHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${SHOT_DIR}/${String(++shotN).padStart(2, '0')}_${name}.png` }); } catch (_) {}
}

// In-memory docx unzip — reads only the small XML files we need.
function listAndReadDocx(bytes) {
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(bytes, { lazyEntries: true }, (err, zip) => {
            if (err) return reject(err);
            const entries = [];
            const contents = {};
            zip.on('error', reject);
            zip.on('end', () => resolve({ entries, contents }));
            zip.on('entry', (entry) => {
                entries.push(entry.fileName);
                if (/^word\/(document|header[0-9]*|footer[0-9]*)\.xml$/.test(entry.fileName)) {
                    zip.openReadStream(entry, (e2, rs) => {
                        if (e2) return reject(e2);
                        const chunks = [];
                        rs.on('data', c => chunks.push(c));
                        rs.on('end', () => {
                            contents[entry.fileName] = Buffer.concat(chunks).toString('utf8');
                            zip.readEntry();
                        });
                        rs.on('error', reject);
                    });
                } else {
                    zip.readEntry();
                }
            });
            zip.readEntry();
        });
    });
}

const hasHeaderRef = (xml) => /<w:headerReference\b/.test(xml || '');
const headerEntries = (entries) => entries.filter(n => /^word\/header[0-9]*\.xml$/.test(n));

// Click an element inside the (same-origin) editor iframe via real
// page.mouse.click at page coordinates.
async function clickInFrame(frame, page, selector) {
    const rect = await frame.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, selector);
    if (!rect || rect.w <= 0) throw new Error('clickInFrame: ' + selector + ' not visible');
    const ifEl = await page.$('iframe');
    const ifBox = await ifEl.boundingBox();
    await page.mouse.click(ifBox.x + rect.x + rect.w / 2, ifBox.y + rect.y + rect.h / 2);
}

async function openPageDialog(frame, page) {
    await frame.waitForSelector('#Format-tab-label', { visible: true, timeout: 20000 });
    await clickInFrame(frame, page, '#Format-tab-label');
    await sleep(800);
    const selected = await frame.evaluate(() => {
        const t = document.querySelector('#Format-tab-label');
        return t && (t.className || '').includes('selected');
    });
    if (!selected) {
        await clickInFrame(frame, page, '#Format-tab-label');
        await sleep(800);
    }
    await frame.waitForFunction(() => {
        const t = document.querySelector('#Format-tab-label');
        return t && (t.className || '').includes('selected');
    }, { timeout: 20000 });

    // Page Style bigtoolitem has a generated numeric id; the inner button's
    // aria-label="Page Style" is the stable lookup. The notebookbar can
    // re-render after Apply+save into a state where the Format tab reads
    // `selected` but its content never painted — re-clicking the tab forces
    // a content render; three short rounds beat one long wait.
    await frame.evaluate(() => { delete window.__pageDialogBtnId; });
    let pageStyleVisible = false;
    for (let attempt = 0; attempt < 3 && !pageStyleVisible; attempt++) {
        if (attempt > 0) {
            await clickInFrame(frame, page, '#Format-tab-label');
            await sleep(800);
        }
        pageStyleVisible = await frame.waitForFunction(() => {
            const btns = [...document.querySelectorAll('button[aria-label="Page Style"]')];
            const v = btns.find(b => b.offsetWidth > 0 && b.offsetHeight > 0);
            if (v) { window.__pageDialogBtnId = v.id; return true; }
            return false;
        }, { timeout: 10000 }).then(() => true).catch(() => false);
    }
    if (!pageStyleVisible) {
        throw new Error('openPageDialog: Page Style button never became visible '
            + 'after 3 tab re-click attempts (notebookbar content render stuck)');
    }
    const sel = await frame.evaluate(() => '#' + window.__pageDialogBtnId);
    await clickInFrame(frame, page, sel);

    await frame.waitForFunction(() => {
        const dlg = document.querySelector(
            '[role="dialog"].lokdialog_container, .jsdialog-container[role="dialog"]');
        return !!(dlg && dlg.querySelector('#header[role="tab"]'));
    }, { timeout: 30000 });
}

async function clickHeaderTab(frame, page) {
    // LO's tabcontrol selecttab can race a JSON refresh and bounce back to
    // General; click+settle+verify up to 4 times.
    for (let attempt = 0; attempt < 4; attempt++) {
        await clickInFrame(frame, page, '#header[role="tab"]');
        try {
            await frame.waitForFunction(() => {
                const t = document.querySelector('#header[role="tab"]');
                if (!t || t.getAttribute('aria-selected') !== 'true') return false;
                const panel = document.querySelector('#Header[role="tabpanel"]');
                return !!(panel && panel.querySelector('#checkHeaderOn-input'));
            }, { timeout: 10000 });
        } catch (_) { /* retry */ }
        await sleep(1000);
        const stable = await frame.evaluate(() => {
            const t = document.querySelector('#header[role="tab"]');
            return !!(t && t.getAttribute('aria-selected') === 'true');
        });
        if (stable) return;
    }
    throw new Error('Header tab kept flipping back after 4 attempts');
}

async function clickHeaderCheckbox(frame, page) {
    // Click the <label for="checkHeaderOn-input"> — the browser natively
    // forwards the label click to the input, dispatching the change event
    // jsdialog relays to LO core.
    const rect = await frame.evaluate(() => {
        const panel = document.querySelector('#Header[role="tabpanel"]');
        const root = panel || document;
        const lbl = root.querySelector('#checkHeaderOn-label')
            || root.querySelector('label[for="checkHeaderOn-input"]');
        if (!lbl) return null;
        const r = lbl.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    if (!rect || rect.w <= 0) throw new Error('checkHeaderOn-label not visible');
    const ifEl = await page.$('iframe');
    const ifBox = await ifEl.boundingBox();
    await page.mouse.click(ifBox.x + rect.x + Math.min(rect.w / 2, 30),
        ifBox.y + rect.y + rect.h / 2);
}

async function clickApplyAndClose(frame, page) {
    await clickInFrame(frame, page, '#apply-button');
    await sleep(2500);
    try { await clickInFrame(frame, page, '#cancel-button'); } catch (_) {}
    await frame.waitForFunction(() =>
        !document.querySelector(
            '[role="dialog"].lokdialog_container, .jsdialog-container[role="dialog"]'),
        { timeout: 15000 }).catch(() => {});
}

// Click the tester's Save button (real click) and wait for a NEW .docx
// download to land + settle in DL_DIR. Returns { ok, file, ev }.
async function saveViaTester(page) {
    const before = new Set(fs.readdirSync(DL_DIR));
    const h = await page.evaluateHandle(() =>
        [...document.querySelectorAll('button')]
            .find(b => /^save$/i.test((b.textContent || '').trim())));
    const el = h.asElement();
    if (!el) return { ok: false, file: null, ev: 'Save button not found' };
    await el.click();
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        const cand = fs.readdirSync(DL_DIR)
            .filter(f => /\.docx$/i.test(f) && !f.endsWith('.crdownload') && !before.has(f));
        if (cand.length) {
            const f = path.join(DL_DIR, cand[0]);
            const s1 = fs.statSync(f).size;
            await sleep(700);
            const s2 = fs.statSync(f).size;
            if (s1 > 0 && s1 === s2) return { ok: true, file: f, ev: s2 + ' bytes' };
        }
        await sleep(500);
    }
    return { ok: false, file: null, ev: 'no new .docx download within 60s' };
}

(async () => {
    if (!fs.existsSync(DOCX)) { check('fixture present', false, DOCX); process.exit(2); }
    log('=== Regression: Writer header/footer remove via Page Style (content viewer) ===');
    log('viewer: ' + BASE);
    fs.rmSync(DL_DIR, { recursive: true, force: true });
    fs.mkdirSync(DL_DIR, { recursive: true });

    const { browser } = await launch({ headless: 'new', width: 1920, height: 1080 });
    try {
        const bytes = fs.readFileSync(DOCX);
        const baseline = await listAndReadDocx(bytes);
        check('Baseline fixture has NO <w:headerReference>',
            !hasHeaderRef(baseline.contents['word/document.xml']));
        check('Baseline fixture has NO word/header*.xml',
            headerEntries(baseline.entries).length === 0);

        const page = await browser.newPage();
        const cdp = await page.target().createCDPSession();
        try {
            await cdp.send('Browser.setDownloadBehavior',
                { behavior: 'allow', downloadPath: DL_DIR, eventsEnabled: true });
        } catch (e) { log('setDownloadBehavior failed: ' + e.message); }

        await openViaContentViewer(browser, BASE, DOCX, {
            page, viewport: { width: 1920, height: 1080 }, iframeTimeout: 60000,
        });
        check('editor interactive', await waitCvInteractive(page, LOAD_BUDGET));
        const frame = editorFrame(page);
        if (!frame) throw new Error('editor frame never loaded');
        await frame.waitForFunction(() => {
            const wc = document.querySelector('#StateWordCount');
            return !!(wc && wc.textContent && wc.textContent.includes('characters'));
        }, { timeout: 60000 });
        log('Editor ready');
        await sleep(2000);
        await snap(page, 'editor_ready');

        // ── Phase 1: header ON ─────────────────────────────────────────
        log('--- Phase 1: Format → Page Style → Header → tick Header on → Apply ---');
        await openPageDialog(frame, page);
        await clickHeaderTab(frame, page);
        await snap(page, 'header_tab_p1');
        await sleep(800);
        await clickHeaderCheckbox(frame, page);
        await sleep(1500);
        await snap(page, 'header_on');
        await clickApplyAndClose(frame, page);
        await snap(page, 'after_apply_on');

        const save1 = await saveViaTester(page);
        check('Phase 1 save: tester Save produced a downloaded .docx',
            save1.ok, save1.ev);
        if (!save1.ok) throw new Error('phase 1 save failed — cannot verify');
        const z1 = await listAndReadDocx(fs.readFileSync(save1.file));
        check('Phase 1: saved docx HAS <w:headerReference>',
            hasHeaderRef(z1.contents['word/document.xml']));
        check('Phase 1: saved docx HAS word/header*.xml entry',
            headerEntries(z1.entries).length > 0,
            'entries: ' + headerEntries(z1.entries).join(','));

        // ── Phase 2: header OFF (the bug surface) ──────────────────────
        log('--- Phase 2: Format → Page Style → Header → untick Header on → Apply ---');
        // Notebookbar re-renders after Phase 1; let the DOM settle before
        // openPageDialog re-resolves the Page Style button id.
        await sleep(1500);
        await openPageDialog(frame, page);
        await clickHeaderTab(frame, page);
        await snap(page, 'header_tab_p2');
        await sleep(800);
        await clickHeaderCheckbox(frame, page);
        await sleep(1500);
        await snap(page, 'header_off');
        await clickApplyAndClose(frame, page);
        await snap(page, 'after_apply_off');

        const save2 = await saveViaTester(page);
        check('Phase 2 save: tester Save produced a downloaded .docx',
            save2.ok, save2.ev);
        if (!save2.ok) throw new Error('phase 2 save failed — cannot verify');
        const z2 = await listAndReadDocx(fs.readFileSync(save2.file));
        check('Phase 2: saved docx has NO <w:headerReference> (header removed)',
            !hasHeaderRef(z2.contents['word/document.xml']));
        check('Phase 2: saved docx has NO word/header*.xml (header removed)',
            headerEntries(z2.entries).length === 0,
            'entries still present: ' + headerEntries(z2.entries).join(','));
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
