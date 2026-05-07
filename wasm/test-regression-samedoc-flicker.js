// Regression: same-type hot-switch flickers the document title bar.
//
// Repro: viewer is sitting on doc A (writer-1.docx). User clicks doc B
// in the file-list — same type, so it hot-switches via RelaySwitchRoom +
// `#switchdoc=`. Then the user clicks doc A again — same type, second
// hot-switch. Expected behaviour: the visible title (`#document-name-input`
// inside the cool.html iframe and `document.title`) ends as A's
// displayName and never oscillates between A and B.
//
// Observed bug: the title flickers — the input value bounces between
// A's and B's displayName for several seconds after the second click.
// Root cause is multiple competing writers in wasm-loader.js + COOL:
//   - wasm-loader.js:119 long-running `applyName` interval (120 s)
//     reads the closure `displayName` var (mutated on every
//     `checkHashSwitch`).
//   - wasm-loader.js:557 `docNameSetInt` started on every `trySendSwitch`
//     and runs for 15 s. It captures `titleText` at create-time, so two
//     consecutive switches leave TWO intervals running in parallel,
//     each writing a different name every 250 ms.
//   - COOL Map.WOPI._setWopiProps + Control.DocumentNameInput.onWopiProps
//     (browser/src/control/Control.DocumentNameInput.js:155) — when kit
//     emits a fresh `wopi:` for the new doc, the input is rewritten
//     with the WOPISrc-derived BaseFileName (the opaque fileId in v2),
//     which then gets clobbered by wasm-loader's poll a few hundred ms
//     later.
//
// This test:
//   1. Uploads 2 same-type writer files via v2 (each gets its own
//      cachedName so the viewer passes a `displayName=` to the iframe).
//   2. Opens A → B → A through the sidebar (real user click sequence).
//   3. Installs a MutationObserver + property-write hook on
//      `#document-name-input` inside the cool.html iframe at startup.
//      Records every observed value with a timestamp from the first
//      open onward.
//   4. After the final A click, polls for 6 s collecting samples.
//   5. Asserts the terminal value equals A's displayName, the title
//      bar does NOT contain the opaque fileId, and the value did not
//      oscillate (count of A↔B transitions in the last 4 s after
//      the second click ≤ 1).
//
// On the bug: assertions fail because the timeline shows
// A → fileIdA → B → fileIdB → ... → A → B → A → B → A.

const __cl = require('./lib/inject-checklist');
const { launch, sleep } = require('./lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-samedoc-flicker';
const LOG_DIR = SHOT_DIR; // co-locate the timeline log with shots
// Use two visually-DISTINCT fixtures so the wasm-loader's
// canvas-change hot-switch watchdog can actually fire its
// "switch succeeded" signal. Earlier this test reused the same
// docx for A and B (with a 2-byte trailing append for B), but
// (a) the trailing bytes corrupt the zip → LO falls back, and
// (b) both rendered identically → canvas-change watchdog never
// resolved → hot-switch was treated as failed → the recovery
// path created a new iframe with stale displayName state, so
// the test asserted on a stuck title that was a real-world
// recovery side-effect rather than the flicker bug it set out
// to catch. Distinct content keeps the test on the hot-switch
// happy-path where the title-flicker is the only thing left
// to assert on.
const SRC_A = '/home/localadmin/online/test/data/test document.docx';
const SRC_B = '/home/localadmin/online/test/data/Simple small document.docx';

const T0 = Date.now();
function log(m) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); }

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ok ${label}`);
    else { log(`  FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

let shotN = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotN).padStart(2, '0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch (e) {}
}

function getEditorFrame(page) {
    return page.frames().find(f => f.url().includes('cool.html'));
}

