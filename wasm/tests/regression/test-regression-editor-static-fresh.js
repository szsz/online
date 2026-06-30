// Regression: editor-static-server.js must serve PR #78's /browser/dist/
// → /browser/ rewrite. If the running editor-static-server process predates
// PR #78 (merged 2026-05-13), it serves the source rewrite as 404 because
// the rewrite code is on disk but not loaded. Symptom: viewer cold-open
// fails because iframe URL `${EDITOR}/<id?>/browser/dist/cool.html` 404s,
// kit never starts, canvas never paints, frame detaches after 60s.
//
// This test catches the staleness BEFORE running the kit-paint cluster.
//
// What it asserts:
//   1. GET ${EDITOR}/browser/dist/cool.html returns 200 (rewrite active).
//   2. The served body is an HTML page (not a 404 page that happens to be
//      cached as text/html).
//
// Cheap: 1 HEAD + 1 GET, <1s. Goes first in run-all-tests.sh so the
// other test logs aren't filled with red herrings when the editor is stale.

'use strict';

const env = require('../../lib/test-env');
const __cl = require('../../lib/inject-checklist');

const EDITOR = env.EDITOR_URL;
let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) console.log('  ✓ ' + label);
    else {
        console.log('  ✗ FAIL: ' + label + (ev ? ' [' + ev + ']' : ''));
        allPassed = false;
    }
}

(async () => {
    console.log('=== Regression: editor-static-server serves /browser/dist/ ===');
    const t0 = Date.now();

    const url = EDITOR + '/browser/dist/cool.html';
    let resp;
    try {
        resp = await fetch(url);
    } catch (e) {
        check('GET ' + url + ' reachable', false, e.message);
        process.exit(1);
    }

    check('GET /browser/dist/cool.html → 200', resp.status === 200,
          'HTTP ' + resp.status);

    if (resp.status === 200) {
        const body = await resp.text();
        check('body looks like cool.html (has <!DOCTYPE + cool/online refs)',
              /<!DOCTYPE\s+html/i.test(body)
              && (/cool/i.test(body) || /online\.wasm/i.test(body)),
              body.slice(0, 80));
    } else {
        console.log('  · Hint: the editor-static-server process is stale —');
        console.log('    PR #78 added a /browser/dist/<x> → /browser/<x> rewrite');
        console.log('    that the running process predates. Restart it via');
        console.log('    wasm/deploy.sh (which now handles this automatically),');
        console.log('    or kill + relaunch via launch-editor-static.sh.');
    }

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e);
    process.exit(2);
});
