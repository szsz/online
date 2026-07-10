// test-cv-comment-author.js — the content-viewer user name must author comments.
//
// Sets the tester's "User name" field (which becomes the UserName cool param),
// opens a doc, inserts a comment through the real UI (Ctrl+Alt+C → CLICK INTO
// the comment box → type → Ctrl+Enter), and asserts the COMMITTED comment
// carries that author AND the typed content — NOT the LocalStorage default
// "LocalUser#0". Uses a space-containing name to also exercise URL-encoding
// of the author= load param.
//
// Hardened 2026-07-10: the original version typed blind after Ctrl+Alt+C and
// only asserted the author label — a FALSE POSITIVE. At narrow viewports the
// editor auto-zooms (150%+) leaving no comment margin, the annotation parks
// off-viewport, focus stays on the doc, and the "comment text" lands in the
// DOCUMENT BODY while the comment stays empty and uncommitted. Now: 1920x1080
// viewport (margin exists), click into .cool-annotation-textarea (real user
// behavior), assert the comment CONTENT, and assert the body char count did
// NOT change (regression tripwire for the body-leak).
//
// Usage: node wasm/tests/content-viewer/test-cv-comment-author.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer } = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOCX = process.env.DOCX || path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const NAME = process.env.CV_USER || 'ATG Comment Author';
const SHOT_DIR = '/tmp/content-viewer-report/comment-author';
// 1920x1080 misses the warm-restore path on Azure — cold loads run ~190s.
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
const editorFrame = page => page.frames().find(f => (f.url() || '').includes('cool.html'));
async function interactive(page) {
    return page.evaluate(() => {
        if (document.querySelector('[role="status"][aria-label="Loading"]')) return false;
        const s = [...document.querySelectorAll('button')].find(b => /^save$/i.test((b.textContent || '').trim()));
        return !!(s && !s.disabled);
    }).catch(() => false);
}
async function waitInteractive(page, budget) {
    const d = Date.now() + budget;
    while (Date.now() < d) { if (await interactive(page)) return true; await sleep(500); }
    return false;
}
async function commentAuthors(fr) {
    return fr.evaluate(() => [...document.querySelectorAll('.cool-annotation-content-author')]
        .map(e => (e.textContent || '').trim()).filter(Boolean)).catch(() => []);
}

(async () => {
    if (!fs.existsSync(DOCX)) { check('fixture present', false, DOCX); process.exit(2); }
    log('viewer: ' + BASE + '   userName: "' + NAME + '"');
    const { browser } = await launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        const cdp = await page.target().createCDPSession();
        try { await cdp.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite'] }); } catch (e) {}
        await openViaContentViewer(browser, BASE, DOCX, {
            page, userName: NAME, iframeTimeout: 45000,
            viewport: { width: 1920, height: 1080 },   // comment margin must exist
        });
        check('editor interactive', await waitInteractive(page, LOAD_BUDGET));
        await sleep(2000);

        const fr = editorFrame(page);
        // URLSearchParams decodes '+' → space (decodeURIComponent does not).
        const urlName = fr ? (new URLSearchParams(fr.url().split('?')[1] || '').get('UserName') || '') : '';
        check('UserName reached the editor URL', urlName === NAME, 'url="' + urlName + '"');

        const charCount = async () => fr.evaluate(() => {
            const t = document.querySelector('#StateWordCount')?.textContent || '';
            const m = t.match(/([\d,.]+)\s+character/i);
            return m ? parseInt(m[1].replace(/[,.]/g, ''), 10) : -1;
        }).catch(() => -1);

        // Insert a comment via the real UI: cursor to doc start (Ctrl+Home),
        // Ctrl+Alt+C, wait for the annotation editor, CLICK INTO its
        // contenteditable box (real user behavior — typing blind leaks into
        // the doc body), type, commit with Ctrl+Enter.
        await sleep(3000);
        const ccBefore = await charCount();
        const el = await page.$('iframe'); const box = await el.boundingBox();
        let editBox = null;
        for (let attempt = 1; attempt <= 3 && !editBox; attempt++) {
            await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
            await sleep(500);
            await page.keyboard.down('Control'); await page.keyboard.press('Home'); await page.keyboard.up('Control');
            await sleep(500);
            await page.keyboard.down('Control'); await page.keyboard.down('Alt');
            await page.keyboard.press('KeyC');
            await page.keyboard.up('Alt'); await page.keyboard.up('Control');
            const d = Date.now() + 8000;
            while (Date.now() < d && !editBox) {
                const ta = fr ? await fr.$('.cool-annotation-textarea') : null;
                if (ta) {
                    const tb = await ta.boundingBox();
                    if (tb && tb.x > 0 && tb.y > 0) { editBox = tb; break; }
                }
                await sleep(400);
            }
        }
        check('comment editor appeared ON-SCREEN (Insert Comment)', !!editBox,
            editBox ? JSON.stringify(editBox) : 'off-viewport or missing');
        if (editBox) {
            // Settle, then click INTO the contenteditable box and retry until
            // it actually HOLDS focus — clicking too early lands on the doc
            // and the typed text leaks into the body.
            await sleep(2000);
            let focused = false;
            for (let t = 0; t < 5 && !focused; t++) {
                const ta = await fr.$('.cool-annotation-textarea');
                const tb = ta ? await ta.boundingBox() : null;
                if (!tb || tb.x <= 0 || tb.y <= 0) { await sleep(800); continue; }
                await page.mouse.click(tb.x + tb.width / 2, tb.y + Math.min(tb.height / 2, 20));
                await sleep(700);
                focused = await fr.evaluate(() =>
                    (document.activeElement?.className || '').toString().includes('cool-annotation-textarea'))
                    .catch(() => false);
            }
            check('comment box holds focus', focused);
            await page.keyboard.type('authored-by-test', { delay: 30 });
            await sleep(600);
            await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
            await sleep(2500);
        }

        const authors = fr ? await commentAuthors(fr) : [];
        const contents = fr ? await fr.evaluate(() =>
            [...document.querySelectorAll('.cool-annotation-content')]
                .map(e => (e.textContent || '').trim()).filter(Boolean)).catch(() => []) : [];
        check('a comment was created', authors.length > 0, JSON.stringify(authors));
        check('comment authored with the content-viewer user name',
            authors.includes(NAME), 'authors=' + JSON.stringify(authors));
        check('comment NOT authored as the LocalUser default',
            !authors.some(a => /^LocalUser/.test(a)), 'authors=' + JSON.stringify(authors));
        check('comment CONTENT committed (not an empty shell)',
            contents.some(c => c.includes('authored-by-test')), JSON.stringify(contents));
        const ccAfter = await charCount();
        check('typed text did NOT leak into the document body',
            ccAfter === ccBefore, `chars before=${ccBefore} after=${ccAfter}`);

        try { fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.screenshot({ path: SHOT_DIR + '/comment.png' }); } catch (e) {}
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 200));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
