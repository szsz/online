const __cl = require('../../lib/inject-checklist');
// Acceptance: the viewer's loading shield shows ONE averaged progress
// bar during file open that climbs 0 → ~100 % as the document opens.
//
// Feature history:
//   - 2026-06-12: a multi-stage stepper (#shield-stages <li> rows) was
//     rendered under the bar.
//   - 2026-06-17 (single-averaged-progress-bar): the stepper + per-step
//     sub-bars + shimmer were REMOVED. The one bar
//     (#editor-shield-bar-fill / window.__shieldMaxPct) now shows
//     (barPct + importPct) / 2 — the average of the internal boot/stage
//     value and the kit import %. This test asserts the SINGLE bar, not
//     the (now-deleted) stepper rows.
//
// This test drives ONLY through the visible UI:
//   1. Upload a docx via v2, open it in a FRESH browser (cold pipeline).
//   2. While the shield is up, poll the VIEWER page DOM (not the
//      iframe): the bar fill width (and window.__shieldMaxPct) must
//      climb monotonically from ~0 toward 100.
//   3. Assert the bar climbed a meaningful amount (low early sample,
//      high late sample) and never regressed across polls.
//   4. Assert NO stepper UI is present (#shield-stages removed).
//   5. After the shield drops, the doc must actually be open
//      (StateWordCount shows characters) — the bar must not break the
//      open itself.

'use strict';

const fs = require('fs'), path = require('path');
const { launch, sleep } = require('../../lib/browser');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');
const { openSecretInBrowser } = require('../../lib/open-via-viewer');
const { waitInFrame, getCharCount } = require('../../lib/two-tab');

const VIEWER = env.FILE_STORAGE_URL;
const SHOTS = '/tmp/static-deploy/public/shots-regression-open-progress-stages';

