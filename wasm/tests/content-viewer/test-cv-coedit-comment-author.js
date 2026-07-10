// test-cv-coedit-comment-author.js — comments in a content-viewer co-edit
// session carry the right author and propagate to the peer.
//
// A ("Alice CV") creates a co-edit session, B ("Bob CV") joins via the link.
// A inserts a comment through the real UI: Ctrl+Home, Ctrl+Alt+C, CLICK INTO
// the comment box, type, Ctrl+Enter. Asserts on BOTH sides: the comment
// exists, carries A's author name (the commit's uno .uno:InsertAnnotation
// JSON embeds Author explicitly, so the peer's copy is attributed correctly),
// carries the typed content, and nothing leaked into the document body.
//
// History (2026-07-10): originally shipped with the B-side check
// informational-only, believing comment propagation was a relay gap. The
// real story: at narrow viewports the editor auto-zooms (150%+), the comment
// margin vanishes, the annotation parks OFF-VIEWPORT, focus stays on the doc
// and "comment text" typed blind lands in the BODY — on both sides, via key
// relay (a divergence-shaped false positive). With a 1920x1080 viewport and
// a real click into .cool-annotation-textarea, the commit goes through
// uno .uno:InsertAnnotation (already relayed) and everything propagates,
// author included. No product change was needed; the relay carried it all
// along. See ai/proposals/promoted/coedit-comment-propagation.md.
//
// Usage: node wasm/tests/content-viewer/test-cv-coedit-comment-author.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer, joinViaContentViewer } = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOCX = process.env.DOCX || path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/content-viewer-report/coedit-comment-author';
// 1920x1080 misses the warm-restore path on Azure — cold loads run ~190s.
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const PROPAGATE_BUDGET = parseInt(process.env.PROPAGATE_BUDGET || '90000', 10);
const NAME_A = 'Alice CV';
const NAME_B = 'Bob CV';
const VIEWPORT = { width: 1920, height: 1080 };   // comment margin must exist

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
const editorFrame = page => page.frames().find(f => (f.url() || '').includes('cool.html'));
async function waitInteractive(page, budget) {
    const d = Date.now() + budget;
    while (Date.now() < d) {
        const ok = await page.evaluate(() => {
            if (document.querySelector('[role="status"][aria-label="Loading"]')) return false;
            const s = [...document.querySelectorAll('button')].find(b => /^sav/i.test((b.textContent || '').trim()));
            return !!(s && !s.disabled);
        }).catch(() => false);
        if (ok) return true;
        await sleep(500);
    }
    return false;
}
async function charCount(page) {
    const fr = editorFrame(page);
    if (!fr) return -1;
    return fr.evaluate(() => {
        const t = document.querySelector('#StateWordCount')?.textContent || '';
        const m = t.match(/([\d,.]+)\s+character/i);
        return m ? parseInt(m[1].replace(/[,.]/g, ''), 10) : -1;
    }).catch(() => -1);
}
async function annots(page) {
    const fr = editorFrame(page);
    if (!fr) return [];
    return fr.evaluate(() => [...document.querySelectorAll('.cool-annotation')].map(a => ({
        author: a.querySelector('.cool-annotation-content-author')?.textContent?.trim() || '',
        content: (a.querySelector('.cool-annotation-content')?.textContent || '').trim(),
    }))).catch(() => []);
}
async function waitAnnots(page, pred, budget) {
    const d = Date.now() + budget;
    let last = [];
    while (Date.now() < d) {
        last = await annots(page);
        if (pred(last)) return last;
        await sleep(1000);
    }
    return last;
}

