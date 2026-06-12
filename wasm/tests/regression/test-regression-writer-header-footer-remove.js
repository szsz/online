// Regression: Writer header/footer must be removable via the
// Format → Page Style dialog — smoke-level round-trip save check.
//
// Bug (LO core): in LOK mode, SwWrtShell::ChangeHeaderOrFooter
// (sw/source/uibase/wrtsh/wrtsh1.cxx:2298-2317) tried to surface a
// modal warning dialog (DeleteHeaderDialog) when the user un-ticked
// the Header-on checkbox. GetView().GetFrameWeld() returns null in
// LOK, so .run() returned RET_CANCEL synchronously → bExecute=false →
// the SetFormatAttr that toggles the header off was skipped → the
// header survived. User-visible symptom: ticking Header on, Apply,
// re-opening the dialog, un-ticking, Apply leaves the header in the
// saved .docx.
//
// Fix: LO PR https://github.com/szsz/libreoffice-core-wasm/pull/30
// (merged 2026-05-29) — short-circuits bShowWarning=false when
// LibreOfficeKit::isActive() is true. Two-line LOK gate.
//
// Smoke shape:
//   1. Upload a fresh new.docx via the viewer.
//   2. Open Page Style dialog (Format tab → Page Style bigtoolitem),
//      Header tab, tick "Header on", Apply, close.
//   3. Ctrl+S → poll /api/v2/file/<id> → unzip downloaded docx →
//      assert <w:headerReference> + word/header*.xml ARE present.
//   4. Re-open Page Style → Header tab, untick "Header on", Apply,
//      close.
//   5. Ctrl+S → unzip → assert <w:headerReference> + word/header*.xml
//      are NOT present.
//
// Skipped vs. the full task doc (task says "smoke-level"):
//   - Don't re-assert the checkbox-state-on-reopen — only the
//     round-trip-save XML check.
//
// All interactions go through real puppeteer page.mouse.click +
// page.keyboard (no sendUnoCommand, no app.dispatcher.dispatch,
// no page.evaluate(()=>el.click())) — per /write-test rules.

'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yauzl = require('yauzl');
const __cl = require('../../lib/inject-checklist');
const env = require('../../lib/test-env');
const { openViaViewer } = require('../../lib/open-via-viewer');
const { downloadV2 } = require('../../lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const DOC_NAME = 'header-remove-' + Date.now() + '.docx';
const DOC_PATH = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-writer-header-footer-remove';

const T0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch (_) {}
}

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  PASS: ${label}`);
    else { log(`  FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
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

// Click an element inside the iframe via real page.mouse.click. Computing
// iframe-relative coords + dispatching through the page's pointer pipeline
// triggers the notebookbar tab/button handlers reliably; frame.click()
// fires synthetic clicks that miss some handlers.
async function clickInFrame(frame, page, selector) {
    const rect = await frame.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, selector);
    if (!rect || rect.w <= 0) {
        throw new Error('clickInFrame: ' + selector + ' not visible');
    }
    const iframeEl = await page.$('iframe#editor-frame');
    const ifBox = await iframeEl.boundingBox();
    await page.mouse.click(ifBox.x + rect.x + rect.w / 2,
                           ifBox.y + rect.y + rect.h / 2);
}