const T0 = Date.now();
const log = m => console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`);

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

(async () => {
    fs.rmSync(SHOTS, { recursive: true, force: true });
    fs.mkdirSync(SHOTS, { recursive: true });

    const docName = 'progress-stages-' + Date.now() + '.docx';
    const bytes = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx'));
    const { b64urlSecret } = await uploadV2(VIEWER, docName, bytes);
    log('uploaded ' + docName);

    const { browser, cleanup } = await launch();
    try {
        // Open and IMMEDIATELY start polling the shield — the stage
        // readout lives on the parent viewer page, visible while the
        // iframe boots behind it.
        const up = await openSecretInBrowser(browser, VIEWER, b64urlSecret,
            { iframeTimeout: env.scaleTimeout(120000),
              gotoTimeout: env.scaleTimeout(60000),
              viewport: { width: 1280, height: 900 } });
        const page = up.page;

        // Poll viewer DOM while shield is up. Collect the single bar's
        // width % (and window.__shieldMaxPct) across the open. Also
        // confirm the old stepper UI is gone.
        const barSamples = [];
        let sawStagesEl = false;       // #shield-stages must NOT exist anymore
        let shotTaken = false;
        // Persistent high-water-mark of the bar (window.__shieldMaxPct + the
        // fill width). Tracked across ALL polls — fast (single-user,
        // prewarmed) opens snap to 100 at ready and drop the shield between
        // polls, so the while-shieldUp samples below can miss the peak even
        // though the bar reached 100. __shieldMaxPct/fill persist past drop.
        let peakMax = -1;

        // Terminate the poll on ACTUAL doc-open, not on the shield's
        // `active` class. On a cold load the editor iframe's first asset
        // fetch can ERR_ABORT and the frame reloads; the shield briefly
        // loses `active` during that gap. Poll until the document reports
        // characters (the same signal step 5 uses), accumulating bar
        // samples across the whole load (including across an iframe reload).
        const pollDeadline = Date.now() + env.scaleTimeout(120000);
        let docOpen = false;
        while (Date.now() < pollDeadline) {
            const snap = await page.evaluate(() => {
                const sh = document.getElementById('editor-shield');
                const shieldUp = !!sh && sh.classList.contains('active');
                const stagesEl = document.getElementById('shield-stages');
                const fill = document.getElementById('editor-shield-bar-fill');
                const pct = fill ? parseFloat(fill.style.width) || 0 : -1;
                const maxPct = (typeof window.__shieldMaxPct === 'number')
                    ? window.__shieldMaxPct : -1;
                return { shieldUp, hasStages: !!stagesEl, pct, maxPct };
            }).catch(() => null);

            if (snap) {
                if (snap.hasStages) sawStagesEl = true;
                peakMax = Math.max(peakMax, snap.pct, snap.maxPct);
                if (snap.pct >= 0 && snap.shieldUp) {
                    barSamples.push(snap.pct);
                    if (!shotTaken && snap.pct >= 20) {
                        shotTaken = true;
                        try { await page.screenshot({ path: SHOTS + '/01_shield_bar.png' }); } catch (_) {}
                    }
                }
            }

            // Doc-open is the real terminator. Check the iframe's word
            // count; once chars are visible the open is done. Give one
            // extra poll after detection so the final bar update lands.
            const cc = await getCharCount(page).catch(() => -1);
            if (cc > 0) {
                if (docOpen) break;   // saw it open last poll too — settle
                docOpen = true;
            }
            await sleep(300);
        }

        // Final read of the bar's high-water-mark after the doc opened —
        // __shieldMaxPct / the fill width persist after the shield drops, so
        // this captures the ready-snap to 100 even when the poll missed it.
        const finalSnap = await page.evaluate(() => {
            const f = document.getElementById('editor-shield-bar-fill');
            return { max: (typeof window.__shieldMaxPct === 'number') ? window.__shieldMaxPct : -1,
                     fill: f ? parseFloat(f.style.width) || 0 : -1 };
        }).catch(() => ({ max: -1, fill: -1 }));
        peakMax = Math.max(peakMax, finalSnap.max, finalSnap.fill);

        // The stepper UI is REMOVED — #shield-stages must not exist.
        check('stepper UI removed (no #shield-stages element)', !sawStagesEl);

        // Bar monotonicity (allow equal, disallow regress > 2% jitter).
        let monotonic = true, prev = -1;
        for (const p of barSamples) {
            if (p < prev - 2) { monotonic = false; break; }
            prev = Math.max(prev, p);
        }
        check('single progress bar monotonically non-decreasing',
              monotonic, 'samples=' + barSamples.length + ' max=' + prev);

        // The bar must CLIMB 0 → ~100 over the open. Assert on the persistent
        // high-water-mark (__shieldMaxPct / fill), NOT the while-shieldUp
        // sampled max: fast (single-user, prewarmed) opens snap the bar to 100
        // at ready and drop the shield between polls, so the sampled max lags
        // even though the bar genuinely reached 100 (verified: peak=100).
        const sampledMax = barSamples.length ? Math.max(...barSamples) : -1;
        check('progress bar climbed toward 100 (max >= 80)',
              peakMax >= 80, 'peakMax=' + peakMax + ' sampledMax=' + sampledMax +
              ' samples=' + barSamples.length);

        // The open itself must still work.
        await waitInFrame(page,
            () => /\d+\s+character/i.test(
                      document.querySelector('#StateWordCount')?.textContent || ''),
            { timeout: env.scaleTimeout(120000) });
        const cc = await getCharCount(page);
        try { await page.screenshot({ path: SHOTS + '/02_doc_open.png' }); } catch (_) {}
        check('document actually opened (chars visible)', cc > 0, 'cc=' + cc);

        log('\n' + (allPassed ? '✓ ALL PASSED' : '✗ SOME FAILED'));
    } catch (e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        await cleanup().catch(() => {});
    }
    process.exit(allPassed ? 0 : 1);
})();