(async () => {
    if (!fs.existsSync(DOCX)) { check('fixture present', false, DOCX); process.exit(2); }
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    try {
        const A = await openViaContentViewer(browser, BASE, DOCX, {
            userName: NAME_A, coEdit: true, iframeTimeout: 60000, viewport: VIEWPORT,
        });
        check('A: editor iframe + join link', !!A.editorFrame && !!A.joinLink);
        check('A: editor interactive', await waitInteractive(A.page, LOAD_BUDGET));

        const ctxB = await browser.createBrowserContext();
        const pageB = await ctxB.newPage();
        const B = await joinViaContentViewer(browser, A.joinLink, {
            page: pageB, userName: NAME_B, iframeTimeout: 90000, viewport: VIEWPORT,
        });
        check('B: editor iframe appeared', !!B.editorFrame);
        check('B: editor interactive', await waitInteractive(B.page, LOAD_BUDGET));
        await sleep(4000);   // both sides settled + relay activated
        const ccA0 = await charCount(A.page);
        const ccB0 = await charCount(B.page);

        // ── A inserts a comment through the real UI ──
        const el = await A.page.$('iframe'); const box = await el.boundingBox();
        const frA = editorFrame(A.page);
        let editBox = null;
        for (let attempt = 1; attempt <= 3 && !editBox; attempt++) {
            await A.page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
            await sleep(500);
            await A.page.keyboard.down('Control'); await A.page.keyboard.press('Home'); await A.page.keyboard.up('Control');
            await sleep(500);
            await A.page.keyboard.down('Control'); await A.page.keyboard.down('Alt');
            await A.page.keyboard.press('KeyC');
            await A.page.keyboard.up('Alt'); await A.page.keyboard.up('Control');
            const d = Date.now() + 8000;
            while (Date.now() < d && !editBox) {
                const ta = frA ? await frA.$('.cool-annotation-textarea') : null;
                if (ta) {
                    const tb = await ta.boundingBox();
                    if (tb && tb.x > 0 && tb.y > 0) { editBox = tb; break; }
                }
                await sleep(400);
            }
        }
        check('A: comment editor appeared ON-SCREEN', !!editBox,
            editBox ? JSON.stringify(editBox) : 'off-viewport or missing');
        if (editBox) {
            // The editor repositions / juggles focus in its first moments —
            // clicking too early lands on the doc and the typed text leaks
            // into the body. Settle, then click INTO the contenteditable box
            // and retry until it actually HOLDS focus before typing.
            await sleep(2000);
            let focused = false;
            for (let t = 0; t < 5 && !focused; t++) {
                const ta = await frA.$('.cool-annotation-textarea');
                const tb = ta ? await ta.boundingBox() : null;
                if (!tb || tb.x <= 0 || tb.y <= 0) { await sleep(800); continue; }
                await A.page.mouse.click(tb.x + tb.width / 2, tb.y + Math.min(tb.height / 2, 20));
                await sleep(700);
                focused = await frA.evaluate(() =>
                    (document.activeElement?.className || '').toString().includes('cool-annotation-textarea'))
                    .catch(() => false);
            }
            check('A: comment box holds focus', focused);
            await A.page.keyboard.type('coedit-comment', { delay: 30 });
            await sleep(600);
            const typedIn = frA ? await frA.evaluate(() =>
                (document.querySelector('.cool-annotation-textarea')?.textContent || '')).catch(() => '') : '';
            check('A: typed text landed IN the comment box', typedIn.includes('coedit-comment'),
                '"' + typedIn + '"');
            await A.page.keyboard.down('Control'); await A.page.keyboard.press('Enter'); await A.page.keyboard.up('Control');
        }

        // ── A side: committed with the right author + content ──
        const aAnnots = await waitAnnots(A.page,
            l => l.some(a => a.content.includes('coedit-comment')), 20000);
        check('A: comment committed with content', aAnnots.some(a => a.content.includes('coedit-comment')),
            JSON.stringify(aAnnots));
        check('A: authored "' + NAME_A + '"', aAnnots.some(a => a.author === NAME_A),
            JSON.stringify(aAnnots));

        // ── B side: propagates WITH A's author (uno JSON embeds Author) ──
        const bAnnots = await waitAnnots(B.page,
            l => l.some(a => a.content.includes('coedit-comment')), PROPAGATE_BUDGET);
        check('B: comment propagated to the peer', bAnnots.some(a => a.content.includes('coedit-comment')),
            JSON.stringify(bAnnots));
        check('B: peer copy authored "' + NAME_A + '" (not ' + NAME_B + ')',
            bAnnots.some(a => a.author === NAME_A && a.content.includes('coedit-comment')),
            JSON.stringify(bAnnots));

        // ── body-leak tripwire: comment text must not hit the doc body ──
        const ccA1 = await charCount(A.page);
        const ccB1 = await charCount(B.page);
        check('A: no body leak', ccA1 === ccA0, `chars ${ccA0}→${ccA1}`);
        check('B: no body leak', ccB1 === ccB0, `chars ${ccB0}→${ccB1}`);

        try {
            fs.mkdirSync(SHOT_DIR, { recursive: true });
            await A.page.screenshot({ path: SHOT_DIR + '/a-final.png' });
            await B.page.screenshot({ path: SHOT_DIR + '/b-final.png' });
        } catch (e) {}
    } catch (e) {
        check('harness ran without exception', false, (e.stack || String(e)).slice(0, 300));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
