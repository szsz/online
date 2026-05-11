// Regression: editor deploys land at ${EDITOR}/<APP_BUILD_ID>/ and
// publish a build-info.json metadata file inside that folder.
//
// Background (Phase 2 of the per-deploy-folder migration): each editor
// build deploys into its own /<id>/ subfolder on the editor static site;
// multiple deploys coexist on the same wwwroot so in-flight viewer
// tabs pointing at a previous id keep working. cache-bust-build.js's
// hashed-filename scheme becomes redundant because the folder path
// itself acts as the version. deploy-azure.sh writes a small
// build-info.json into each folder for observability + this test.
//
// What this test asserts:
//   1. env.EDITOR_DEPLOY_ID is set (CI deploy step exports it from
//      APP_BUILD_ID). When unset (local-dev or pre-Phase-2 flat deploy),
//      the test skips with a pass — there's nothing per-deploy to test
//      and the flat-fallback path is exercised by other regression tests.
//   2. GET ${EDITOR}/<id>/build-info.json returns 200.
//   3. The JSON parses and has an `id` field matching EDITOR_DEPLOY_ID
//      (so the deploy actually wrote to the folder it claimed to).
//   4. ${EDITOR}/<id>/browser/cool.html is reachable — the editor-server
//      per-deploy middleware correctly resolves the prefix.
//
// When this test fails: the per-deploy structure isn't there. Either
// deploy-azure.sh didn't stage into the subfolder, the editor-server
// middleware isn't stripping the prefix, or DEFAULT_DEPLOY_ID isn't
// pointing at this id. Each is a different failure mode the operator
// will need to chase via the deploy logs.
//
// Runtime: <1s, two GETs.

'use strict';

const env = require('./lib/test-env');
const __cl = require('./lib/inject-checklist');

const EDITOR = env.EDITOR_URL;
const DEPLOY_ID = env.EDITOR_DEPLOY_ID;

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
    console.log('=== Regression: editor per-deploy folder + build-info.json ===');
    const t0 = Date.now();

    if (!DEPLOY_ID) {
        console.log('  · EDITOR_DEPLOY_ID empty — flat editor or pre-Phase-2 deploy.');
        console.log('  · Skipping per-deploy-folder checks. (Pass.)');
        console.log('\nDuration:', Date.now() - t0, 'ms');
        process.exit(0);
    }

    // Sanity: id format must match what resolve-ids.sh emits.
    check('EDITOR_DEPLOY_ID matches YYYY-MM-DD-HHMMSS',
          /^\d{4}-\d{2}-\d{2}-\d{6}$/.test(DEPLOY_ID),
          DEPLOY_ID);

    // 1. build-info.json reachable + matches.
    const buildInfoUrl = EDITOR + '/' + DEPLOY_ID + '/build-info.json';
    let buildInfo;
    try {
        const r = await fetch(buildInfoUrl);
        check('build-info.json reachable', r.ok,
              `${buildInfoUrl} → HTTP ${r.status}`);
        if (!r.ok) process.exit(1);
        const ct = r.headers.get('content-type') || '';
        check('build-info.json content-type is JSON',
              /json/i.test(ct), ct);
        buildInfo = await r.json();
    } catch (e) {
        check('build-info.json reachable', false, e.message);
        process.exit(1);
    }
    check('build-info.json has an id field',
          typeof buildInfo.id === 'string', `id=${JSON.stringify(buildInfo.id)}`);
    check('build-info.json id matches EDITOR_DEPLOY_ID',
          buildInfo.id === DEPLOY_ID,
          `info.id=${buildInfo.id}  env=${DEPLOY_ID}`);
    // Optional but useful — log git_sha + deployed_at so the regression
    // report has provenance.
    if (buildInfo.git_sha) console.log('  · git_sha:    ' + buildInfo.git_sha);
    if (buildInfo.deployed_at) console.log('  · deployed:   ' + buildInfo.deployed_at);
    if (buildInfo.lo_build_id) console.log('  · LO build:   ' + buildInfo.lo_build_id);

    // 2. cool.html reachable via the explicit prefix path. The viewer
    // iframe URL uses exactly this shape (window.__CONFIG.EDITOR_DEPLOY_ID
    // -> EDITOR_BASE -> /<id>/browser/cool.html); if the editor-server
    // middleware fumbles the prefix, this would 404 even though the
    // build files are correctly on disk.
    const coolUrl = EDITOR + '/' + DEPLOY_ID + '/browser/cool.html';
    try {
        const r = await fetch(coolUrl);
        check('explicit-prefix cool.html reachable', r.ok,
              `${coolUrl} → HTTP ${r.status}`);
        if (r.ok) {
            const body = await r.text();
            check('cool.html body looks like HTML',
                  /<!DOCTYPE html|<html/i.test(body),
                  body.slice(0, 80));
        }
    } catch (e) {
        check('explicit-prefix cool.html reachable', false, e.message);
    }

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
