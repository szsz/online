#!/bin/bash
# Focused runner for the co-editing convergence + churn suite
# (wasm/tests/coedit/*). Each test opens multiple browsers on the SAME
# document and asserts that every live participant converges to the same
# state as edits happen and participants come and go.
#
# Usage: bash wasm/run-coedit-tests.sh
# Env comes from ~/ENV/online.env (override with ENV_FILE=...). Reads
# FILE_STORAGE_URL / EDITOR_URL / RELAY_URL; sets VIEWER_URL alias for
# lib/test-env.js.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$HOME/ENV/online.env}"
set -a; . "$ENV_FILE" 2>/dev/null; set +a
export VIEWER_URL="${VIEWER_URL:-$FILE_STORAGE_URL}"

TESTS=(
  "tests/coedit/test-coedit-convergence-churn.js|convergence + churn (join/leave/late-join)"
  "tests/coedit/test-coedit-concurrent.js|concurrent (simultaneous) edits + mid-stream churn"
  "tests/coedit/test-coedit-feature-shape.js|insert-shape propagation + late-join"
  "tests/coedit/test-coedit-feature-table.js|insert-table propagation + late-join"
  "tests/coedit/test-coedit-formatting.js|formatting (bold/italic/font-size) propagation"
  "tests/coedit/test-coedit-rejoin-storm.js|rejoin storm (repeated leave/rejoin)"
  "tests/coedit/test-coedit-spell-correct.js|language + spellcheck + spell-correct convergence"
  "tests/coedit/test-coedit-latejoin-checkpoint-retry.js|late-join w/ unsaved edits — no checkpoint-download hang"
  "tests/coedit/test-coedit-spell-correct-latejoin.js|spell-correct then late-join — correction must reach the joiner"
  "tests/coedit/test-coedit-convergence-conflict.js|convergence under conflict (same-position / select-all-delete / 3-browser)"
  "tests/coedit/test-coedit-churn-load-budget.js|churn storm + per-join load-time budget"
)

echo "Co-editing suite — VIEWER=$VIEWER_URL EDITOR=$EDITOR_URL RELAY=$RELAY_URL"
pass=0; fail=0; failed=()
for entry in "${TESTS[@]}"; do
  script="${entry%%|*}"; title="${entry##*|}"
  echo "======================================================================"
  echo "  $title  ($script)"
  echo "======================================================================"
  if timeout 900 node "$SCRIPT_DIR/$script"; then
    echo "  => PASS"; pass=$((pass+1))
  else
    echo "  => FAIL (exit $?)"; fail=$((fail+1)); failed+=("$script")
  fi
done

echo "======================================================================"
echo "Co-editing suite: ${pass} passed, ${fail} failed"
for f in "${failed[@]:-}"; do [ -n "$f" ] && echo "  FAILED: $f"; done
[ "$fail" -eq 0 ]
