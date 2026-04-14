// Importing this file installs a global Checklist for the running test.
// Tests use their own check() helper (most existing tests already do).
// We wrap the global console-output of check via a small hook: tests can
// either (a) use the exported `recordCheck(name, ok, ev)` directly, or
// (b) keep their own check() and call recordCheck inside it. To make
// existing tests work with zero edits, we expose `attachToCheckFn(fn)`
// that wraps an existing function.
const path = require('path');
const { Checklist } = require('./checklist');

// Derive test name + shots dir from the calling script's basename
const scriptPath = process.argv[1] || '';
const scriptName = path.basename(scriptPath).replace(/\.js$/, '');
// Map test-XXX.js → shots-XXX (matching run-all-tests.sh layout)
const slug = scriptName.replace(/^test-/, '');
// Aliases — match what run-all-tests.sh passes for each test slug
const SLUG_TO_SHOTS = {
    'relay':         null,
    'cursor-debug':  'shots',
    '3browsers':     'shots3',
    'formats':       'shots-formats',
    'pptx':          'shots-pptx',
    'pptx-coedit':   'shots-pptx-coedit',
    'late-join':     'shots-latejoin',
    'stress':        'shots-stress',
    'caching':       'shots-caching',
    'chart':         'shots-chart',
    'fonts':         'shots-fonts',
    'e2e-upload':    'shots-e2e-upload',
    'extreme':       'shots-extreme',
    'prewarm':       'shots-prewarm',
};
const shotsName = SLUG_TO_SHOTS[slug] !== undefined ? SLUG_TO_SHOTS[slug] : ('shots-' + slug);
const shotsDir = shotsName ? '/tmp/static-deploy/public/' + shotsName : '/tmp/static-deploy/public/shots-' + slug;

const checklist = new Checklist(scriptName, shotsDir);

function recordCheck(name, ok, evidence) { checklist.check(name, ok, evidence); return ok; }

// Wrap an existing `function check(label, cond)` so it also records
function attachToCheckFn(originalFn) {
    return function(label, cond, ev) {
        recordCheck(label, cond, ev);
        return originalFn(label, cond);
    };
}

// Save on exit (success or failure)
process.on('exit', () => { checklist.save(); });
process.on('SIGINT',  () => { checklist.save(); process.exit(130); });
process.on('SIGTERM', () => { checklist.save(); process.exit(143); });

module.exports = { checklist, recordCheck, attachToCheckFn };
