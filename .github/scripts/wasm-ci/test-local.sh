#!/usr/bin/env bash
# Run the test suite against the dev-box's locally-deployed environment
# (viewer.szebeni.hu / wasm.atgpartners.info / relay.atgpartners.info)
# and publish the report under coolwasmfiles/local-builds/<APP_BUILD_ID>/.
#
# Inputs (env):
#   APP_BUILD_ID  — already prefixed with "local-" by the workflow
#   LO_BUILD_ID   — pinned LO build
#   GIT_SHA       — Online commit being tested
#   GIT_REF       — branch / ref hint
#   TEST_PROFILE  — basic | non-basic | all
#
# Exit code: 0 unless tests couldn't be run; non-zero if any test failed
# (CI shows red but the report is still uploaded).
set -euo pipefail

source "$(dirname "$0")/_lib.sh"
ensure_storage_key

APP_BID="${APP_BUILD_ID:?}"
LO_BID="${LO_BUILD_ID:?}"
ACCT="${AZURE_STORAGE_ACCOUNT:?}"
SITE="${STATIC_SITE_BASE:?}"
WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
PROFILE="${TEST_PROFILE:-basic}"

# ── URLs: hit the dev box's CI stack ────────────────────────────────
# All hostnames / ports live in $ENV_FILE (default wasm/.env.ci, set by
# the runner agent's .env). Source the values here and pass them through
# to the test runners; no string literals in the script.
: "${ENV_FILE:=/home/localadmin/online/wasm/.env.ci}"
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
# JOBS_SCALE=1 — no contention on the local host; tests run as fast
# as the deployed code allows. (Set higher manually if running parallel
# CI jobs hit the same box.)
export JOBS_SCALE=1

REPORT_DIR="$(mktemp -d)"
TEST_OUTPUT="$REPORT_DIR/output"
mkdir -p "$TEST_OUTPUT"
export TEST_OUTPUT_ROOT="$TEST_OUTPUT"
LOG="$REPORT_DIR/run.log"
SUMMARY_JSON="$REPORT_DIR/summary.json"
START_TS="$(date -u +%s)"
RUN_START_MARKER="$(mktemp)"

trap 'rm -rf "$REPORT_DIR" "$RUN_START_MARKER"' EXIT

# ── Install puppeteer/node_modules from the persistent cache ────────
NODE_MODULES_HOST="$CI_STATE_DIR/online-node-modules"
NPM_CACHE_HOST="$CI_STATE_DIR/npm-cache"
PUPPETEER_CACHE_HOST="$CI_STATE_DIR/puppeteer-cache"
mkdir -p "$NODE_MODULES_HOST" "$NPM_CACHE_HOST" "$PUPPETEER_CACHE_HOST"
export PUPPETEER_CACHE_DIR="$PUPPETEER_CACHE_HOST"

rm -rf "$WORKSPACE/wasm/node_modules"
ln -s "$NODE_MODULES_HOST" "$WORKSPACE/wasm/node_modules"
LOCK="$WORKSPACE/wasm/package-lock.json"
INSTALLED_FROM="$NODE_MODULES_HOST/.installed-from-lock"
if [[ ! -f "$INSTALLED_FROM" ]] || ! cmp -s "$LOCK" "$INSTALLED_FROM" || [[ ! -d "$NODE_MODULES_HOST/puppeteer" ]]; then
    echo "--- Installing wasm/node_modules ---"
    find "$NODE_MODULES_HOST" -mindepth 1 -delete 2>/dev/null || true
    (cd "$WORKSPACE/wasm" && npm ci --cache "$NPM_CACHE_HOST" --prefer-offline --no-audit --no-fund 2>&1 | tail -8)
    cp "$LOCK" "$INSTALLED_FROM"
fi

