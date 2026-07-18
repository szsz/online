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
// 2026-06-06: bumped 12 -> 14 — added regression-latejoin-offline-
// unsaved + regression-first-client-overwrite (both pre-existing
// latejoin-family flakes that were never categorized).
// 2026-06-07: bumped 14 -> 16 — added pptx-coedit + regression-
// cross-format-matrix (both flapped between runs under JOBS_SCALE=2:
// passed in build 051447, failed in 002906 and 095121).
// 2026-07-11: bumped 16 -> 17 — full-suite content-viewer migration: each
// migrated legacy flake now has a cv- twin (legacy version retired).
const KNOWN_FLAKE_BUDGET = 17;
// 2026-06-06: down from 7→4→2 — LO PR #36 (MAXIMUM_MEMORY=2GB)
// unblocked Impress Area dialog + 2 spellcheck tests on LO 2026-06-
// 05-69. 2026-06-07: bump back to 4 — the 2 Writer Area tests
// (insert-shape-area + shape-area-oom) re-blocked on a different
// LO bug. console-capture diagnosis showed Uncaught RuntimeError:
// function signature mismatch on .uno:FormatArea dispatch (Writer-
// specific, Impress sibling unaffected). See ai/proposals/proposed/
// writer-area-dialog-function-signature-mismatch.md.
// 2026-06-14: bump 4→5 — add regression-writer-header-footer-remove
// (removed header still exported; root-caused model-side in the LOK
// Page Style apply path, awaiting an LO fix). Drop back when that LO
// fix lands. See fix-header-footer-docx-export-keeps-part.md.
// 2026-06-15: bump 5→6 — add regression-impress-transition-click (fails
// deterministically: transition click emits no dialogevents; LO-core,
// awaiting an LO fix). Drop back when fixed.
// 2026-07-11: bumped 6 -> 8 — CV migration: area-dialog OOB/OOM cluster +
// transition + fr-dict (build-dicts) cv- twins; see ACCEPTED-FAILS.txt.
// 2026-07-18: 8 -> 3 — demoted all 5 non-Impress accepted-fails:
// writer-shape-area-oom, -writer-insert-shape-area, -writer-header-footer-remove
// (TOTAL_MEMORY=2GB growth-race fix, PR #273), -area-palette (2GB un-crash +
// test selector/click/field), -spell-rightclick-suggest (full-dict editor).
// Remaining LO-blocked: ctrl-x-cut-restore, impress-transition-click,
// impress-area-dialog (Impress, out of scope this round).
const LO_BLOCKED_BUDGET = 3;

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
