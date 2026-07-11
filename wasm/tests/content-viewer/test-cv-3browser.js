// test-cv-3browser.js — three browsers co-editing one document through the
// content viewer; every browser converges on the identical char count after
// each participant edits.
//
// Legacy subject (viewer): a 1-line "Hello World" doc; A types "ABC", B types
// "XYZ", C types "PQR" (at start/end/middle) and all three status bars had to
// reach the same character count after each phase (14 → 17 → 20). The exact
// insertion positions were a legacy detail; the SUBJECT is 3-way convergence
// after each edit, which is preserved here by appending at the document end
// (robust cursor placement) and asserting all three counts match.
//
// CV port: A creates a co-edit room, B and C join the co-edit link in isolated
// contexts. Each of A/B/C appends a distinct 3-char token in turn; after each,
// all three live browsers must converge to the editor's settled count.
// Visible-UI only (keyboard/mouse); convergence = equal #StateWordCount.
//
// Migrated from wasm/tests/misc/test-3browsers.js — legacy version retired.
//
// Usage: node wasm/tests/content-viewer/test-cv-3browser.js [base-url]

'use strict';

const fs = require('fs');
const { launch, sleep } = require('../../lib/browser');
const {
    openBytesViaContentViewer, joinViaContentViewer, waitCvInteractive, cvCharCount,
} = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const SHOT_DIR = '/tmp/content-viewer-report/3browser';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '300000', 10);
const CONVERGE_BUDGET = parseInt(process.env.CONVERGE_BUDGET || '90000', 10);

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
let shotNum = 0;
async function snap(part, name) {
    if (!part || part.dead) return;
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2, '0')}_${part.id}_${name}.png`;
    try { await part.page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch (e) {}
}

async function charCount(part) {
    if (!part || part.dead) return -2;
    return cvCharCount(part.page);
}
async function stableCount(part, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let prev = -1;
    while (Date.now() < deadline) {
        const c = await charCount(part);
        if (c > 0 && c === prev) return c;
        prev = c;
        await sleep(1000);
    }
    return prev;
}
async function convergeTo(parts, target, timeoutMs) {
    const live = parts.filter(p => p && !p.dead);
    const deadline = Date.now() + timeoutMs;
    let counts = {};
    while (Date.now() < deadline) {
        counts = {};
        let all = true;
        for (const p of live) {
            const c = await charCount(p);
            counts[p.id] = c;
            if (c !== target) all = false;
        }
        if (all) return { ok: true, counts };
        await sleep(500);
    }
    return { ok: false, counts };
}
async function typeAtEnd(part, text) {
    await part.page.bringToFront().catch(() => {});
    const box = await (await part.page.$('iframe')).boundingBox();
    await part.page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height * 0.45, 360));
    await sleep(400);
    await part.page.keyboard.down('Control');
    await part.page.keyboard.press('End');
    await part.page.keyboard.up('Control');
    await sleep(300);
    await part.page.keyboard.type(text, { delay: 50 });
    await sleep(1500);
}
async function convergeAfterEdit(editor, allParts, label) {
    const target = await stableCount(editor, CONVERGE_BUDGET);
    const others = allParts.filter(p => p && !p.dead && p !== editor);
    const res = await convergeTo(others, target, CONVERGE_BUDGET);
    const live = allParts.filter(p => p && !p.dead);
    const summary = live.map(p => `${p.id}=${res.counts[p.id] ?? target}`).join(' ');
    check(`all converge after ${label} (target ${target})`, target > 0 && res.ok, summary);
    return target;
}

(async () => {
    log('=== CV 3-browser co-editing ===');
    log('viewer: ' + BASE);
    const { browser } = await launch({ headless: 'new' });
    const parts = {};
    try {
        // A 1-line plaintext doc, opened in Writer via a .txt upload.
        const bytes = Buffer.from('Hello World', 'utf8');
        const NAME = 'cv-3browser-' + Date.now() + '.txt';

        // A creates the co-edit room.
        const openA = await openBytesViaContentViewer(browser, BASE, NAME, bytes, {
            userName: '3B Alice', coEdit: true, iframeTimeout: 60000,
        });
        const A = parts.A = { id: 'A', page: openA.page, context: null, dead: false };
        check('A: editor iframe + join link', !!openA.editorFrame && !!openA.joinLink);
        const joinLink = openA.joinLink;
        check('A: editor interactive', await waitCvInteractive(A.page, LOAD_BUDGET));
        await sleep(6000);
        const base = await stableCount(A, CONVERGE_BUDGET);
        check('A loaded (char count > 0)', base > 0, `base=${base}`);

        // B and C join the co-edit link, each in an isolated context.
        for (const [id, name] of [['B', '3B Bob'], ['C', '3B Cara']]) {
            log(`--- ${id} joining ---`);
            const ctx = await browser.createBrowserContext();
            const page = await ctx.newPage();
            await joinViaContentViewer(browser, joinLink, { page, userName: name, iframeTimeout: 90000 });
            parts[id] = { id, page, context: ctx, dead: false };
            check(`${id}: joined + editor interactive`, await waitCvInteractive(page, LOAD_BUDGET));
            await sleep(6000);
        }
        const { B, C } = parts;

        // Initial 3-way convergence on the base document.
        {
            const r = await convergeTo([A, B, C], base, CONVERGE_BUDGET);
            check('Initial: all three converge to base', r.ok, JSON.stringify(r.counts));
        }
        await snap(A, 'initial'); await snap(B, 'initial'); await snap(C, 'initial');

        // A appends "ABC" → all three converge.
        log('--- A types ABC ---');
        await typeAtEnd(A, 'ABC');
        await convergeAfterEdit(A, [A, B, C], 'A ABC');
        await snap(A, 'after_ABC'); await snap(B, 'after_ABC'); await snap(C, 'after_ABC');

        // B appends "XYZ" → all three converge.
        log('--- B types XYZ ---');
        await typeAtEnd(B, 'XYZ');
        await convergeAfterEdit(B, [A, B, C], 'B XYZ');

        // C appends "PQR" → all three converge.
        log('--- C types PQR ---');
        await typeAtEnd(C, 'PQR');
        const finalTarget = await convergeAfterEdit(C, [A, B, C], 'C PQR');

        check('final count reflects all three edits (base + 9)', finalTarget === base + 9,
            'final=' + finalTarget + ' base=' + base);
        await snap(A, 'final'); await snap(B, 'final'); await snap(C, 'final');
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        for (const id of Object.keys(parts)) {
            const p = parts[id];
            if (p && !p.dead && p.context) { try { await p.context.close(); } catch (e) {} }
        }
        try { await browser.close(); } catch (e) {}
    }
    log('\n' + (allPassed ? 'ALL PASS' : 'SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
