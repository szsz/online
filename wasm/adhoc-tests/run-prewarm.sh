#!/usr/bin/env bash
# Ad-hoc runner for test-prewarm.js (viewer prewarm UX timing).
# Removed from the main suite on 2026-05-04 — the warm/cold perf-ratio
# assertion is contention-bounded and flaky under JOBS=2.
# snapshot-milestones covers warm-restore perf comprehensively in CI.
set -e
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec node adhoc-tests/test-prewarm.js