# ── Apply test profile filter to the canonical TESTS array ──────────
# Each profile picks a regex over test slugs and either keeps matches
# or keeps non-matches. `basic` and `non-basic` together partition the
# full suite; `snapshot` is a one-test cut for fast warm-path iteration.
NON_BASIC_RE='2browser|3browser|coedit|latejoin|paste|copypaste|propagation|hard-refresh|formats|^chart$|cross-format|same-type|cross-type|prewarm-benchmark|e2e-upload|e2e-copypaste|checkpoint|room-switch|first-client-overwrite|samedoc-flicker|delete-key|select-delete|user-save|docname-switch|calc-impress|iframe-pool|xlsx-hotswitch|wasm-cache-crosstype|snapshot-(milestones|cross-type)|stress|prewarm$|sab-context'
SNAPSHOT_RE='^snapshot-milestones$'

case "$PROFILE" in
    basic)
        # KEEP only slugs NOT matching the non-basic pattern.
        FILTER_RE="$NON_BASIC_RE"; FILTER_INVERT=true ;;
    non-basic)
        # KEEP only slugs matching the non-basic pattern.
        FILTER_RE="$NON_BASIC_RE"; FILTER_INVERT=false ;;
    snapshot)
        # KEEP only snapshot-milestones — fastest signal for warm-restore work.
        FILTER_RE="$SNAPSHOT_RE";  FILTER_INVERT=false ;;
    all)
        FILTER_INVERT=skip ;;
    *)
        echo "ERROR: TEST_PROFILE must be basic | non-basic | snapshot | all (got: $PROFILE)" >&2
        exit 1 ;;
esac

if [[ "$FILTER_INVERT" != "skip" ]]; then
    # Patch run-all-tests.sh's TESTS array in-place. The actions/checkout
    # workspace is throwaway; we restore by checkout if needed.
    awk -v re="$FILTER_RE" -v inv="$FILTER_INVERT" '
        BEGIN { in_tests=0 }
        /^TESTS=\(/ { in_tests=1; print; next }
        in_tests && /^\)/ { in_tests=0; print; next }
        in_tests && /^[[:space:]]*"/ {
            slug=$0
            sub(/^[[:space:]]+"/, "", slug)
            sub(/\|.*/, "", slug)
            keep = (slug ~ re)            # matches the per-profile pattern
            if (inv == "true") keep = !keep   # invert when the profile keeps non-matches
            if (keep) print
            next
        }
        { print }
    ' "$WORKSPACE/wasm/run-all-tests.sh" > "$WORKSPACE/wasm/run-all-tests.sh.filtered"
    mv "$WORKSPACE/wasm/run-all-tests.sh.filtered" "$WORKSPACE/wasm/run-all-tests.sh"
    echo "--- Filtered TESTS (profile=$PROFILE) ---"
    NTESTS=$(awk '/^TESTS=\(/{f=1;next} /^\)/{f=0} f && /^[[:space:]]*"/' "$WORKSPACE/wasm/run-all-tests.sh" | wc -l)
    echo "  $NTESTS tests selected"
    if [[ "$NTESTS" -eq 0 ]]; then
        echo "ERROR: filter eliminated all tests; pattern bug?" >&2
        exit 1
    fi
fi

# ── Run the suite ───────────────────────────────────────────────────
# Per-run results dir lives under TEST_OUTPUT_ROOT (set above to a fresh
# mktemp). run-all-tests-parallel.sh wipes its own .logs dir at start
# (run-all-tests-parallel.sh:82), so no manual clearing is needed here.
RESULTS_DIR="$TEST_OUTPUT_ROOT/reports/.logs"

{
    echo "=== local CI test run ==="
    echo "  APP_BUILD_ID=$APP_BID  LO_BUILD_ID=$LO_BID  GIT_SHA=${GIT_SHA:-?}"
    echo "  PROFILE=$PROFILE"
    echo "  FILE_STORAGE_URL=$FILE_STORAGE_URL"
    echo "  EDITOR_URL=$EDITOR_URL"
    echo "  RELAY_URL=$RELAY_URL"
    echo "==========================================="
} > "$LOG"