// Inject the recorder into the iframe. Records every change to
// #document-name-input.value via:
//   (a) MutationObserver on attribute changes
//   (b) setInterval polling at 50 ms — catches direct .value =
//       assignments that don't reflect to the attribute. This is
//       what wasm-loader.js does (line 565: nameInput.value = titleText).
// Each sample is { t: msSinceInstall, value: <string> }.
async function installRecorder(frame) {
    await frame.evaluate(() => {
        if (window.__nameRecorder) return; // idempotent
        var rec = { samples: [], titleSamples: [], installedAt: Date.now() };
        window.__nameRecorder = rec;
        var lastInputVal = null;
        var lastTitle = null;
        function record(value) {
            if (value === lastInputVal) return;
            lastInputVal = value;
            rec.samples.push({ t: Date.now() - rec.installedAt, value: value });
        }
        function recordTitle(value) {
            if (value === lastTitle) return;
            lastTitle = value;
            rec.titleSamples.push({ t: Date.now() - rec.installedAt, value: value });
        }
        // Poll loop — catches .value = assignments. 50 ms cadence is
        // 5x finer than wasm-loader's 250 ms write cadence, so we
        // shouldn't miss any flip.
        rec._int = setInterval(function() {
            try {
                var ni = document.querySelector('#document-name-input');
                if (ni) record(ni.value);
                recordTitle(document.title);
            } catch (e) {}
        }, 50);
        // MutationObserver as a backup / cross-check.
        function tryAttachMo() {
            var ni = document.querySelector('#document-name-input');
            if (!ni || rec._mo) return;
            try {
                rec._mo = new MutationObserver(function() { record(ni.value); });
                rec._mo.observe(ni, { attributes: true, attributeFilter: ['value'] });
                record(ni.value); // initial snapshot
            } catch (e) {}
        }
        tryAttachMo();
        rec._attachInt = setInterval(tryAttachMo, 200);
    });
}

async function dumpRecorder(frame) {
    return frame.evaluate(() => {
        if (!window.__nameRecorder) return null;
        return {
            samples: window.__nameRecorder.samples.slice(),
            titleSamples: window.__nameRecorder.titleSamples.slice(),
        };
    });
}

// Open the viewer, wait for prewarm, install the name-recorder.
async function openViewer(browser, recentList, label) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.on('console', m => {
        const t = m.text();
        if (/error|Error|FAIL/.test(t) && !/PostMessage ignored/.test(t))
            console.log(`  [${label}/console] ${t.substring(0, 220)}`);
    });
    page.on('pageerror', e => console.log(`  [${label}/PAGEERR] ${e.message.substring(0, 220)}`));
    if (recentList) {
        await page.evaluateOnNewDocument(list => {
            localStorage.setItem('rf_v1', JSON.stringify({ files: list }));
        }, recentList);
    }
    await page.goto(VIEWER + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Wait for prewarm
    for (let i = 0; i < 240; i++) {
        await sleep(500);
        const fr = getEditorFrame(page);
        if (fr) {
            try {
                const ready = await fr.evaluate(() => !!window.__wasmPrewarmReady);
                if (ready) {
                    log(`[${label}] prewarm ready in ~${(i * 0.5).toFixed(1)}s`);
                    await installRecorder(fr);
                    return { ctx, page };
                }
            } catch (e) {}
        }
    }
    throw new Error(`[${label}] prewarm did not complete`);
}

async function clickFile(page, fileId) {
    await page.evaluate(id => {
        const el = document.querySelector(`.file[data-fileid="${id}"]`);
        if (!el) throw new Error('No sidebar entry: ' + id);
        el.click();
    }, fileId);
}

// Wait for the viewer's shield to drop. Same pattern as the existing
// same-type hot-switch test.
async function waitForShieldDrop(page, timeoutMs) {
    return page.evaluate(async timeoutMs => {
        const t0 = Date.now();
        let sawShieldUp = false;
        while (Date.now() - t0 < timeoutMs) {
            const sh = document.getElementById('editor-shield');
            const visible = sh && !sh.classList.contains('hidden') &&
                getComputedStyle(sh).display !== 'none';
            if (visible) sawShieldUp = true;
            if (sawShieldUp && !visible) return { ok: true, ms: Date.now() - t0 };
            await new Promise(r => setTimeout(r, 100));
        }
        return { ok: false, ms: Date.now() - t0, sawShieldUp };
    }, timeoutMs);
}

// Count A<->B transitions in `samples` (ignoring transient values like
// the fileId or undefined). A "transition" is a sample whose value
// differs from the previous filtered sample. A→B and B→A both count.
function countAbTransitions(samples, nameA, nameB) {
    let prev = null;
    let count = 0;
    for (const s of samples) {
        // Only consider samples whose value is exactly A or B; skip
        // intermediate values (fileId, blank, etc.) so we measure
        // ping-pong specifically between the two display names.
        if (s.value !== nameA && s.value !== nameB) continue;
        if (prev !== null && s.value !== prev) count++;
        prev = s.value;
    }
    return count;
}

