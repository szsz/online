const __cl = require('./lib/inject-checklist');
// Regression test: SharedArrayBuffer context interference.
//
// The bug: when two pages co-edit a document inside the SAME browser context
// (i.e. siblings in the default Puppeteer browser, or two tabs of the same
// real browser window), they share SharedArrayBuffer / WASM memory and corrupt
// each other's editor state. Co-editing tests that put both pages in the
// default context were failing with bizarre symptoms (extra characters
// appearing, cursors freezing, "memory access out of bounds" pageerrors)
// that masked the *real* application-level bugs we were trying to fix.
//
// The fix in the test suite: every co-editing test creates a fresh
// `browser.createBrowserContext()` per simulated user.
//
// This regression test demonstrates the contrast: same-context co-edit
// produces broken/corrupt state, separate-context co-edit converges cleanly.
//
// We are NOT testing the user-facing multi-tab warning here (that lives in the
// viewer); we're testing that the test infrastructure assumption — "different
// browser contexts are required for co-editing" — actually holds, so future
// engineers don't accidentally regress to shared contexts in new tests.

const puppeteer = require('puppeteer');
const fs = require('fs');

const BASE = 'https://wasm.atgpartners.info:6932';
const RELAY = 'wss://wasm.atgpartners.info:9091';
const TIMEOUT = 180000;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-sab';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2,'0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch(e) {}
}

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}${ev?' ['+ev+']':''}`); allPassed = false; }
}

async function getStatus(page) {
    return page.evaluate(() => {
        const el = document.querySelector('#StateWordCount');
        return el ? el.textContent.trim() : 'NOT FOUND';
    });
}
function charCount(s) {
    const m = (s||'').match(/(\d+) characters/);
    return m ? parseInt(m[1]) : -1;
}

async function openInContext(ctx, url, label) {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForFunction(() => {
        const el = document.querySelector('#StateWordCount');
        return el && el.textContent && el.textContent.includes('characters');
    }, { timeout: TIMEOUT });
    log(`[${label}] Loaded: "${await getStatus(page)}"`);
    return page;
}

async function typeChars(page, label, chars) {
    for (const c of chars) {
        await page.evaluate(ch => globalThis.TheFakeWebSocket.send('textinput id=0 text=' + ch), c);
        await sleep(1500);
    }
}

(async () => {
    log('=== Regression: SAB / browser-context interference ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    try {
        // Upload doc + seed relay
        const ROOM_OK   = 'sab-ok-' + Date.now();
        const ROOM_BAD  = 'sab-bad-' + Date.now();
        const FILE = 'sab-test.txt';
        const up = await browser.newPage();
        await up.goto(`${BASE}/editor.html`, { waitUntil: 'networkidle0' });
        for (const room of [ROOM_OK, ROOM_BAD]) {
            await up.evaluate(async (url, room, file, content) => {
                await fetch(url + '/wasm/' + file, { method: 'POST',
                    body: new Blob([content], { type: 'application/octet-stream' })});
                await fetch(`${url.replace(':6932', ':9091').replace('https', 'https')}/room/${encodeURIComponent(room)}/file`.replace('https://wasm', 'https://wasm') ,
                    { method: 'POST', body: new Blob([content]) }).catch(() => {});
                await fetch('https://wasm.atgpartners.info:9091/room/' + encodeURIComponent(room) + '/file',
                    { method: 'POST', body: new Blob([content]) });
            }, BASE, room, FILE, 'Hello');
        }
        await up.close();
        log('Doc uploaded + relay seeded for both rooms');

        // ---------- TEST 1: GOOD — separate browser contexts ----------
        log('\n--- Scenario A: SEPARATE browser contexts (the fix) ---');
        const okUrl = `${BASE}/browser/cool.html?WOPISrc=${FILE}` +
                      `&relay=${encodeURIComponent(RELAY + '/room/' + ROOM_OK)}&access_token=test`;
        const ctxA = await browser.createBrowserContext();
        const ctxB = await browser.createBrowserContext();
        let okErrors = [];
        const okPageA = await openInContext(ctxA, okUrl, 'OK-A');
        okPageA.on('pageerror', e => okErrors.push('A:' + e.message.substring(0, 100)));
        await sleep(8000);
        const okPageB = await openInContext(ctxB, okUrl, 'OK-B');
        okPageB.on('pageerror', e => okErrors.push('B:' + e.message.substring(0, 100)));
        await sleep(15000);
        await snap(okPageA, 'sep_A_initial');
        await snap(okPageB, 'sep_B_initial');

        await typeChars(okPageA, 'OK-A', 'XYZ');
        await sleep(8000);
        const okFinalA = charCount(await getStatus(okPageA));
        const okFinalB = charCount(await getStatus(okPageB));
        await snap(okPageA, 'sep_A_after_xyz');
        await snap(okPageB, 'sep_B_after_xyz');
        log(`Separate contexts: A=${okFinalA} B=${okFinalB} (expected 8 = "Hello"+XYZ)`);
        check('Separate contexts: A reaches 8 chars', okFinalA === 8, 'A=' + okFinalA);
        check('Separate contexts: B converges to A',
              okFinalA === 8 && okFinalB === 8, `A=${okFinalA} B=${okFinalB}`);
        const okFatalErrors = okErrors.filter(e => /memory access out of bounds|out of memory|wasm/i.test(e));
        check('Separate contexts: no WASM/memory errors',
              okFatalErrors.length === 0, okFatalErrors.slice(0,2).join(' | '));

        await ctxA.close();
        await ctxB.close();

        // ---------- TEST 2: BAD — same browser context ----------
        log('\n--- Scenario B: SAME browser context (the bug) ---');
        const badUrl = `${BASE}/browser/cool.html?WOPISrc=${FILE}` +
                       `&relay=${encodeURIComponent(RELAY + '/room/' + ROOM_BAD)}&access_token=test`;
        const sharedCtx = await browser.createBrowserContext();
        let badErrors = [];
        let badPageA, badPageB;
        let openFailed = false;
        let bothLoaded = false;
        try {
            badPageA = await openInContext(sharedCtx, badUrl, 'BAD-A');
            badPageA.on('pageerror', e => badErrors.push('A:' + e.message.substring(0, 100)));
            await sleep(8000);
            badPageB = await openInContext(sharedCtx, badUrl, 'BAD-B');
            badPageB.on('pageerror', e => badErrors.push('B:' + e.message.substring(0, 100)));
            await sleep(10000);
            bothLoaded = true;
            await snap(badPageA, 'shared_A_initial');
            await snap(badPageB, 'shared_B_initial');
            await typeChars(badPageA, 'BAD-A', 'XYZ');
            await sleep(8000);
        } catch (e) {
            log('  Same-context open failed (expected — this is the bug): ' + e.message);
            openFailed = true;
        }

        let badAchars = -1, badBchars = -1;
        try { badAchars = charCount(await getStatus(badPageA)); } catch(e) {}
        try { badBchars = charCount(await getStatus(badPageB)); } catch(e) {}
        if (badPageA) await snap(badPageA, 'shared_A_after_xyz');
        if (badPageB) await snap(badPageB, 'shared_B_after_xyz');

        const badFatalErrors = badErrors.filter(e => /memory access out of bounds|out of memory|wasm|SharedArrayBuffer/i.test(e));
        log(`Same-context result: A=${badAchars} B=${badBchars} ` +
            `errors=${badErrors.length} (fatal=${badFatalErrors.length})`);
        if (badErrors.length) {
            log('  errors: ' + badErrors.slice(0, 3).join(' | '));
        }

        // The bug manifests as ONE of:
        //   - Open fails entirely
        //   - WASM memory / SAB pageerror
        //   - The two pages do NOT converge to 8 chars
        const sameContextBroken =
            openFailed ||
            badFatalErrors.length > 0 ||
            !(badAchars === 8 && badBchars === 8);
        check('Same-context co-edit is broken (proof the contrast matters)',
              sameContextBroken,
              `failed=${openFailed} fatalErr=${badFatalErrors.length} A=${badAchars} B=${badBchars}`);

        try { await sharedCtx.close(); } catch(e) {}

        log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    } catch (e) {
        log('Error: ' + e.message);
        allPassed = false;
    } finally {
        await browser.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
