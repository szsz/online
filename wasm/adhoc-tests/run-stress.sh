#!/usr/bin/env bash
# Ad-hoc runner for the stress test (cluster A late-join investigation).
#
# This test was removed from the main suite on 2026-05-04 because it
# flakes 3-4 / 6 runs and isn't gated on for landing changes — it
# exposes a real architectural issue (late-join replay divergence,
# maxDiff > 15 chars between A/C/D after reconnect-and-edit cycles)
# but the failure isn't actionable without a focused investigation
# session. Run it ad-hoc when working on cluster A:
#
#   bash wasm/adhoc-tests/run-stress.sh
#
# Output goes to /tmp/static-deploy/public/shots-stress/. The test
# exits 1 on any check failure (most often "C and D close, diff < 10"
# or "Final convergence, maxDiff < 15").
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
exec node adhoc-tests/test-stress.js