// Compress a sample stream into a short readable timeline.
function fmtTimeline(samples, maxRows) {
    const rows = [];
    for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        rows.push(`  [+${(s.t / 1000).toFixed(2)}s] "${s.value}"`);
    }
    if (rows.length > maxRows) {
        return rows.slice(0, Math.floor(maxRows / 2)).concat(['  ...'])
            .concat(rows.slice(-Math.floor(maxRows / 2))).join('\n');
    }
    return rows.join('\n');
}

(async () => {
    log('=== Regression: same-type hot-switch title flicker ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const STAMP = Date.now();
    // Use a recognisable plaintext display name. Same writer type so
    // the viewer always takes the hot-switch path.
    const NAME_A = `samedoc-flicker-A-${STAMP}.docx`;
    const NAME_B = `samedoc-flicker-B-${STAMP}.docx`;
    const bytesA = fs.readFileSync(SRC_A);
    const bytesB = fs.readFileSync(SRC_B);

    const { browser, cleanup } = await launch();

    try {
        const upA = await uploadV2(VIEWER, NAME_A, bytesA);
        const upB = await uploadV2(VIEWER, NAME_B, bytesB);
        log(`uploaded ${NAME_A} -> ${upA.fileId.substring(0, 8)}...`);
        log(`uploaded ${NAME_B} -> ${upB.fileId.substring(0, 8)}...`);

        const recentList = [
            { secret: upA.b64urlSecret, fileId: upA.fileId, cachedName: NAME_A,
              lastVisited: new Date().toISOString() },
            { secret: upB.b64urlSecret, fileId: upB.fileId, cachedName: NAME_B,
              lastVisited: new Date(Date.now() - 1).toISOString() },
        ];

        const { page } = await openViewer(browser, recentList, 'V');

        // Wait for the sidebar entries (seeded from rf_v1) to render.
        await page.waitForFunction(
            id => !!document.querySelector(`.file[data-fileid="${id}"]`),
            { timeout: 30000 }, upA.fileId);
        await page.waitForFunction(
            id => !!document.querySelector(`.file[data-fileid="${id}"]`),
            { timeout: 30000 }, upB.fileId);

        // ---- Click 1: open A ----
        log('\n--- Click 1: open A ---');
        await clickFile(page, upA.fileId);
        let r = await waitForShieldDrop(page, 90000);
        log(`A loaded (shield down in ${r.ms}ms, ok=${r.ok})`);
        // Re-attach recorder in case the iframe was reloaded (cold path).
        const fr1 = getEditorFrame(page);
        if (fr1) await installRecorder(fr1);
        await sleep(2000);
        await snap(page, 'after_A1');

        // ---- Click 2: open B ----
        log('\n--- Click 2: open B (hot-switch) ---');
        await clickFile(page, upB.fileId);
        r = await waitForShieldDrop(page, 90000);
        log(`B loaded (shield down in ${r.ms}ms, ok=${r.ok})`);
        const fr2 = getEditorFrame(page);
        if (fr2) await installRecorder(fr2); // idempotent
        await sleep(2000);
        await snap(page, 'after_B');

        // ---- Click 3: back to A ----
        log('\n--- Click 3: back to A (hot-switch) ---');
        const click3At = Date.now();
        await clickFile(page, upA.fileId);
        r = await waitForShieldDrop(page, 90000);
        log(`A2 loaded (shield down in ${r.ms}ms, ok=${r.ok})`);
        const fr3 = getEditorFrame(page);
        if (fr3) await installRecorder(fr3);

        // Wait for the title to actually stabilize on A — poll until
        // the input + document.title both equal NAME_A for 2 consecutive
        // seconds (no further writes), with a 30 s ceiling. This
        // replaces a fixed 6 s wait that was insufficient when the
        // wasm-loader's 15 s `docNameSetInt` interval (per the
        // root-cause comment up top) wrote a stale value AFTER the 6 s
        // window closed, making the final-sampled value undeterministic
        // on contended runs. "Wait for state, not for time" — once we
        // see 2 s of A-only writes, the parallel intervals have
        // converged and any subsequent assertion is deterministic.
        log('Waiting for title to stabilize on A (max 30 s)...');
        const stabT0 = Date.now();
        let stableSince = null;
        while (Date.now() - stabT0 < 30000) {
            const fr = getEditorFrame(page);
            if (!fr) { await sleep(200); continue; }
            const cur = await fr.evaluate(() => {
                const el = document.getElementById('document-name-input');
                return { input: el ? el.value : '', title: document.title };
            }).catch(() => null);
            if (cur && cur.input === NAME_A && cur.title === NAME_A) {
                if (stableSince === null) stableSince = Date.now();
                if (Date.now() - stableSince >= 2000) break;
            } else {
                stableSince = null;
            }
            await sleep(200);
        }
        log(`Title stabilization wait: ${(Date.now() - stabT0) / 1000}s ` +
            `(stable=${stableSince !== null})`);
        await snap(page, 'after_A2_settle');

        const fr = getEditorFrame(page);
        const dump = fr ? await dumpRecorder(fr) : null;
        if (!dump) {
            check('recorder produced data', false, 'no iframe / no recorder');
            throw new Error('recorder dump failed');
        }

        // Note: sample timestamps are relative to recorder install
        // (per-iframe). Absolute alignment to click3 isn't needed —
        // we read the LAST 5 s of the timeline regardless.
        void click3At;
        const log_lines = [];
        log_lines.push('=== document-name-input timeline (since recorder install) ===');
        log_lines.push(fmtTimeline(dump.samples, 200));
        log_lines.push('');
        log_lines.push('=== document.title timeline ===');
        log_lines.push(fmtTimeline(dump.titleSamples, 100));
        const logPath = path.join(LOG_DIR, 'flicker-timeline.log');
        fs.writeFileSync(logPath, log_lines.join('\n'));
        log(`Timeline written to ${logPath} (${dump.samples.length} input samples, ${dump.titleSamples.length} title samples)`);

        // ---- ASSERTIONS ----
        // Look at the FINAL state.
        const finalInput = dump.samples.length ? dump.samples[dump.samples.length - 1].value : '';
        const finalTitle = dump.titleSamples.length ? dump.titleSamples[dump.titleSamples.length - 1].value : '';
        log(`Final #document-name-input value: "${finalInput}"`);
        log(`Final document.title:             "${finalTitle}"`);

        check('final input value equals A displayName', finalInput === NAME_A,
              `got="${finalInput}" want="${NAME_A}"`);
        check('final document.title equals A displayName', finalTitle === NAME_A,
              `got="${finalTitle}" want="${NAME_A}"`);
        // The opaque fileId should never be the FINAL displayed value.
        check('final input is not opaque fileId',
              !/^[0-9a-f]{64}$/i.test(finalInput),
              'final="' + finalInput + '"');

        // Oscillation check: the most diagnostic. Use only the LAST 5
        // seconds of samples — earlier samples are expected to flip
        // once per real switch (A → fileId-of-B → B during click 2,
        // B → fileId-of-A → A during click 3). What we're flagging is
        // the SUBSEQUENT oscillation that comes from the parallel
        // 15s-poll intervals.
        const tail = dump.samples.length
            ? dump.samples.filter(s => s.t >= dump.samples[dump.samples.length - 1].t - 5000)
            : [];
        const transitions = countAbTransitions(tail, NAME_A, NAME_B);
        log(`A<->B transitions in last 5s of input timeline: ${transitions}`);
        check('input value does not oscillate (transitions <= 1 in tail)',
              transitions <= 1,
              'transitions=' + transitions);

        // Same check on document.title for completeness.
        const tailT = dump.titleSamples.length
            ? dump.titleSamples.filter(s => s.t >= dump.titleSamples[dump.titleSamples.length - 1].t - 5000)
            : [];
        const titleTransitions = countAbTransitions(tailT, NAME_A, NAME_B);
        log(`A<->B transitions in last 5s of title timeline: ${titleTransitions}`);
        check('document.title does not oscillate (transitions <= 1 in tail)',
              titleTransitions <= 1,
              'transitions=' + titleTransitions);

        log('\n' + (allPassed ? 'PASS: no flicker observed' : 'FAIL: flicker observed (see timeline log)'));
    } catch (e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        await cleanup();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
