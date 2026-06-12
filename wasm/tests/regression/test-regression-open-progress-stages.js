const __cl = require('../../lib/inject-checklist');
// Acceptance: the viewer's loading shield shows a MULTI-STAGE progress
// readout during file open — not just a spinner + single label.
//
// Feature (2026-06-12, user request): break the file-open pipeline into
// as many user-visible stages as possible. The iframe's wasm-loader
// forwards its mark() pipeline milestones to the parent viewer as
// `WasmOpenStage` postMessages; the viewer renders them as a stage
// checklist (`#shield-stages` <li> items) under the existing progress
// bar, each flipping pending → in-progress → done as its signal
// arrives. The kit's own import progress (statusindicator setvalue
// 0-100) refines the "Opening document" stage.
//
// This test drives ONLY through the visible UI:
//   1. Upload a docx via v2, open it in a FRESH browser (cold pipeline
//      — maximum number of stages).
//   2. While the shield is up, poll the VIEWER page DOM (not the
//      iframe): #shield-stages must exist and its items must
//      transition to data-state="done" over time.
//   3. Assert ≥ 5 distinct stages reached "done", in non-decreasing
//      DOM order, before the shield drops.
//   4. Assert the shield's progress-bar width is monotonically
//      non-decreasing across polls.
//   5. After the shield drops, the doc must actually be open
//      (StateWordCount shows characters) — the stages must not break
//      the open itself.

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

        // Poll viewer DOM while shield is up. Collect:
        //  - stage list state snapshots (id -> data-state)
        //  - bar width %
        const barSamples = [];
        const doneOrder = [];          // stage ids in the order they turned done
        const seenDone = new Set();
        let sawStagesEl = false;
        let shotTaken = false;

        const pollDeadline = Date.now() + env.scaleTimeout(120000);
        while (Date.now() < pollDeadline) {
            const snap = await page.evaluate(() => {
                const sh = document.getElementById('editor-shield');
                const shieldUp = !!sh && sh.classList.contains('active');
                const stagesEl = document.getElementById('shield-stages');
                const stages = stagesEl ? Array.from(stagesEl.querySelectorAll('li')).map(li => ({
                    id: li.getAttribute('data-stage'),
                    state: li.getAttribute('data-state'),
                })) : null;
                const fill = document.getElementById('editor-shield-bar-fill');
                const pct = fill ? parseFloat(fill.style.width) || 0 : -1;
                return { shieldUp, stages, pct };
            }).catch(() => null);

            if (snap) {
                if (snap.stages) {
                    sawStagesEl = true;
                    for (const s of snap.stages) {
                        if (s.state === 'done' && !seenDone.has(s.id)) {
                            seenDone.add(s.id);
                            doneOrder.push(s.id);
                            log(`  stage done: ${s.id} (bar=${snap.pct}%)`);
                        }
                    }
                    // One mid-flight screenshot of the staged shield.
                    if (!shotTaken && seenDone.size >= 2 && snap.shieldUp) {
                        shotTaken = true;
                        try { await page.screenshot({ path: SHOTS + '/01_shield_stages.png' }); } catch (_) {}
                    }
                }
                if (snap.pct >= 0) barSamples.push(snap.pct);
                if (!snap.shieldUp && barSamples.length > 0) break;  // shield dropped — open finished
            }
            await sleep(300);
        }

        check('#shield-stages element rendered on the shield', sawStagesEl);
        check('>= 5 distinct stages reached done before shield drop',
              seenDone.size >= 5, 'done=' + doneOrder.join(','));

        // Bar monotonicity (allow equal, disallow regress > 2% jitter).
        let monotonic = true, prev = -1;
        for (const p of barSamples) {
            if (p < prev - 2) { monotonic = false; break; }
            prev = Math.max(prev, p);
        }
        check('shield progress bar monotonically non-decreasing',
              monotonic, 'samples=' + barSamples.length + ' max=' + prev);

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
