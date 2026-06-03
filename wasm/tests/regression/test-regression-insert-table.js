const __cl = require('../../lib/inject-checklist');
// Regression: inserting a table into an empty Writer document crashed
// Kit with:
//   RuntimeError: memory access out of bounds
//     SvxAutoFormatData::SvxAutoFormatData(SvxAutoFormatData const&)
//     SwTableAutoFormat::SwTableAutoFormat(SwTableAutoFormat const&)
//     SwBaseShell::InsertTable(SfxRequest&)
//
// Fix is LO Core (C++) — this test is the locked-down reproducer that
// fails today and flips green when the fix lands.
//
// Migrated to the viewer flow (lib/open-via-viewer.js).

'use strict';

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { openViaViewer } = require('../../lib/open-via-viewer');

const VIEWER = env.FILE_STORAGE_URL;
const TIMEOUT = env.scaleTimeout(180000);
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-insert-table';
const DOC_NAME = 'inserttable-' + Date.now() + '.docx';
const FIXTURE = path.join(__dirname, '..', 'test', 'data', 'new.docx');

const T0 = Date.now();
function log(m) { console.log('[' + ((Date.now()-T0)/1000).toFixed(1) + 's] ' + m); }

let snapN = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    try { await page.screenshot({ path: SHOT_DIR + '/' + String(++snapN).padStart(2,'0') + '_' + name + '.png' }); } catch(e) {}
}

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log('  ✓ ' + label);
    else { log('  ✗ FAIL: ' + label + (ev ? ' [' + ev + ']' : '')); allPassed = false; }
}

async function waitForLoaded(frame, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ready = await frame.evaluate(() => {
            const wc = document.querySelector('#StateWordCount');
            return wc && wc.textContent && /\d+\s+characters/i.test(wc.textContent)
                ? wc.textContent.trim() : null;
        }).catch(() => null);
        if (ready) return ready;
        await sleep(500);
    }
    return null;
}

async function getCharCount(frame) {
    const txt = await frame.evaluate(() =>
        document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
    const m = (txt || '').match(/(\d+)\s+characters/i);
    return m ? parseInt(m[1]) : -1;
}

(async () => {
    log('=== Regression: insert table into empty doc (LO Core crash) ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(FIXTURE)) { log('ERROR: fixture missing'); process.exit(1); }

    const { browser, cleanup } = await launch();
    const oobErrors = [];
    const autoformatErrors = [];

    try {
        const docBytes = fs.readFileSync(FIXTURE);

        const { page, editorFrame } = await openViaViewer(
            browser, VIEWER, DOC_NAME, docBytes,
            { iframeTimeout: TIMEOUT,
              gotoTimeout: 30000,
              viewport: { width: 1280, height: 900 },
              onPage: p => {
                  p.on('pageerror', e => {
                      const m = (e.message || '') + ' ' + (e.stack || '');
                      if (m.includes('memory access out of bounds')) oobErrors.push(m.substring(0, 500));
                      if (m.includes('AutoFormat') || m.includes('SvxAutoFormatData')) autoformatErrors.push(m.substring(0, 500));
                  });
                  p.on('console', msg => {
                      const t = msg.text();
                      if (t.includes('memory access out of bounds')) oobErrors.push(t.substring(0, 500));
                      if (t.includes('SvxAutoFormatData') || t.includes('SwTableAutoFormat')) autoformatErrors.push(t.substring(0, 500));
                  });
              },
            });

        const ready = await waitForLoaded(editorFrame, TIMEOUT);
        check('Doc loaded', !!ready, 'status=' + ready);
        if (!ready) {
            log('Aborting: doc never loaded');
            process.exit(1);
        }
        const initChars = await getCharCount(editorFrame);
        log('Initial: ' + initChars + ' chars');
        await snap(page, 'loaded');

        // Focus the canvas so the UNO command lands. The viewer iframes
        // the editor fullscreen — page coords work.
        await page.mouse.click(640, 400);
        await sleep(600);

        log('Dispatching .uno:InsertTable (2 cols × 2 rows)…');
        const dispatched = await editorFrame.evaluate(() => {
            try {
                if (typeof TheFakeWebSocket === 'undefined' || !TheFakeWebSocket.send) {
                    return 'no-fake-ws';
                }
                TheFakeWebSocket.send(
                    'uno .uno:InsertTable {"Columns":{"type":"long","value":2},"Rows":{"type":"long","value":2}}'
                );
                return 'sent';
            } catch(e) { return 'err-' + e.message; }
        });
        check('.uno:InsertTable dispatched to Kit', dispatched === 'sent', 'result=' + dispatched);

        // Give Kit time to process the command. If the SvxAutoFormatData
        // copy-ctor is going to blow, it happens within the first
        // couple hundred ms of command processing.
        await sleep(8000);
        await snap(page, 'after_insert');

        check('No memory access out of bounds errors',
              oobErrors.length === 0,
              oobErrors.length + ' OOB: ' + ((oobErrors[0] || '').substring(0, 240)));

        check('No SvxAutoFormatData / SwTableAutoFormat copy-ctor errors',
              autoformatErrors.length === 0,
              autoformatErrors.length + ' AF: ' + ((autoformatErrors[0] || '').substring(0, 240)));

        const afterChars = await getCharCount(editorFrame);
        log('After: ' + afterChars + ' chars');
        check('InsertTable completed (char count preserved, no crash)',
              afterChars >= initChars,
              'before=' + initChars + ' after=' + afterChars);

        log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    } catch(e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        await cleanup();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
