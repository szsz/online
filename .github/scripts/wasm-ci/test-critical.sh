#!/usr/bin/env bash
# Critical-subset gate — runs a small, curated list of E2E tests against
# the locally-deployed CI stack and FAILS (exit 1) if ANY of them fail.
#
# Purpose: gate the PR auto-merge on the stack actually working. The full
# suite is informational (runs after auto-merge), which let a totally
# broken stack — e.g. the editor 404ing because an orphan editor-static
# process squatted the ci HTTPS port — merge for days with zero signal
# (every E2E test 404'd on cool.html; build+deploy still "succeeded").
#
# The list is chosen so that "editor unreachable / stack down" makes the
# gate go red, plus the core promises: cold open, warm restore, co-edit.
# Keep it SHORT (gate latency is on the merge critical path) and STABLE
# (a flaky test here blocks every PR — flaky tests belong in the
# informational full suite, not this gate).
#
# Inputs (env): ENV_FILE (default ~/ENV/online-ci.env), APP_BUILD_ID.
# Exit: 0 only if every critical test passes; 1 if any fails or can't run.
set -uo pipefail

source "$(dirname "$0")/_lib.sh" 2>/dev/null || true

WORKSPACE="${GITHUB_WORKSPACE:-$(cd "$(dirname "$0")/../../.." && pwd)}"

# ── Env: mirror test-local.sh so the test harness (wasm/lib/test-env.js)
#    resolves the CI stack URLs. No hostname literals here — all from
#    $ENV_FILE. ─────────────────────────────────────────────────────
: "${ENV_FILE:=$HOME/ENV/online-ci.env}"
if [[ ! -r "$ENV_FILE" ]]; then
    echo "ERROR: ENV_FILE not readable: $ENV_FILE" >&2
    exit 1
fi
echo "ENV_FILE=$ENV_FILE"
while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    if [[ -z "${!key+x}" ]]; then
        export "$key=$value"
    fi
done < "$ENV_FILE"

: "${FILE_STORAGE_URL:?FILE_STORAGE_URL must be set in $ENV_FILE}"
: "${EDITOR_URL:?EDITOR_URL must be set in $ENV_FILE}"
: "${RELAY_URL:?RELAY_URL must be set in $ENV_FILE}"
export VIEWER_URL="$FILE_STORAGE_URL"
export TEST_TARGET="local-host"
export EDITOR_DEPLOY_ID="${APP_BUILD_ID:-}"
export JOBS_SCALE=1

# node_modules + puppeteer must be present before any E2E test (the gate
# runs before test-local.sh, which used to be the only installer — that's
# why the deploy smoke hit "Cannot find module 'puppeteer'").
ensure_node_modules "$WORKSPACE"

# ── Critical test list (slug | path-relative-to-wasm/) ──────────────
# - deploy-smoke: editor loads + renders a doc → catches editor 404 /
#   stack-down directly (the failure that broke the lane).
# - snapshot-milestones: cold + warm×3 → catches warm-restore regressions.
# - latejoin-unsaved: co-edit late join convergence → catches the
#   co-edit/SECOND_INIT class.
CRITICAL=(
    "deploy-smoke|tests/misc/test-deploy-smoke.js"
    "snapshot-milestones|tests/snapshot/test-snapshot-milestones.js"
    "latejoin-unsaved|tests/regression/test-regression-latejoin-unsaved.js"
)

# snapshot-milestones is the slowest; give the gate a generous per-test
# wrapper but keep the whole gate well under the full suite's runtime.
PER_TEST_TIMEOUT="${CRITICAL_TEST_TIMEOUT:-900}"

# Up to 2 attempts per critical test. The 2-browser co-edit test
# (latejoin-unsaved) is a known transient iframe-race flake (it is in
# KNOWN_FLAKE_TESTS for the full suite, and the race is tracked in
# ai/proposals/promoted/paste-coedit-jobs2-second-iframe-race.md). Without a
# retry, one transient hiccup fails this BLOCKING gate and aborts the entire
# run — so the full suite never publishes and every downstream test reads as
# "failed". A single retry absorbs the transient race; a genuine regression
# (editor down, warm broken, co-edit broken) still fails both attempts and
# blocks the merge. This does NOT mask real breakage — it only de-flakes the
# gate. Root-causing the underlying race is tracked separately.
MAX_ATTEMPTS="${CRITICAL_TEST_ATTEMPTS:-2}"
echo "=== Critical-subset gate (${#CRITICAL[@]} tests, ${PER_TEST_TIMEOUT}s each, up to ${MAX_ATTEMPTS} attempts) ==="
FAILED=()
for entry in "${CRITICAL[@]}"; do
    slug="${entry%%|*}"
    script="${entry#*|}"
    echo "--- [$slug] $script ---"
    passed=false
    for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
        logf="$(mktemp)"
        if ( cd "$WORKSPACE/wasm" && TMPDIR="$(mktemp -d)" timeout "$PER_TEST_TIMEOUT" node "$script" ) > "$logf" 2>&1; then
            echo "  [$slug] PASS (attempt $attempt/$MAX_ATTEMPTS)"
            passed=true
            rm -f "$logf"
            break
        fi
        rc=$?
        echo "  [$slug] FAIL (attempt $attempt/$MAX_ATTEMPTS, exit $rc)"
        echo "  ---- last 25 lines ----"
        tail -25 "$logf" | sed 's/^/    /'
        rm -f "$logf"
        [[ "$attempt" -lt "$MAX_ATTEMPTS" ]] && echo "  [$slug] retrying…"
    done
    $passed || FAILED+=("$slug")
done

echo "=== Critical-subset gate result ==="
if [[ ${#FAILED[@]} -gt 0 ]]; then
    echo "FAIL — ${#FAILED[@]} critical test(s) failed: ${FAILED[*]}"
    echo "Merge is BLOCKED. Fix these before the PR can land."
    exit 1
fi
echo "PASS — all ${#CRITICAL[@]} critical tests passed."
exit 0
