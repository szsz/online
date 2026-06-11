const __cl = require('../../lib/inject-checklist');
// Regression: Hard refresh loses unsaved edits.
//
// Steps to reproduce:
//   1. A opens a doc with existing content (19 chars)
//   2. A types "XYZ" (22 chars)
//   3. A does NOT save
//   4. A does a hard refresh (reload the page)
//   5. A opens the same document
//   6. A should see 22 chars — but may see 19 (lost edits)
//
// Root cause: hard refresh kills WebSocket instantly. The relay has A's
// messages in its log, but:
//   - The room may be cleaned up (60s timeout) if WASM takes too long to boot
//   - Even if the room survives, the reconnecting A gets a new viewId,
//     and the checkpoint is from before the edits
//   - If the room IS cleaned up, the messages are gone forever
//
// ALL input via real keyboard/mouse.

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs'), path = require('path');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');
const { openSecretInBrowser } = require('../../lib/open-via-viewer');
const { waitInFrame, getCharCount } = require('../../lib/two-tab');
const VIEWER = env.FILE_STORAGE_URL;
const SHOTS = '/tmp/static-deploy/public/shots-regression-hard-refresh';

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) console.log(`  ✓ ${label}`);
    else { console.log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
function charCount(s) { const m = s && s.match(/(\d+) characters/); return m ? parseInt(m[1]) : -1; }

(async () => {
    fs.rmSync(SHOTS, { recursive: true, force: true });
    fs.mkdirSync(SHOTS, { recursive: true });

    let stepNum = 0;
    async function snap(page, name) {
        stepNum++;
        await page.screenshot({ path: `${SHOTS}/${String(stepNum).padStart(2,'0')}_${name}.png` });
    }

    const docName = 'hardrefresh-' + Date.now() + '.docx';

    // Upload via v2 (encrypted): generate secret, derive keys, encrypt,
    // PUT /api/v2/file/<fileId>. Browser opens via /#file=<b64urlSecret>.
    const bytes = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx'));
    const { b64urlSecret, fileId } = await uploadV2(VIEWER, docName, bytes);
    console.log('[setup] Uploaded v2 ' + docName + ' as ' + fileId.substring(0,8) + '…');

    // ═══ Phase 1: Open, type, NO save ═══
    console.log('\n=== Phase 1: Open doc, type XYZ, do NOT save ===');
    const { browser: bA, cleanup: cA } = await launch();
    // openSecretInBrowser routes through the viewer, filters the bootstrap
    // __prewarm_blank iframe, and returns once the FILE-loading iframe
    // exists. Previously this used a raw page.frames().find() loop that
    // could latch onto the prewarm-blank frame whose StateWordCount
    // never propagates the user doc.
    const upA = await openSecretInBrowser(bA, VIEWER, b64urlSecret,
        { iframeTimeout: env.scaleTimeout(120000),
          gotoTimeout: env.scaleTimeout(60000),
          viewport: { width: 1280, height: 900 } });
    const pA = upA.page;

    // waitInFrame re-resolves the live editor iframe on every poll.
    await waitInFrame(pA,
        () => /\d+\s+character/i.test(
                  document.querySelector('#StateWordCount')?.textContent || '')
              && typeof globalThis.TheFakeWebSocket !== 'undefined',
        { timeout: env.scaleTimeout(150000) });
    await sleep(5000);

    const cc0 = await getCharCount(pA);
    console.log('  Initial: ' + cc0 + ' chars');

    // Click and type
    const el = await pA.$('iframe#editor-frame');
    if (el) { const b = await el.boundingBox(); if (b) await pA.mouse.click(b.x+b.width/2, b.y+b.height/2); }
    await sleep(500);
    await pA.keyboard.type('XYZ', { delay: 80 });
    await sleep(3000);
    const cc1 = await getCharCount(pA);
    console.log('  After typing: ' + cc1 + ' chars');
    check('Typed 3 chars', cc1 - cc0 === 3, 'delta=' + (cc1 - cc0));
    await snap(pA, 'before_refresh');

    // ═══ Phase 2: HARD REFRESH (simulate F5 / Ctrl+R) ═══
    console.log('\n=== Phase 2: Hard refresh (navigate to same URL) ===');
    // This is equivalent to the user pressing F5 — the page reloads,
    // WebSocket closes instantly, no save triggered.
    await pA.goto(VIEWER + '/#file=' + b64urlSecret, { waitUntil: 'domcontentloaded' });
    console.log('  Page reloaded');

    // Wait for editor to load again (via the LIVE iframe lookup, not a
    // raw frames().find() that can latch onto __prewarm_blank).
    await waitInFrame(pA,
        () => /\d+\s+character/i.test(
                  document.querySelector('#StateWordCount')?.textContent || '')
              && typeof globalThis.TheFakeWebSocket !== 'undefined',
        { timeout: env.scaleTimeout(150000) });
    await sleep(10000); // generous settle for message replay

    const cc2 = await getCharCount(pA);
    await snap(pA, 'after_refresh');
    console.log('  After refresh: ' + cc2 + ' chars (expected ' + cc1 + ')');

    // THE KEY CHECKS
    check('After refresh: sees typed content (' + cc1 + ' chars)',
        cc2 === cc1,
        'got=' + cc2 + ' expected=' + cc1 + ' diff=' + (cc2 - cc1));
    check('After refresh: NOT blank/initial',
        cc2 > cc0,
        'got=' + cc2 + ' initial=' + cc0);

    // Check stored (encrypted) file size via v2 endpoint. No save was
    // triggered, so this should match the initial ciphertext size.
    const storedSize = await pA.evaluate(async (id) => {
        const r = await fetch('/api/v2/file/' + id);
        if (!r.ok) return -1;
        const j = await r.json();
        return j.size;
    }, fileId);
    console.log('  Stored file (ciphertext): ' + storedSize + ' bytes');

    await cA();
    console.log('\n' + (allPassed ? '✓ ALL PASSED' : '✗ SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
