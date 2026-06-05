// Flake budget tripwire — guards .github/scripts/wasm-ci/test-and-
// publish.sh against silent growth of KNOWN_FLAKE_TESTS / LO_BLOCKED_
// TESTS. Adding a new entry to either set has to be a CONSCIOUS
// decision: bump the budget below in the same commit. Otherwise this
// test fails, forcing the author to either (a) fix the underlying
// flake/block before silencing it, or (b) bump the budget + leave a
// pointer to the proposal/task.
//
// The two sets are defined in test-and-publish.sh near the top of
// the file (see "Flake taxonomy" section). This test reads them
// back, counts entries, and asserts the totals match.

'use strict';

const fs = require('fs');
const path = require('path');
const __cl = require('../../lib/inject-checklist');

// Budgets. Bump in the SAME commit that adds a new flake/block entry.
// Decreases are also fine and don't trip the wire (we celebrate them).
const KNOWN_FLAKE_BUDGET = 12;
const LO_BLOCKED_BUDGET = 7;

const TEST_PUBLISH_SH = path.resolve(__dirname, '..', '..', '..',
    '.github', 'scripts', 'wasm-ci', 'test-and-publish.sh');

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) console.log(`  PASS: ${label}`);
    else { console.log(`  FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

function countArrayEntries(src, name) {
    // Match `NAME=(` then count non-comment, non-blank lines until `)`.
    const re = new RegExp('^' + name + '=\\(\\s*$', 'm');
    const m = src.match(re);
    if (!m) return -1;
    const start = m.index + m[0].length;
    const after = src.slice(start);
    const closeIdx = after.indexOf('\n)');
    if (closeIdx < 0) return -1;
    const body = after.slice(0, closeIdx);
    return body.split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'))
        .length;
}

console.log('=== Regression: KNOWN_FLAKE_TESTS / LO_BLOCKED_TESTS budget ===');

if (!fs.existsSync(TEST_PUBLISH_SH)) {
    check('test-and-publish.sh exists at expected path', false, TEST_PUBLISH_SH);
    process.exit(1);
}
const src = fs.readFileSync(TEST_PUBLISH_SH, 'utf8');

const flakeN = countArrayEntries(src, 'KNOWN_FLAKE_TESTS');
const blockedN = countArrayEntries(src, 'LO_BLOCKED_TESTS');

check('KNOWN_FLAKE_TESTS array found in test-and-publish.sh',
      flakeN >= 0, 'entries=' + flakeN);
check('LO_BLOCKED_TESTS array found in test-and-publish.sh',
      blockedN >= 0, 'entries=' + blockedN);

check(`KNOWN_FLAKE_TESTS has ≤ ${KNOWN_FLAKE_BUDGET} entries (bump budget if growing)`,
      flakeN <= KNOWN_FLAKE_BUDGET,
      `got=${flakeN} budget=${KNOWN_FLAKE_BUDGET}`);
check(`LO_BLOCKED_TESTS has ≤ ${LO_BLOCKED_BUDGET} entries (bump budget if growing)`,
      blockedN <= LO_BLOCKED_BUDGET,
      `got=${blockedN} budget=${LO_BLOCKED_BUDGET}`);

process.exit(allPassed ? 0 : 1);
