// Regression: in Writer (docx), the user CANNOT remove a header once it
// has been added via Format > Page Style → Header tab → Header on checkbox.
// Toggling the "Header on" checkbox back off and clicking Apply leaves
// the header in the document.
//
// Root cause is in LO core (libreoffice-core-wasm)
// sw/source/uibase/wrtsh/wrtsh1.cxx:2298-2306: when bShowWarning is true
// and the user is about to delete a header,
//
//     weld::Window* pParent = GetView().GetFrameWeld();
//     short nResult;
//     if (bHeader) {
//         nResult = DeleteHeaderDialog(pParent).run();
//     } else {
//         nResult = DeleteFooterDialog(pParent).run();
//     }
//     bExecute = nResult == RET_YES;
//
// In LOK mode `pParent` is null, the modal weld dialog can't surface,
// `run()` returns RET_CANCEL → `bExecute = false` → the SetFormatAttr
// call that flips the header off is skipped. The header survives.
//
// The fix (future iter) is to short-circuit `bShowWarning = false` when
// `LibreOfficeKit::isActive()` is true so the deletion proceeds without
// the (un-renderable) confirmation modal. This test is written BEFORE
// the LO fix lands — so the "header removed after second Apply"
// assertion is EXPECTED TO FAIL on current dev, and the earlier
// "header added by first Apply" assertions are EXPECTED TO PASS.
//
// What this test asserts (all via the user-visible surface — clicks,
// keystrokes, saved-doc XML):
//   1. The .uno:PageDialog menubutton on the notebookbar's Format tab
//      opens the Page Style modal in the editor iframe.
//   2. Clicking the Header tab in the dialog reveals the "Header on"
//      checkbox unchecked.
//   3. Clicking the checkbox + clicking Apply produces a docx whose
//      word/document.xml contains a <w:headerReference> AND a
//      word/header1.xml (or header2.xml) is present in the zip.
//   4. Re-opening the same dialog, the checkbox is checked.
//   5. Clicking the checkbox off + clicking Apply produces a docx
//      whose word/document.xml has NO <w:headerReference> and the
//      zip has NO word/header*.xml. ← THIS IS THE BUG'S SURFACE.

