const __cl = require('../../lib/inject-checklist');
// Co-editing REJOIN STORM — the harshest "browsers coming and going" case.
//
// A stays and edits continuously. A second participant repeatedly LEAVES
// (context close = disconnect) and REJOINS the live session, several times,
// while A keeps typing. Each rejoin exercises the late-join replay path
// against an ever-growing message log / rotated checkpoints. After every
// rejoin the newcomer must converge to A's current char count, and neither
// party may log a checkpoint mismatch / abort. A final fresh participant
// then joins and must converge to the full accumulated state.
//
// Visible-UI only; convergence = equal #StateWordCount.

'use strict';

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { openViaViewer, openSecretInBrowser } = require('../../lib/open-via-viewer');
const { waitInFrame, evalInFrame } = require('../../lib/two-tab');

const VIEWER = env.FILE_STORAGE_URL;
const LOAD_TIMEOUT = env.scaleTimeout(120000);
const CONVERGE_TIMEOUT = env.scaleTimeout(120000); // generous: late-join replay can be slow under box load
const VP = { width: 1920, height: 1080 };
const ROUNDS = 4;
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

const ERR_RE = /CHECKPOINT MISMATCH|memory access out of bounds|RuntimeError|unreachable|Aborted\(|table index is out of bounds|OOB/i;
function wire(part) {
    part.errors = [];
    part.page.on('console', m => { const t = m.text(); if (ERR_RE.test(t)) part.errors.push(t.slice(0, 200)); });
    part.page.on('pageerror', e => { if (ERR_RE.test(e.message)) part.errors.push('pageerror: ' + e.message.slice(0, 200)); });
    return part;
}

async function charCount(part) {
    if (!part || part.dead) return -2;
    return evalInFrame(part.page, () => {
        const t = document.querySelector('#StateWordCount')?.textContent || '';
        const m = t.match(/([\d,]+)\s*character/);
        return m ? parseInt(m[1].replace(/,/g, '')) : -1;
    }).catch(() => -1);
}
async function stableCount(part, timeoutMs) {
    const deadline = Date.now() + timeoutMs; let prev = -1;
    while (Date.now() < deadline) { const c = await charCount(part); if (c > 0 && c === prev) return c; prev = c; await sleep(1000); }
    return prev;
}
async function convergeTo(parts, target, timeoutMs) {
    const live = parts.filter(p => p && !p.dead); const deadline = Date.now() + timeoutMs; let counts = {};
    while (Date.now() < deadline) {
        counts = {}; let all = true;
        for (const p of live) { const c = await charCount(p); counts[p.id] = c; if (c !== target) all = false; }
        if (all) return { ok: true, counts };
        await sleep(500);
    }
    return { ok: false, counts };
}
async function typeAtEnd(part, text) {
    await part.page.bringToFront().catch(() => {});
    await part.page.mouse.click(640, 380); await sleep(300);
    await part.page.keyboard.down('Control'); await part.page.keyboard.press('End'); await part.page.keyboard.up('Control'); await sleep(200);
    await part.page.keyboard.type(text, { delay: 30 }); await sleep(1200);
}
async function joinPart(browser, id, secret) {
    const up = await openSecretInBrowser(browser, VIEWER, secret, {
        iframeTimeout: LOAD_TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
        isolatedContext: true, coEditing: true, viewport: VP,
    });
    const part = wire({ id, page: up.page, context: up.context, dead: false });
    await waitInFrame(part.page, () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''), { timeout: LOAD_TIMEOUT });
    await sleep(5000);
    return part;
}

(async () => {
    log('=== Co-editing REJOIN STORM ===');
    const { browser } = await launch({ headless: 'new' });
    const seen = {};
    let A;
    try {
        const bytes = fs.readFileSync(FIXTURE);
        const upA = await openViaViewer(browser, VIEWER, 'coedit-rejoin-' + Date.now() + '.docx', bytes, {
            iframeTimeout: LOAD_TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
            isolatedContext: true, coEditing: true, viewport: VP,
        });
        A = seen.A = wire({ id: 'A', page: upA.page, context: upA.context, dead: false });
        const secret = upA.b64urlSecret;
        await waitInFrame(A.page, () => /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''), { timeout: LOAD_TIMEOUT });
        await sleep(6000);
        check('A opened', (await charCount(A)) > 0);

        for (let round = 1; round <= ROUNDS; round++) {
            // A types before the join
            await typeAtEnd(A, `r${round}Aaaa`);
            // a fresh participant joins
            log(`--- round ${round}: joiner J${round} joins ---`);
            const J = seen['J' + round] = await joinPart(browser, 'J' + round, secret);
            let target = await stableCount(A, CONVERGE_TIMEOUT);
            let r = await convergeTo([A, J], target, CONVERGE_TIMEOUT);
            check(`round ${round}: joiner converges on join`, r.ok, `target=${target} ${JSON.stringify(r.counts)}`);

            // both edit while connected
            await typeAtEnd(J, `r${round}Jjjj`);
            target = await stableCount(J, CONVERGE_TIMEOUT);
            r = await convergeTo([A, J], target, CONVERGE_TIMEOUT);
            check(`round ${round}: joiner's edit converges to A`, r.ok, `target=${target} ${JSON.stringify(r.counts)}`);

            // A saves (rotates checkpoint) then joiner LEAVES
            await A.page.bringToFront().catch(() => {});
            await A.page.keyboard.down('Control'); await A.page.keyboard.press('KeyS'); await A.page.keyboard.up('Control'); await sleep(4000);
            log(`--- round ${round}: joiner J${round} leaves ---`);
            J.dead = true; try { await J.context.close(); } catch (e) {}
            await sleep(2500);
            // A keeps editing solo while nobody else is connected
            await typeAtEnd(A, `r${round}Solo`);
        }

        // Final fresh participant must replay the whole storm's accumulated state
        log('--- final joiner F ---');
        const F = seen.F = await joinPart(browser, 'F', secret);
        const target = await stableCount(A, CONVERGE_TIMEOUT);
        const r = await convergeTo([A, F], target, CONVERGE_TIMEOUT);
        check('final fresh joiner replays full accumulated state', r.ok, `target=${target} ${JSON.stringify(r.counts)}`);

        // error-flag gate over every participant that ever existed
        for (const id of Object.keys(seen)) {
            const p = seen[id];
            check(`${id}: no checkpoint-mismatch / abort / OOB`, p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
        }
    } catch (e) {
        check('harness ran without exception', false, (e && e.stack || String(e)).slice(0, 300));
    } finally {
        for (const id of Object.keys(seen)) { const p = seen[id]; if (p && !p.dead) { try { await p.context.close(); } catch (e) {} } }
        try { await browser.close(); } catch (e) {}
    }
    log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