JUNIT_BASE_URL="$SITE/local-builds/$APP_BID/tests/output/reports"
TEST_JOBS="${TEST_JOBS_OVERRIDE:-2}"
set +e
( cd "$WORKSPACE/wasm" && JOBS="$TEST_JOBS" JUNIT_BASE_URL="$JUNIT_BASE_URL" bash run-all-tests-parallel.sh ) >> "$LOG" 2>&1
TEST_RC=$?
set -e
END_TS="$(date -u +%s)"
DUR=$((END_TS - START_TS))

# ── Tally pass/fail from the per-test .result files (matches generate-junit.sh) ──
PASS_COUNT=0; FAIL_COUNT=0
if [[ -d "$RESULTS_DIR" ]]; then
    for r in "$RESULTS_DIR"/*.result; do
        [[ -f "$r" ]] || continue
        IFS='|' read -r _slug status _e _t _d _s < "$r"
        case "$status" in
            pass) PASS_COUNT=$((PASS_COUNT+1)) ;;
            fail) FAIL_COUNT=$((FAIL_COUNT+1)) ;;
        esac
    done
fi
if (( TEST_RC == 0 && FAIL_COUNT > 0 )); then TEST_RC=1; fi

cat > "$SUMMARY_JSON" <<JSON
{
  "app_build_id": "$APP_BID",
  "lo_build_id":  "$LO_BID",
  "git_sha":      "${GIT_SHA:-}",
  "git_ref":      "${GIT_REF:-}",
  "test_profile": "$PROFILE",
  "exit_code":    $TEST_RC,
  "duration_seconds": $DUR,
  "pass_count":   $PASS_COUNT,
  "fail_count":   $FAIL_COUNT,
  "completed_utc": "$(date -u -d "@$END_TS" +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

# ── Wrapper HTML ─────────────────────────────────────────────────────
STATUS_COLOUR="#2e7d32"; STATUS_TEXT="PASSED"
if [[ "$TEST_RC" != 0 ]]; then STATUS_COLOUR="#c62828"; STATUS_TEXT="FAILED"; fi
LOG_ESC="$(python3 -c 'import html,sys; print(html.escape(open(sys.argv[1]).read()))' "$LOG")"
HAS_RICH="$( [[ -f "$TEST_OUTPUT/reports/index.html" || -f $PUB/reports/index.html ]] && echo 1 || echo 0 )"

cat > "$REPORT_DIR/index.html" <<HTML
<!doctype html>
<meta charset="utf-8"><title>local tests for $APP_BID</title>
<style>body{font:14px system-ui;margin:2rem;max-width:80rem}h1{margin-bottom:.2rem}
.muted{color:#666}.badge{display:inline-block;padding:.2rem .6rem;border-radius:4px;color:white;background:$STATUS_COLOUR;font-weight:600}
pre{background:#0b1021;color:#d6e1ff;padding:1rem;border-radius:6px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.4}
a{color:#0066cc}.box{border:1px solid #ddd;border-radius:6px;padding:1rem;margin:1rem 0}</style>
<h1>Local tests for build <code>$APP_BID</code></h1>
<p>Status: <span class="badge">$STATUS_TEXT</span> · profile <code>$PROFILE</code> · ${PASS_COUNT}p / ${FAIL_COUNT}f · ${DUR}s</p>
<p><a href="../">← all local builds</a> · <a href="summary.json">summary.json</a> · <a href="run.log">run.log</a> · <a href="junit.xml">junit.xml</a></p>
<div class="box">
  <h3>Per-test reports</h3>
  <p><a href="output/reports/"><strong>open the test grid</strong></a></p>
</div>
<details><summary>Wrapper run.log</summary><pre>$LOG_ESC</pre></details>
HTML

# ── Mirror host artefacts (reports / shots / logs) ──────────────────
SHOTS_HOST="$PUB"
mirror_fresh_files() {
    local src="$1" dst="$2"; shift 2
    [[ -d "$src" ]] || return 0
    local fa=()
    if (( $# > 0 )); then
        fa+=( '(' )
        local first=1
        for pat in "$@"; do
            (( first )) || fa+=( -o ); fa+=( -name "$pat" ); first=0
        done
        fa+=( ')' )
    fi
    local n=0
    while IFS= read -r f; do
        local rel="${f#$src/}"
        mkdir -p "$dst/$(dirname "$rel")"
        cp -p "$f" "$dst/$rel"
        n=$((n+1))
    done < <(find "$src" -type f "${fa[@]}" -newer "$RUN_START_MARKER" 2>/dev/null)
    echo "  mirror $src → $dst : $n file(s)"
}

echo "--- Mirroring host artefacts ---"
mirror_fresh_files "$SHOTS_HOST/reports" "$TEST_OUTPUT/reports" '*.html' '*.json' '*.log' '*.result' '*.xml'
for shotdir in "$SHOTS_HOST"/shots*; do
    [[ -d "$shotdir" ]] || continue
    mirror_fresh_files "$shotdir" "$TEST_OUTPUT/$(basename "$shotdir")" '*.png' 'checklist.json'
done

# ── Upload to coolwasmfiles ─────────────────────────────────────────
upload() {
    local src="$1" name="$2" ctype=""
    case "$src" in
        *.png) ctype="image/png" ;;
        *.html) ctype="text/html; charset=utf-8" ;;
        *.json) ctype="application/json" ;;
        *.xml)  ctype="application/xml" ;;
        *.log|*.txt) ctype="text/plain; charset=utf-8" ;;
    esac
    local args=(--account-name "$ACCT" --container-name '$web'
                --name "$name" --file "$src" --overwrite --no-progress)
    [[ -n "$ctype" ]] && args+=(--content-type "$ctype")
    az storage blob upload "${args[@]}" >/dev/null
}
upload "$LOG"                  "local-builds/$APP_BID/tests/run.log"
upload "$SUMMARY_JSON"         "local-builds/$APP_BID/tests/summary.json"
upload "$REPORT_DIR/index.html" "local-builds/$APP_BID/tests/index.html"
[[ -f $PUB/reports/junit.xml ]] && \
    upload $PUB/reports/junit.xml "local-builds/$APP_BID/tests/junit.xml"

# ── Per-build manifest (drives the index page) ──────────────────────
MANIFEST="$REPORT_DIR/manifest.json"
cat > "$MANIFEST" <<JSON
{
  "app_build_id": "$APP_BID",
  "lo_build_id":  "$LO_BID",
  "git_sha":      "${GIT_SHA:-}",
  "git_ref":      "${GIT_REF:-}",
  "git_short_sha": "$(echo "${GIT_SHA:-}" | cut -c1-12)",
  "test_profile": "$PROFILE",
  "completed_utc": "$(date -u -d "@$END_TS" +%Y-%m-%dT%H:%M:%SZ)",
  "test_report": {
    "url": "local-builds/$APP_BID/tests/",
    "exit_code": $TEST_RC,
    "duration_seconds": $DUR,
    "pass_count": $PASS_COUNT,
    "fail_count": $FAIL_COUNT
  }
}
JSON
upload "$MANIFEST" "local-builds/$APP_BID/manifest.json"

# Single batch upload for the test_output tree.
if [[ "$HAS_RICH" == 1 ]]; then
    az storage blob upload-batch \
        --account-name "$ACCT" --destination '$web' \
        --destination-path "local-builds/$APP_BID/tests/output" \
        --source "$TEST_OUTPUT" --pattern '*' --overwrite --no-progress 2>&1 | tail -3 || true
fi

# Refresh the local-builds index.
bash "$(dirname "$0")/regen-indexes.sh"

echo ""
echo "Published: $SITE/local-builds/$APP_BID/tests/"
echo "Index:     $SITE/local-builds/"
echo "  pass=$PASS_COUNT  fail=$FAIL_COUNT  duration=${DUR}s  profile=$PROFILE"
exit "$TEST_RC"