'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const __cl = require('./lib/inject-checklist');
const env = require('./lib/test-env');
const { openViaViewer } = require('./lib/open-via-viewer');
const { downloadV2 } = require('./lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const DOC_NAME = 'header-remove-' + Date.now() + '.docx';
const DOC_PATH = path.join(__dirname, '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-writer-header-footer-remove';

const T0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch (_) {}
    log(`[snap] ${f}`);
}

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  PASS: ${label}`);
    else { log(`  FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

// ── Unzip helper (yauzl, in-memory) ─────────────────────────────────────
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
                // Read the small text XML files we care about.
                if (/^word\/(document|styles|settings|header[0-9]*|footer[0-9]*|_rels\/document\.xml\.rels)\.xml$/.test(entry.fileName)) {
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

// Click an element inside the iframe by computing iframe-relative coords
// and driving a real pointer event through the parent page. frame.click
// fires a synthetic click on the element directly, but the notebookbar
// tab handler in Control.NotebookbarBuilder.js is bound to a flow that
// only fires reliably for a real mouseup/click sequence dispatched
// through the OS-level pointer pipeline — page.mouse.click is what gets
// the tab selected. Same for the Page Style menu button (a JSDialog
// `bigtoolitem` whose -button suffix gets a generated numeric id like
// 'format-page-dialog493-button').
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

// ── Open the Page Style dialog via real notebookbar clicks ─────────────
async function openPageDialog(frame, page) {
    // 1. Click the Format tab in the notebookbar so the Page Style
    //    bigtoolitem becomes visible.
    await frame.waitForSelector('#Format-tab-label', { visible: true, timeout: env.scaleTimeout(15000) });
    // Diagnostic: log iframe box + tab rect so we can tell whether the
    // click ended up in the right pixel.
    const _dbg = await frame.evaluate(() => {
        const t = document.querySelector('#Format-tab-label');
        const r = t ? t.getBoundingClientRect() : null;
        const iw = window.innerWidth, ih = window.innerHeight;
        return { r, iw, ih, cls: t ? t.className : 'no-tab' };
    });
    const _ifEl = await page.$('iframe#editor-frame');
    const _ifBox = _ifEl ? await _ifEl.boundingBox() : null;
    log('[diag] Format-tab rect=' + JSON.stringify(_dbg) + ' iframeBox=' + JSON.stringify(_ifBox));
    await clickInFrame(frame, page, '#Format-tab-label');
    // Sometimes a single click toggles collapse instead of switching;
    // give it a beat then retry if still not selected.
    await sleep(800);
    let _selected = await frame.evaluate(() => {
        const t = document.querySelector('#Format-tab-label');
        return t && (t.className || '').includes('selected');
    });
    log('[diag] Format-tab after first click selected=' + _selected);
    if (!_selected) {
        await clickInFrame(frame, page, '#Format-tab-label');
        await sleep(800);
        _selected = await frame.evaluate(() => {
            const t = document.querySelector('#Format-tab-label');
            return t && (t.className || '').includes('selected');
        });
        log('[diag] Format-tab after second click selected=' + _selected);
    }
    await frame.waitForFunction(() => {
        const t = document.querySelector('#Format-tab-label');
        return t && (t.className || '').includes('selected');
    }, { timeout: env.scaleTimeout(15000) });

    // 2. Click the Page Style button. Its DOM id has a generated numeric
    //    suffix (id^='format-page-dialog' ... '-button'). Multiple
    //    .unoPageDialog wrappers exist (Layout tab variant + Format tab
    //    variant); pick the VISIBLE one regardless of which tab placed
    //    it. The aria-label of the inner button is the stable lookup.
    let pageDialogSelector = null;
    await frame.waitForFunction(() => {
        const btns = [...document.querySelectorAll('button[aria-label="Page Style"]')];
        const visible = btns.find(b => b.offsetWidth > 0 && b.offsetHeight > 0);
        if (visible) { window.__pageDialogBtnId = visible.id; return true; }
        return false;
    }, { timeout: env.scaleTimeout(15000) });
    pageDialogSelector = await frame.evaluate(() => '#' + window.__pageDialogBtnId);
    await clickInFrame(frame, page, pageDialogSelector);

    // 3. Wait for the modal page-style dialog to render with the Header
    //    + Footer tabs present.
    await frame.waitForFunction(() => {
        const dlg = document.querySelector('[role="dialog"].lokdialog_container, .jsdialog-container[role="dialog"]');
        if (!dlg) return false;
        return !!dlg.querySelector('#header[role="tab"]')
            && !!dlg.querySelector('#footer[role="tab"]');
    }, { timeout: env.scaleTimeout(20000) });
}

async function clickHeaderTab(frame, page) {
    // LO core's tabcontrol selecttab callback can race a JSON refresh
    // that LO is sending for an earlier interaction — the result is
    // that ~800 ms after a single click the dialog visually flips back
    // to General. Click + wait + verify; if the tab is back to General,
    // click again. Stop only when the tab stays selected for ~1.5 s.
    for (let attempt = 0; attempt < 4; attempt++) {
        await clickInFrame(frame, page, '#header[role="tab"]');
        // Wait for selection + panel layout.
        try {
            await frame.waitForFunction(() => {
                const t = document.querySelector('#header[role="tab"]');
                if (!t || t.getAttribute('aria-selected') !== 'true') return false;
                const panel = document.querySelector('#Header[role="tabpanel"]');
                if (!panel) return false;
                const cb = panel.querySelector('#checkHeaderOn-input');
                if (!cb) return false;
                const r = cb.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            }, { timeout: env.scaleTimeout(8000) });
        } catch (_) { /* try again */ }
        // Settle: wait 1.2 s and confirm we're still on Header.
        await sleep(1200);
        const stillHeader = await frame.evaluate(() => {
            const t = document.querySelector('#header[role="tab"]');
            return !!(t && t.getAttribute('aria-selected') === 'true');
        });
        if (stillHeader) return;
    }
    throw new Error('clickHeaderTab: tab kept flipping back to General after 4 attempts');
}

async function readHeaderCheckbox(frame) {
    // The Page Style dialog has TWO checkboxes named "checkHeaderOn-input":
    // one on the General "header/footer" preview block and one on the
    // Header tab itself. We want the one inside the #Header tabpanel —
    // that's where the user toggles the visible "Header on" widget.
    return frame.evaluate(() => {
        const panel = document.querySelector('#Header[role="tabpanel"]');
        const root  = panel || document;
        const cb    = root.querySelector('#checkHeaderOn-input');
        if (!cb) return null;
        return {
            checked: cb.checked,
            visible: cb.offsetWidth > 0 || cb.offsetHeight > 0,
        };
    });
}

async function clickHeaderCheckbox(frame, page) {
    // Click the <label for="checkHeaderOn-input"> — clicking the label
    // is exactly what a user does when they click on the text or the
    // styled glyph (the .ui-checkbox-input is a tiny invisible <input>;
    // the visible glyph is rendered via the label's :before pseudo-
    // element). The browser natively forwards the label click to the
    // associated input, dispatching the `change` event that jsdialog's
    // listener relays to LO core. Looking up the label via the input's
    // id avoids any drift between glyph geometry and input geometry.
    const rect = await frame.evaluate(() => {
        const panel = document.querySelector('#Header[role="tabpanel"]');
        const root  = panel || document;
        const lbl   = root.querySelector('#checkHeaderOn-label')
                    || root.querySelector('label[for="checkHeaderOn-input"]');
        if (!lbl) return null;
        const r = lbl.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    if (!rect || rect.w <= 0) throw new Error('checkHeaderOn-label not visible');
    const iframeEl = await page.$('iframe#editor-frame');
    const ifBox = await iframeEl.boundingBox();
    // Aim a few px in (over the visible label text + glyph hit area).
    await page.mouse.click(ifBox.x + rect.x + Math.min(rect.w / 2, 30),
                           ifBox.y + rect.y + rect.h / 2);
}

async function clickDialogApply(frame, page) {
    await clickInFrame(frame, page, '#apply-button');
}

async function closeDialog(frame, page) {
    // Cancel/Close so the dialog doesn't sit around between save round-trips.
    const has = await frame.evaluate(() => !!document.querySelector('#cancel-button'));
    if (!has) return;
    try {
        await clickInFrame(frame, page, '#cancel-button');
    } catch (_) {}
    await sleep(500);
}

async function dialogVisible(frame) {
    return frame.evaluate(() => {
        const d = document.querySelector('[role="dialog"].lokdialog_container, .jsdialog-container[role="dialog"]');
        return !!(d && d.offsetWidth > 0 && d.offsetHeight > 0);
    });
}

// ── Save via Ctrl+S and wait for the ciphertext to rotate ──────────────
async function saveAndWaitForRotation(page, fileId, prevHash) {
    const crypto = require('crypto');
    // Real keyboard Ctrl+S — same as the user.
    await page.bringToFront();
    await page.keyboard.down('Control');
    await page.keyboard.press('s');
    await page.keyboard.up('Control');

    const deadline = Date.now() + env.scaleTimeout(60000);
    let lastHash = prevHash;
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
            lastHash = h;
        } catch (_) {}
        await sleep(800);
    }
    return { rotated: false, hash: lastHash };
}

function hasHeaderReferenceInDoc(documentXml) {
    return /<w:headerReference\b/.test(documentXml || '');
}
function headerXmlEntries(entries) {
    return entries.filter(n => /^word\/header[0-9]*\.xml$/.test(n));
}

(async () => {
    log('=== Regression: Writer header CANNOT be removed via Page Style → Header on ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(DOC_PATH)) {
        log('ERROR: fixture missing: ' + DOC_PATH);
        process.exit(1);
    }

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-features=SharedArrayBuffer'],
    });

    try {
        const bytes = fs.readFileSync(DOC_PATH);

        // Verify the baseline fixture has NO header — otherwise the
        // "added by first Apply" assertion would be meaningless.
        const baseline = await listAndReadDocx(bytes);
        check('Baseline fixture has NO <w:headerReference>',
              !hasHeaderReferenceInDoc(baseline.contents['word/document.xml']),
              'fixture: ' + DOC_PATH);
        check('Baseline fixture has NO word/header*.xml entries',
              headerXmlEntries(baseline.entries).length === 0,
              'entries: ' + headerXmlEntries(baseline.entries).join(','));

        const up = await openViaViewer(browser, VIEWER, DOC_NAME, bytes, {
            iframeTimeout: env.scaleTimeout(120000),
            gotoTimeout: env.scaleTimeout(60000),
            isolatedContext: true,
            viewport: { width: 1920, height: 1080 },
        });
        await up.page.setViewport({ width: 1920, height: 1080 });
        const frame = up.editorFrame;
        log('Uploaded as fileId=' + up.fileId.substring(0, 8) + '… (DOC_NAME=' + DOC_NAME + ')');

        // Wait for the editor to be ready — same signal the real user
        // sees in the status bar.
        await frame.waitForFunction(() => {
            const wc = document.querySelector('#StateWordCount');
            return !!(wc && wc.textContent && wc.textContent.includes('characters'));
        }, { timeout: env.scaleTimeout(180000) });
        log('Editor ready');
        await snap(up.page, 'editor_ready');

        // Track initial ciphertext hash so we can detect post-save rotation.
        const crypto = require('crypto');
        const initialCt = await up.page.evaluate(async (id) => {
            const r = await fetch('/api/v2/file/' + id);
            return r.ok ? (await r.json()).ciphertext : '';
        }, up.fileId);
        const initialHash = crypto.createHash('sha256').update(initialCt || '').digest('hex');

        // ── Phase 1: turn header ON via the dialog, click Apply, save, verify ──
        log('\n--- Phase 1: turn header ON via Format > Page Style → Header tab → Header on → Apply ---');
        await openPageDialog(frame, up.page);
        await snap(up.page, 'pagestyle_dialog_open');

        await clickHeaderTab(frame, up.page);
        await snap(up.page, 'header_tab_selected');

        const stateBefore = await readHeaderCheckbox(frame);
        log('Header-on checkbox initial state: ' + JSON.stringify(stateBefore));
        check('Header-on checkbox visible + initially unchecked',
              stateBefore && stateBefore.visible && stateBefore.checked === false,
              JSON.stringify(stateBefore));

        // Give the Header panel one more beat to settle layout before
        // clicking — the panel-switch animation can briefly leave the
        // input absent from hit-test before the rect stabilizes.
        await sleep(800);
        await snap(up.page, 'before_click_header_on');
        const _preClickState = await frame.evaluate(() => {
            const panel = document.querySelector('#Header[role="tabpanel"]');
            const cb = (panel || document).querySelector('#checkHeaderOn-input');
            const tab = document.querySelector('#header[role="tab"]');
            const r = cb ? cb.getBoundingClientRect() : null;
            return {
                rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
                cbChecked: cb && cb.checked,
                headerTabSelected: tab && tab.getAttribute('aria-selected'),
                generalTabSelected: document.querySelector('#organizer[role="tab"]')?.getAttribute('aria-selected'),
            };
        });
        log('  [diag] pre-click: ' + JSON.stringify(_preClickState));
        await clickHeaderCheckbox(frame, up.page);
        await sleep(1500);
        await snap(up.page, 'after_click_header_on');
        const stateAfterClick1 = await readHeaderCheckbox(frame);
        const _postClickState = await frame.evaluate(() => {
            const tab = document.querySelector('#header[role="tab"]');
            return {
                headerTabSelected: tab && tab.getAttribute('aria-selected'),
                generalTabSelected: document.querySelector('#organizer[role="tab"]')?.getAttribute('aria-selected'),
            };
        });
        log('  [diag] post-click tabs: ' + JSON.stringify(_postClickState));
        log('Header-on after first click: ' + JSON.stringify(stateAfterClick1));
        check('Header-on becomes checked after click',
              stateAfterClick1 && stateAfterClick1.checked === true,
              JSON.stringify(stateAfterClick1));
        await snap(up.page, 'header_on_checked');

        await clickDialogApply(frame, up.page);
        // Apply doesn't close the dialog — give the kit some time to
        // process the SfxItemSet (the toggle adds a header frame).
        await sleep(2500);
        await snap(up.page, 'after_apply_header_on');

        // Close dialog so the post-save state is fully written.
        await closeDialog(frame, up.page);
        await frame.waitForFunction(() =>
            !document.querySelector('[role="dialog"].lokdialog_container, .jsdialog-container[role="dialog"]'),
            { timeout: env.scaleTimeout(10000) }
        ).catch(() => log('  (dialog did not close cleanly — continuing)'));
        await snap(up.page, 'dialog_closed_after_on');

        log('  Saving (Ctrl+S) to flush header-on state to v2 storage');
        const save1 = await saveAndWaitForRotation(up.page, up.fileId, initialHash);
        log('  save1 rotated=' + save1.rotated);
        check('Phase 1 save: ciphertext rotated after header-on + Apply',
              save1.rotated,
              'prev=' + initialHash.substring(0, 8) + ' new=' + (save1.hash || '').substring(0, 8));

        const after1 = await downloadV2(VIEWER, up.upload.secret);
        const z1 = await listAndReadDocx(after1.bytes);
        const hadHdrRef1 = hasHeaderReferenceInDoc(z1.contents['word/document.xml']);
        const hdrFiles1 = headerXmlEntries(z1.entries);
        log('  Phase 1 saved docx: w:headerReference=' + hadHdrRef1 + '; header*.xml entries=' + hdrFiles1.join(','));
        check('Phase 1 saved docx has <w:headerReference> in word/document.xml',
              hadHdrRef1,
              'documentXml head: ' + (z1.contents['word/document.xml'] || '').substring(0, 200));
        check('Phase 1 saved docx contains word/header*.xml',
              hdrFiles1.length > 0,
              'entries: ' + z1.entries.join(','));

        // ── Phase 2: turn header OFF via the same dialog + Apply, save, verify ──
        log('\n--- Phase 2: turn header OFF via Format > Page Style → Header tab → Header on (untick) → Apply ---');
        await openPageDialog(frame, up.page);
        await clickHeaderTab(frame, up.page);
        await snap(up.page, 'pagestyle_dialog_reopen');

        const stateBefore2 = await readHeaderCheckbox(frame);
        log('Header-on checkbox state on reopen: ' + JSON.stringify(stateBefore2));
        check('Header-on checkbox is checked on reopen (header is currently active)',
              stateBefore2 && stateBefore2.checked === true,
              JSON.stringify(stateBefore2));

        await clickHeaderCheckbox(frame, up.page);
        await sleep(700);
        const stateAfterClick2 = await readHeaderCheckbox(frame);
        log('Header-on after second click: ' + JSON.stringify(stateAfterClick2));
        check('Header-on becomes unchecked after click (UI-side)',
              stateAfterClick2 && stateAfterClick2.checked === false,
              JSON.stringify(stateAfterClick2));
        await snap(up.page, 'header_on_unchecked');

        await clickDialogApply(frame, up.page);
        // The bug surface: in LOK mode the kit silently keeps the header
        // because DeleteHeaderDialog(pParent=nullptr).run() returns
        // RET_CANCEL. The Apply click "succeeds" from the user's
        // perspective — no error, no visible warning. Give the kit some
        // time to (no-op) process.
        await sleep(2500);
        await snap(up.page, 'after_apply_header_off');

        // Close dialog and save.
        await closeDialog(frame, up.page);
        await frame.waitForFunction(() =>
            !document.querySelector('[role="dialog"].lokdialog_container, .jsdialog-container[role="dialog"]'),
            { timeout: env.scaleTimeout(10000) }
        ).catch(() => log('  (dialog did not close cleanly — continuing)'));
        await snap(up.page, 'dialog_closed_after_off');

        // Edit the doc slightly so a save WILL be triggered even if the
        // header-off was a kit-side no-op (otherwise nothing's dirty and
        // Ctrl+S returns without rotating the ciphertext, masking the
        // bug as "rotation didn't happen" instead of "header survived").
        // Click into the canvas, type a single space + backspace — this
        // marks the doc dirty without changing user-visible content.
        log('  Nudging doc dirty (canvas click + space/backspace) so Ctrl+S triggers an upload');
        try {
            const iframeEl = await up.page.$('iframe#editor-frame');
            const ifBox = await iframeEl.boundingBox();
            // Click roughly in the doc body area (centre-ish, below toolbar).
            await up.page.mouse.click(ifBox.x + 600, ifBox.y + 400);
            await sleep(400);
            await up.page.keyboard.press('End');
            await up.page.keyboard.press('Space');
            await sleep(150);
            await up.page.keyboard.press('Backspace');
            await sleep(300);
        } catch (e) {
            log('  (nudge failed: ' + e.message + ')');
        }

        log('  Saving (Ctrl+S) to flush header-off state');
        const save2 = await saveAndWaitForRotation(up.page, up.fileId, save1.hash || initialHash);
        log('  save2 rotated=' + save2.rotated);
        check('Phase 2 save: ciphertext rotated after second Apply (doc was dirtied to ensure a roundtrip)',
              save2.rotated,
              'prev=' + (save1.hash || '').substring(0, 8) + ' new=' + (save2.hash || '').substring(0, 8));

        const after2 = await downloadV2(VIEWER, up.upload.secret);
        const z2 = await listAndReadDocx(after2.bytes);
        const hadHdrRef2 = hasHeaderReferenceInDoc(z2.contents['word/document.xml']);
        const hdrFiles2 = headerXmlEntries(z2.entries);
        log('  Phase 2 saved docx: w:headerReference=' + hadHdrRef2 + '; header*.xml entries=' + hdrFiles2.join(','));

        // ── THE BUG SURFACE ──
        // These two checks are what the LO fix is meant to make pass.
        // On current dev (no LO fix), both will FAIL because the kit
        // silently dropped the header-off toggle.
        check('Phase 2 saved docx has NO <w:headerReference> (header was removed)',
              !hadHdrRef2,
              hadHdrRef2 ? 'documentXml still contains w:headerReference: ' + ((z2.contents['word/document.xml'] || '').match(/<w:headerReference[^/]*\/>/) || [''])[0] : '');
        check('Phase 2 saved docx contains NO word/header*.xml (header was removed)',
              hdrFiles2.length === 0,
              'entries still present: ' + hdrFiles2.join(','));

        log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    } catch (e) {
        log('Error: ' + e.message);
        if (e.stack) log(e.stack);
        allPassed = false;
    } finally {
        await browser.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