async function openPageDialog(frame, page) {
    await frame.waitForSelector('#Format-tab-label',
        { visible: true, timeout: env.scaleTimeout(15000) });
    await clickInFrame(frame, page, '#Format-tab-label');
    await sleep(env.scaleTimeout(800));
    const selected = await frame.evaluate(() => {
        const t = document.querySelector('#Format-tab-label');
        return t && (t.className || '').includes('selected');
    });
    if (!selected) {
        await clickInFrame(frame, page, '#Format-tab-label');
        await sleep(env.scaleTimeout(800));
    }
    await frame.waitForFunction(() => {
        const t = document.querySelector('#Format-tab-label');
        return t && (t.className || '').includes('selected');
    }, { timeout: env.scaleTimeout(15000) });

    // Page Style bigtoolitem has a generated numeric id; the inner button's
    // aria-label="Page Style" is the stable lookup. Clear any cached id
    // from a previous openPageDialog call — the notebookbar re-renders
    // after Apply+save and the button id may have changed.
    //
    // RETRY LOOP (2026-06-12): after Phase 1's Apply + save round-trip
    // the notebookbar can re-render into a state where the Format tab
    // reads `selected` but its toolbar CONTENT never painted — the
    // Page Style button exists with zero size and a single long wait
    // times out (CI builds 2026-06-10..12, line-146 TimeoutError).
    // Re-clicking the tab forces a content render; three short rounds
    // beat one long wait against a render that will never happen.
    await frame.evaluate(() => { delete window.__pageDialogBtnId; });
    let pageStyleVisible = false;
    for (let attempt = 0; attempt < 3 && !pageStyleVisible; attempt++) {
        if (attempt > 0) {
            await clickInFrame(frame, page, '#Format-tab-label');
            await sleep(env.scaleTimeout(800));
        }
        pageStyleVisible = await frame.waitForFunction(() => {
            const btns = [...document.querySelectorAll('button[aria-label="Page Style"]')];
            const v = btns.find(b => b.offsetWidth > 0 && b.offsetHeight > 0);
            if (v) { window.__pageDialogBtnId = v.id; return true; }
            return false;
        }, { timeout: env.scaleTimeout(8000) }).then(() => true).catch(() => false);
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
    }, { timeout: env.scaleTimeout(20000) });
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
            }, { timeout: env.scaleTimeout(8000) });
        } catch (_) { /* retry */ }
        await sleep(env.scaleTimeout(1000));
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
    // forwards the label click to the associated <input>, dispatching the
    // change event jsdialog relays to LO core.
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
    const iframeEl = await page.$('iframe#editor-frame');
    const ifBox = await iframeEl.boundingBox();
    await page.mouse.click(ifBox.x + rect.x + Math.min(rect.w / 2, 30),
                           ifBox.y + rect.y + rect.h / 2);
}

async function clickApplyAndClose(frame, page) {
    await clickInFrame(frame, page, '#apply-button');
    await sleep(env.scaleTimeout(2000));
    try { await clickInFrame(frame, page, '#cancel-button'); } catch (_) {}
    await frame.waitForFunction(() =>
        !document.querySelector(
            '[role="dialog"].lokdialog_container, .jsdialog-container[role="dialog"]'),
        { timeout: env.scaleTimeout(10000) }).catch(() => {});
}

async function saveAndWaitForRotation(page, fileId, prevHash) {
    await page.bringToFront();
    await page.keyboard.down('Control');
    await page.keyboard.press('s');
    await page.keyboard.up('Control');

    const deadline = Date.now() + env.scaleTimeout(60000);
    let last = prevHash;
    while (Date.now() < deadline) {
        try {
            const ct = await page.evaluate(async (id) => {
                const r = await fetch('/api/v2/file/' + id);
                if (!r.ok) return '';
                const j = await r.json();
                return j.ciphertext || '';
            }, fileId);
            const h = ct ? crypto.createHash('sha256').update(ct).digest('hex') : '';
            if (h && h !== prevHash) return { rotated: true, hash: h };
            last = h;
        } catch (_) {}
        await sleep(800);
    }
    return { rotated: false, hash: last };
}

const hasHeaderRef = (xml) => /<w:headerReference\b/.test(xml || '');
const headerEntries = (entries) => entries.filter(n => /^word\/header[0-9]*\.xml$/.test(n));

