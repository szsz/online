// Regression: each launcher's required-env-vars block exists and
// test-env.js's `required` list is a superset of launch-viewer.sh's.
//
// Background: when adding a new env-var dependency to one of the
// launchers (e.g. launch-relay.sh gains a new RELAY_PUB var), the
// per-launcher check at the top of the launcher fires with a
// human-readable error if the var is unset. But the corresponding
// `required` list in wasm/lib/test-env.js — which gates test
// suite startup — has to be updated by hand. When it isn't, tests
// boot with the new var unset and fail in confusing ways much
// later (relay rejects connections, viewer 500s, etc.).
//
// What this test asserts:
//   1. Every `wasm/launch-*.sh` (viewer, relay, editor-static) has
//      at least one "is unset" guard — the refactor where someone
//      "simplifies" the launcher and drops the guard should fire.
//   2. wasm/lib/test-env.js's `required` array is a SUPERSET of
//      launch-viewer.sh's per-var loop. Tests boot the viewer; if
//      a required viewer var isn't in test-env.js's required list,
//      tests will silently start with it unset.
//
// Why a static test rather than runtime: starting all three
// launchers in a tmpdir to verify their guards is heavyweight
// (sudo, ssl certs, port allocation). The grep-based static check
// catches the same drift class, runs in <100ms.

'use strict';

const fs = require('fs');
const path = require('path');
const __cl = require('../../lib/inject-checklist');

const WASM_DIR = __dirname;

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) console.log('  ✓ ' + label);
    else {
        console.log('  ✗ FAIL: ' + label + (ev ? ' [' + ev + ']' : ''));
        allPassed = false;
    }
}

// Pull the required-vars list out of a launcher script. Matches
// either:
//   `for var in A B C; do ... is unset ...`         (viewer, relay)
//   `if [[ -z "${A:-}" ]]; then ... A is unset ...` (editor-static)
function loadRequiredVars(scriptSrc) {
    const vars = new Set();
    // for-loop form
    for (const m of scriptSrc.matchAll(/for\s+var\s+in\s+([A-Z0-9_ ]+);\s*do[\s\S]+?is unset/g)) {
        for (const v of m[1].trim().split(/\s+/)) vars.add(v);
    }
    // single-var if form
    for (const m of scriptSrc.matchAll(/if\s+\[\[\s*-z\s+"\$\{([A-Z0-9_]+):?-?\}"\s*\]\];\s*then[\s\S]{0,200}?is unset/g)) {
        vars.add(m[1]);
    }
    return [...vars].sort();
}

(() => {
    console.log('=== Regression: launcher env-var guards + test-env.js coverage ===');
    const t0 = Date.now();

    const launchers = {
        viewer:        path.join(WASM_DIR, 'launch-viewer.sh'),
        relay:         path.join(WASM_DIR, 'launch-relay.sh'),
        editorStatic:  path.join(WASM_DIR, 'launch-editor-static.sh'),
    };
    const required = {};
    for (const [name, scriptPath] of Object.entries(launchers)) {
        let src;
        try { src = fs.readFileSync(scriptPath, 'utf8'); }
        catch (e) {
            check(`${name} launcher readable`, false, e.message);
            continue;
        }
        check(`${name} launcher readable`, true, `${src.length} bytes`);

        const vars = loadRequiredVars(src);
        check(`${name} launcher has required-var guards`,
              vars.length > 0,
              vars.length ? vars.join(',') : '(none — refactor dropped the guard?)');
        required[name] = vars;
    }

    // test-env.js's required list must include everything
    // launch-viewer.sh requires (tests boot the viewer).
    let testEnvSrc;
    try {
        testEnvSrc = fs.readFileSync(path.join(WASM_DIR, 'lib', 'test-env.js'), 'utf8');
    } catch (e) {
        check('lib/test-env.js readable', false, e.message);
        process.exit(allPassed ? 0 : 1);
    }
    check('lib/test-env.js readable', true, `${testEnvSrc.length} bytes`);

    const m = testEnvSrc.match(/const\s+required\s*=\s*\[([^\]]+)\]/);
    check('test-env.js required[] parses',
          !!m,
          m ? 'ok' : '(no match)');
    if (!m) process.exit(allPassed ? 0 : 1);

    const testEnvRequired = [...m[1].matchAll(/'([A-Z0-9_]+)'/g)].map(m => m[1]).sort();
    check('test-env.js required[] non-empty',
          testEnvRequired.length > 0,
          testEnvRequired.join(','));

    // The viewer's guards drive what tests need.
    const viewerVars = required.viewer || [];
    const missingFromTestEnv = viewerVars.filter(v => !testEnvRequired.includes(v));
    check(`test-env.js required[] is a superset of launch-viewer.sh's vars`,
          missingFromTestEnv.length === 0,
          missingFromTestEnv.length
              ? `missing: ${missingFromTestEnv.join(',')} — add to test-env.js`
              : `viewer=[${viewerVars.join(',')}] testEnv=[${testEnvRequired.join(',')}]`);

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})();
