const __cl = require('./lib/inject-checklist');
// Regression: JOBS_SCALE timeout multiplier is wired through the
// stack. lib/test-env.js exports scaleTimeout, run-focused-tests.sh
// and run-all-tests-parallel.sh export JOBS_SCALE from JOBS, and
// the 9 known-flaky tests route their patience timeouts through
// env.scaleTimeout.
//
// This test never opens a browser. It re-requires lib/test-env
// under different JOBS_SCALE values and asserts the math, then
// greps the test files to confirm scaleTimeout is actually used.
//
// Doesn't run the failing tests — that's the suite's job. This
// test catches "someone deleted the env.scaleTimeout call by
// accident" before the suite has to discover it 30 minutes in.

const fs = require('fs');
const path = require('path');

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  PASS: ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

// We have to re-require test-env per scale because it caches JOBS_SCALE
// at module load time. Use require-fresh trick.
function loadEnv(scale) {
    if (scale != null) process.env.JOBS_SCALE = String(scale);
    else delete process.env.JOBS_SCALE;
    delete process.env.TIMEOUT_SCALE;
    const p = require.resolve('./lib/test-env');
    delete require.cache[p];
    return require(p);
}

(async () => {
    log('=== Regression: JOBS_SCALE wiring ===');

    // 1. Default scale = 1
    {
        const env = loadEnv(null);
        check('default JOBS_SCALE = 1', env.JOBS_SCALE === 1.0, 'got=' + env.JOBS_SCALE);
        check('scaleTimeout(30000) === 30000 default',
              env.scaleTimeout(30000) === 30000, '=' + env.scaleTimeout(30000));
    }

    // 2. JOBS_SCALE=2 doubles
    {
        const env = loadEnv(2);
        check('JOBS_SCALE=2 → 2',  env.JOBS_SCALE === 2,  'got=' + env.JOBS_SCALE);
        check('scaleTimeout(30000) → 60000',
              env.scaleTimeout(30000) === 60000, '=' + env.scaleTimeout(30000));
        check('scaleTimeout(120000) → 240000',
              env.scaleTimeout(120000) === 240000, '=' + env.scaleTimeout(120000));
    }

    // 3. Garbage values fall back to 1
    {
        const env = loadEnv('not-a-number');
        check('garbage JOBS_SCALE falls back to 1',
              env.JOBS_SCALE === 1, 'got=' + env.JOBS_SCALE);
    }
    {
        const env = loadEnv('-3');
        check('negative JOBS_SCALE falls back to 1',
              env.JOBS_SCALE === 1, 'got=' + env.JOBS_SCALE);
    }

    // 4. Cap at 5×
    {
        const env = loadEnv(100);
        check('JOBS_SCALE=100 capped at 5',
              env.JOBS_SCALE === 5, 'got=' + env.JOBS_SCALE);
    }

    // 5. The 9 previously-failing tests must all use env.scaleTimeout
    // somewhere. If a future edit accidentally drops the call, the
    // test would resume false-failing under contention without anyone
    // noticing.
    const SCALED_TESTS = [
        // Original 9 (iter 38 baseline failures)
        'test-late-join.js',
        'test-regression-delete-key-coedit.js',
        'test-regression-room-switch.js',
        'test-regression-insert-table.js',
        'test-regression-checkpoint-cursor-delete.js',
        'test-regression-calc-impress-edits.js',
        'test-regression-checkpoint-timing.js',
        'test-snapshot-cross-type.js',
        'test-prewarm-benchmark.js',
        // Focused-suite known flakes (run-focused-tests.sh worker comment)
        'test-snapshot-milestones.js',
        'test-regression-paste-coedit.js',
        'test-regression-mouse-select-copypaste.js',
    ];
    for (const t of SCALED_TESTS) {
        const p = path.join(__dirname, t);
        const src = fs.readFileSync(p, 'utf8');
        check(`${t} uses env.scaleTimeout`,
              /env\.scaleTimeout\(/.test(src),
              src.match(/env\.scaleTimeout/g)?.length + ' calls');
    }

    // 6. Parallel runners must export JOBS_SCALE
    for (const sh of ['run-focused-tests.sh', 'run-all-tests-parallel.sh']) {
        const src = fs.readFileSync(path.join(__dirname, sh), 'utf8');
        check(`${sh} exports JOBS_SCALE`,
              /export JOBS_SCALE=/.test(src), 'present');
    }

    log(allPassed ? '=== PASS ===' : '=== FAIL ===');
    process.exit(allPassed ? 0 : 1);
})().catch(e => { console.error('crash:', e); process.exit(2); });
