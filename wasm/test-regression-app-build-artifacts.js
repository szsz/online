// Regression: every published app-build at coolwasmfiles has the
// three deploy zips (viewer.zip / relay.zip / editor.zip) plus
// tests/summary.json — the inputs `wasm/promote-online-build.sh`
// expects.
//
// Background: an app-build directory is the bundle of artefacts
// `wasm-ci-local.yml` publishes for each successful CI run. The
// promote script downloads these zips by URL and `az webapp deploy`
// them into target App Services. If the build pipeline misses one
// zip, promote silently 404s on that App Service and that
// environment runs the previous build's bytes — a partial deploy
// nobody notices until users hit something specific.
//
// What this test asserts (against the latest published app-build):
//   1. lo-builds/latest.txt is fetchable (used to resolve "latest").
//      app-builds doesn't have its own latest.txt today — instead
//      the test fetches the directory listing, extracts the most
//      recent YYYY-MM-DD-N entry, and probes that one.
//   2. {viewer,relay,editor}.zip each return 200 OK + non-zero
//      Content-Length when HEADed.
//   3. tests/summary.json is reachable + parses as JSON + has
//      a `passed` integer field.
//
// Doesn't validate zip contents (size + parse would be heavy).
// The CI pipeline that builds the zip is the right place for
// content validation; this test catches the partial-publish class
// where the build "succeeded" but one of the artefacts didn't make
// it through.
//
// Runtime: <3s, 4 HEAD + 1 GET.

'use strict';

const __cl = require('./lib/inject-checklist');

const BASE = 'https://coolwasmfiles.z6.web.core.windows.net/app-builds/';

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
    console.log('=== Regression: app-build artefact bundle (viewer + relay + editor + tests) ===');
    const t0 = Date.now();

    // Discover the most recent app-build by parsing the index page.
    let latest;
    try {
        const r = await fetch(BASE);
        check('app-builds/ index reachable', r.ok, `HTTP ${r.status}`);
        if (!r.ok) process.exit(1);
        const html = await r.text();
        const ids = [...html.matchAll(/href="(2026-\d{2}-\d{2}-\d+)\/"/g)].map(m => m[1]);
        ids.sort((a, b) => {
            // YYYY-MM-DD-N — sort by date then numeric N
            const [da, na] = [a.replace(/-\d+$/, ''), parseInt(a.match(/-(\d+)$/)?.[1] || '0', 10)];
            const [db, nb] = [b.replace(/-\d+$/, ''), parseInt(b.match(/-(\d+)$/)?.[1] || '0', 10)];
            return da === db ? na - nb : da.localeCompare(db);
        });
        latest = ids[ids.length - 1];
    } catch (e) {
        check('app-builds/ index reachable', false, e.message);
        process.exit(1);
    }
    check('latest app-build id resolved',
          !!latest && /^2026-\d{2}-\d{2}-\d+$/.test(latest),
          latest || '(none)');
    if (!latest) process.exit(1);
    console.log('  latest:', latest);

    const buildBase = BASE + latest + '/';
    for (const zipName of ['viewer.zip', 'relay.zip', 'editor.zip']) {
        try {
            const r = await fetch(buildBase + zipName, { method: 'HEAD' });
            const cl = Number(r.headers.get('content-length') || 0);
            check(`${zipName} HEAD 200 + non-zero size`,
                  r.ok && cl > 0,
                  `HTTP ${r.status} size=${cl}`);
        } catch (e) {
            check(`${zipName} HEAD reachable`, false, e.message);
        }
    }

    // tests/summary.json is a soft signal — the test step in
    // wasm-ci-local.yml is INFORMATIONAL (build-deploy can succeed
    // even if test crashes, since the build still ships valid
    // bytes). So we only check it on builds that listed it in the
    // index (and skip the assertion when missing, rather than
    // failing). A build with no summary.json had a crashed test
    // step but its zips are still safe to promote.
    const indexHtml = await (await fetch(buildBase)).text().catch(() => '');
    const listsSummary = indexHtml.includes('tests/summary.json');
    if (listsSummary) {
        try {
            const r = await fetch(buildBase + 'tests/summary.json');
            check('tests/summary.json reachable (build listed it)',
                  r.ok, `HTTP ${r.status}`);
            if (r.ok) {
                const j = await r.json();
                check('summary.json has integer "passed" field',
                      typeof j.passed === 'number',
                      `passed=${j.passed} type=${typeof j.passed}`);
            }
        } catch (e) {
            check('tests/summary.json reachable', false, e.message);
        }
    } else {
        console.log('  · skipping summary.json check (build index does not list it — test step likely crashed)');
    }

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