(async () => {
    log('=== Regression: Writer header/footer remove via Page Style → smoke ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(DOC_PATH)) {
        log('ERROR: fixture missing: ' + DOC_PATH);
        process.exit(1);
    }

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    try {
        const bytes = fs.readFileSync(DOC_PATH);
        const baseline = await listAndReadDocx(bytes);
        check('Baseline fixture has NO <w:headerReference>',
              !hasHeaderRef(baseline.contents['word/document.xml']));
        check('Baseline fixture has NO word/header*.xml',
              headerEntries(baseline.entries).length === 0);

        const up = await openViaViewer(browser, VIEWER, DOC_NAME, bytes, {
            iframeTimeout: env.scaleTimeout(120000),
            gotoTimeout: env.scaleTimeout(60000),
            isolatedContext: true,
            viewport: { width: 1920, height: 1080 },
        });
        await up.page.setViewport({ width: 1920, height: 1080 });
        const frame = up.editorFrame;
        log('Uploaded fileId=' + up.fileId.substring(0, 8));

        await frame.waitForFunction(() => {
            const wc = document.querySelector('#StateWordCount');
            return !!(wc && wc.textContent && wc.textContent.includes('characters'));
        }, { timeout: env.scaleTimeout(180000) });
        log('Editor ready');
        await snap(up.page, 'editor_ready');

        const initialCt = await up.page.evaluate(async (id) => {
            const r = await fetch('/api/v2/file/' + id);
            return r.ok ? (await r.json()).ciphertext : '';
        }, up.fileId);
        const initialHash = crypto.createHash('sha256').update(initialCt || '').digest('hex');

        // ── Phase 1: header ON ─────────────────────────────────────────
        log('--- Phase 1: Format → Page Style → Header → tick Header on → Apply ---');
        await openPageDialog(frame, up.page);
        await clickHeaderTab(frame, up.page);
        await snap(up.page, 'header_tab_p1');
        await sleep(env.scaleTimeout(800));
        await clickHeaderCheckbox(frame, up.page);
        await sleep(env.scaleTimeout(1500));
        await snap(up.page, 'header_on');
        await clickApplyAndClose(frame, up.page);
        await snap(up.page, 'after_apply_on');

        const save1 = await saveAndWaitForRotation(up.page, up.fileId, initialHash);
        check('Phase 1 save: ciphertext rotated after header-on Apply',
              save1.rotated,
              'prev=' + initialHash.substring(0, 8) + ' new=' + (save1.hash || '').substring(0, 8));

        const after1 = await downloadV2(VIEWER, up.upload.secret);
        const z1 = await listAndReadDocx(after1.bytes);
        check('Phase 1: saved docx HAS <w:headerReference>',
              hasHeaderRef(z1.contents['word/document.xml']));
        check('Phase 1: saved docx HAS word/header*.xml entry',
              headerEntries(z1.entries).length > 0,
              'entries: ' + headerEntries(z1.entries).join(','));

        // ── Phase 2: header OFF (the bug surface; should now pass post-LO-fix) ──
        log('--- Phase 2: Format → Page Style → Header → untick Header on → Apply ---');
        // Notebookbar re-renders after Phase 1 save; let the DOM settle
        // before openPageDialog re-resolves the Page Style button id.
        await sleep(env.scaleTimeout(1000));
        await openPageDialog(frame, up.page);
        await clickHeaderTab(frame, up.page);
        await snap(up.page, 'header_tab_p2');
        await sleep(env.scaleTimeout(800));
        await clickHeaderCheckbox(frame, up.page);
        await sleep(env.scaleTimeout(1500));
        await snap(up.page, 'header_off');
        await clickApplyAndClose(frame, up.page);
        await snap(up.page, 'after_apply_off');

        // Nudge dirty so a subsequent Ctrl+S definitely round-trips even
        // if header-off was a no-op (which is exactly the pre-fix bug).
        try {
            const iframeEl = await up.page.$('iframe#editor-frame');
            const ifBox = await iframeEl.boundingBox();
            await up.page.mouse.click(ifBox.x + 600, ifBox.y + 400);
            await sleep(400);
            await up.page.keyboard.press('End');
            await up.page.keyboard.press('Space');
            await sleep(150);
            await up.page.keyboard.press('Backspace');
            await sleep(300);
        } catch (_) {}

        const save2 = await saveAndWaitForRotation(up.page, up.fileId,
            save1.hash || initialHash);
        check('Phase 2 save: ciphertext rotated after header-off Apply',
              save2.rotated,
              'prev=' + (save1.hash || '').substring(0, 8) + ' new=' + (save2.hash || '').substring(0, 8));

        const after2 = await downloadV2(VIEWER, up.upload.secret);
        const z2 = await listAndReadDocx(after2.bytes);
        check('Phase 2: saved docx has NO <w:headerReference> (header removed)',
              !hasHeaderRef(z2.contents['word/document.xml']));
        check('Phase 2: saved docx has NO word/header*.xml (header removed)',
              headerEntries(z2.entries).length === 0,
              'entries still present: ' + headerEntries(z2.entries).join(','));

        log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    } catch (e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        await browser.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
