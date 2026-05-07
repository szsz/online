// Regression: finalize-build.sh's Step 6 (brotli sidecars) must
// include *.metadata in the glob list it passes to
// brotli-sidecar.sh.
//
// Background: iter 11 caught a real miss in production — the
// build's brotli step globbed *.js / *.css / *.wasm / *.data but
// not *.metadata. The deployed editor shipped soffice.data.js.
// <hash>.metadata uncompressed (~214 KB) on every cold load. The
// fix added "*.metadata" to the explicit list at
// wasm/tools/finalize-build.sh:213.
//
// This test pins that line so a future cleanup (someone refactors
// the brotli step to use a more compact list, or removes "old"
// extensions thinking they're unused) can't silently regress
// metadata coverage. The deployed-editor brotli-sidecar test
// (test-regression-brotli-sidecar.js) catches the same bug
// downstream — but only if the deploy actually shipped — and
// requires a full build to run. This is a static check with no
// I/O, runs in <50ms.
//
// What is checked:
//   1. wasm/tools/finalize-build.sh exists and contains a Step 6
//      block that invokes wasm/tools/brotli-sidecar.sh.
//   2. The argument list passed to brotli-sidecar.sh contains a
//      glob pattern matching *.metadata under browser/dist.
//
// If brotli-sidecar.sh is later replaced with a directory-walking
// helper (find ... | xargs brotli), update this test to match the
// new shape — but only when ALL build-tree extensions are confirmed
// to be picked up by the new approach.

'use strict';

const fs = require('fs');
const path = require('path');
const __cl = require('./lib/inject-checklist');

const FINALIZE = path.join(__dirname, 'tools', 'finalize-build.sh');

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
    console.log('=== Regression: finalize-build.sh brotli covers *.metadata ===');

    let src;
    try {
        src = fs.readFileSync(FINALIZE, 'utf8');
    } catch (e) {
        check('finalize-build.sh readable', false, e.message);
        process.exit(1);
    }
    check('finalize-build.sh readable', true, `${src.length} bytes`);

    // Find the Step 6 block.
    const stepIdx = src.indexOf('Step 6: brotli sidecars');
    check('Step 6 brotli sidecars block present', stepIdx >= 0,
          stepIdx >= 0 ? 'found' : 'missing');
    if (stepIdx < 0) {
        console.log('Duration: ', '<1ms');
        process.exit(1);
    }

    // Capture the bash invocation that follows. Take the next ~1500
    // chars — long enough to cover the multi-line backslash list.
    const block = src.slice(stepIdx, stepIdx + 1500);

    check('block invokes brotli-sidecar.sh',
          block.includes('brotli-sidecar.sh'),
          'wasm/tools/brotli-sidecar.sh');

    // The actual assertion: the brotli-sidecar argument list must
    // include a *.metadata glob under browser/dist. Match either
    // the literal `"$BUILD_DIR/browser/dist"/*.metadata` form or
    // any future variant that ends in `*.metadata`.
    const metadataGlob = /["'`]?\$\{?BUILD_DIR\}?\/browser\/dist["'`]?\s*\/\*\.metadata\b/;
    check('brotli step globs *.metadata under browser/dist',
          metadataGlob.test(block),
          metadataGlob.test(block) ? 'matched' :
              block.match(/browser\/dist[^\n]*/g)?.slice(0, 3).join('  |  ') || 'no match');

    // Also assert the existing extensions are still covered — a
    // refactor that swaps *.metadata in but drops *.js/*.wasm/etc
    // would be a separate regression.
    const requiredGlobs = [
        /["'`]?\$\{?BUILD_DIR\}?\/browser\/dist["'`]?\s*\/\*\.js\b/,
        /["'`]?\$\{?BUILD_DIR\}?\/browser\/dist["'`]?\s*\/\*\.wasm\b/,
        /["'`]?\$\{?BUILD_DIR\}?\/browser\/dist["'`]?\s*\/\*\.data\b/,
        /["'`]?\$\{?BUILD_DIR\}?\/browser\/dist["'`]?\s*\/\*\.css\b/,
    ];
    const labels = ['*.js', '*.wasm', '*.data', '*.css'];
    for (let i = 0; i < requiredGlobs.length; i++) {
        check(`brotli step still globs ${labels[i]}`,
              requiredGlobs[i].test(block),
              'browser/dist');
    }

    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e);
    process.exit(2);
});
