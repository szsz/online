// test-cv-comment-author.js — the content-viewer user name must author comments.
//
// Sets the tester's "User name" field (which becomes the UserName cool param),
// opens a doc, inserts a comment through the real UI (Ctrl+Alt+C → type →
// Ctrl+Enter), and asserts the rendered comment author is that name — NOT the
// LocalStorage default "LocalUser#0". Uses a space-containing name to also
// exercise URL-encoding of the author= load param.
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
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '150000', 10);

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
        await openViaContentViewer(browser, BASE, DOCX, { page, userName: NAME, iframeTimeout: 45000 });
        check('editor interactive', await waitInteractive(page, LOAD_BUDGET));
        await sleep(2000);

        const fr = editorFrame(page);
        const urlName = fr ? decodeURIComponent((fr.url().match(/[?&]UserName=([^&]*)/) || [])[1] || '') : '';
        check('UserName reached the editor URL', urlName === NAME, 'url="' + urlName + '"');

        // Insert a comment via the real UI: focus the doc, Ctrl+Alt+C, type, commit.
        const el = await page.$('iframe'); const box = await el.boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.5, 400));
        await sleep(400);
        await page.keyboard.down('Control'); await page.keyboard.down('Alt');
        await page.keyboard.press('KeyC');
        await page.keyboard.up('Alt'); await page.keyboard.up('Control');
        await sleep(2500);
        await page.keyboard.type('authored-by-test', { delay: 30 });
        await sleep(600);
        await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
        await sleep(1800);

        const authors = fr ? await commentAuthors(fr) : [];
        check('a comment was created', authors.length > 0, JSON.stringify(authors));
        check('comment authored with the content-viewer user name',
            authors.includes(NAME), 'authors=' + JSON.stringify(authors));
        check('comment NOT authored as the LocalUser default',
            !authors.some(a => /^LocalUser/.test(a)), 'authors=' + JSON.stringify(authors));

        try { fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.screenshot({ path: SHOT_DIR + '/comment.png' }); } catch (e) {}
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 200));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
