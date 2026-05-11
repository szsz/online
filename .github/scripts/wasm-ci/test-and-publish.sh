#!/usr/bin/env bash
# Two-phase test runner.
#
# Phase 1 — main run, against LOCAL servers spawned on free ports on the
# CI host. The just-built bundle is staged into a CI-private public/
# tree, an editor-static + viewer + relay are launched against it, and
# wasm/run-all-tests-parallel.sh runs the full TESTS array against
# http://127.0.0.1:<port>/. This is what the user runs in dev and is
# what catches code regressions cleanly — no Azure throttling, no WAN
# round-trips, no contention with the deployed App Services.
#
# Phase 2 — Azure smoke, JOBS=1, a tiny subset (prewarm / pptx-viewer /
# singleuser) hitting the just-deployed Azure App Service URLs. Catches
# pure deployment regressions (CSP, headers, brotli, hot-switch into a
# stale App Service slot) without re-running 75 tests in a slow remote
# environment. Each smoke test gets DOWNLOAD_BUDGET_MS=30000 added on
# top of its patience timeouts, so the time the WASM bundle takes to
# come down off Azure App Service is paid out of band rather than
# eating into the test's "did the thing happen?" window.
#
# Failure semantics: the job reports the COMBINED test_report. exit_code
# is non-zero if either phase produced any failing test. pass_count and
# fail_count are summed across both phases.
#
# Override with env:
#   TEST_TARGET=azure-deploy   # legacy single-Azure-phase mode (skips local)
#   TEST_JOBS_OVERRIDE=N       # parallelism for the local main run (default 2)
#   SKIP_AZURE_SMOKE=1         # skip phase 2 entirely
#   AZURE_SMOKE_DOWNLOAD_MS=N  # override the 30 s download budget
set -euo pipefail

# shellcheck source=_lib.sh
source "$(dirname "$0")/_lib.sh"
ensure_storage_key

APP_BID="${APP_BUILD_ID:?}"
ACCT="${AZURE_STORAGE_ACCOUNT:?}"
SITE="${STATIC_SITE_BASE:?}"
WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"

# Phase 2 (Azure smoke) reads the deployed App Service URLs from the
# prod-deploy env file (~/ENV/online-staging-deploy.env, populated once
# on the runner host — see .github/scripts/wasm-ci/deploy.sh).
ENV_DEPLOY_HOST="${STAGING_DEPLOY_ENV:-$HOME/ENV/online-staging-deploy.env}"
TEST_TARGET="${TEST_TARGET:-local}"

REPORT_DIR="$(mktemp -d)"
TEST_OUTPUT="$REPORT_DIR/output"
mkdir -p "$TEST_OUTPUT"
LOG="$REPORT_DIR/run.log"
SUMMARY_JSON="$REPORT_DIR/summary.json"
START_TS="$(date -u +%s)"
RUN_START_MARKER="$(mktemp)"
export TEST_OUTPUT_ROOT="$TEST_OUTPUT"

# Track spawned PIDs for cleanup. Cleared on exit.
LOCAL_SERVER_PIDS=()
trap '
    for pid in "${LOCAL_SERVER_PIDS[@]:-}"; do
        kill "$pid" 2>/dev/null || true
    done
    rm -rf "$REPORT_DIR" "$RUN_START_MARKER" "${STAGE_DIR:-}"
' EXIT

# ── Install wasm/node_modules + puppeteer's Chromium (persistent cache) ──
NODE_MODULES_HOST="${CI_STATE_DIR}/online-node-modules"
NPM_CACHE_HOST="${CI_STATE_DIR}/npm-cache"
PUPPETEER_CACHE_HOST="${CI_STATE_DIR}/puppeteer-cache"
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
    echo "[OK] node_modules installed."
else
    echo "[OK] node_modules cache hit."
fi

# Skip tests that aren't useful for every CI run (canonical TESTS array).
CI_SKIP_TESTS=( stress )
for slug in "${CI_SKIP_TESTS[@]}"; do
    if grep -q "^[[:space:]]*\"$slug|" "$WORKSPACE/wasm/run-all-tests.sh"; then
        echo "[CI] Skipping test: $slug"
        sed -i "/^[[:space:]]*\"$slug|/d" "$WORKSPACE/wasm/run-all-tests.sh"
    fi
done

# ── Helpers ─────────────────────────────────────────────────────────
pick_free_port() {
    python3 -c '
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
'
}

wait_for_port() {
    local port="$1" deadline=$((SECONDS + 30))
    while (( SECONDS < deadline )); do
        if (echo > "/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
            return 0
        fi
        sleep 1
    done
    return 1
}

# ── Phase 1 setup: stage + spawn local servers (default mode) ────────
PHASE1_PASS=0
PHASE1_FAIL=0
PHASE1_RC=0

if [[ "$TEST_TARGET" == "local" ]]; then
    STAGE_DIR="$REPORT_DIR/stage"
    mkdir -p "$STAGE_DIR/public/browser" "$STAGE_DIR/storage" "$STAGE_DIR/wasm-docs"

    # Stage CI's just-built bundle. The artefacts come from two sibling
    # dirs in $CI_STATE_DIR/online-build/:
    #   wasm/        ← Emscripten link output: online.js, online.wasm,
    #                  online.worker.js, emscripten-module.js, soffice.data,
    #                  soffice.data.js.metadata
    #   browser/dist/← COOL JS bundle: cool.html, bundle.js, bundle.css,
    #                  global.js, etc.
    # editor-static-server.js serves them merged at $PUB/browser/ — so we
    # copy both into $STAGE/public/browser/ and add the loader/sw scripts
    # straight from the source tree (deploy.sh does the same).
    BUILD_OUT_WASM="$CI_STATE_DIR/online-build/wasm"
    BUILD_OUT_DIST="$CI_STATE_DIR/online-build/browser/dist"
    if [[ ! -f "$BUILD_OUT_WASM/online.js" || ! -f "$BUILD_OUT_WASM/online.wasm" ]]; then
        echo "ERROR: expected build artefacts at $BUILD_OUT_WASM not found." >&2
        exit 1
    fi
    if [[ ! -f "$BUILD_OUT_DIST/cool.html" ]] || ! ls "$BUILD_OUT_DIST"/bundle*.js >/dev/null 2>&1; then
        echo "ERROR: expected COOL JS bundle at $BUILD_OUT_DIST not found." >&2
        exit 1
    fi
    # Pre-stage the full LO browser/dist tree. wasm/deploy.sh's Step 2
    # only copies the 9 hot-loop artefacts (online.js/wasm, bundle.js,
    # wasm-loader, etc.) — it relies on a pre-existing /browser/ tree
    # for everything else (cool.html, editor.html, global.js, l10n-all.js,
    # color palettes, images/, …). On the host's /tmp/static-deploy/public/
    # that tree was seeded by an earlier full deploy. Phase 1's STAGE_DIR
    # is freshly mktemp'd, so without this copy we end up with /browser/
    # holding only the 10 hot files and 22 missing — every fetch of
    # /browser/cool.html 404s and regression-snapshot-injection plus the
    # whole suite fail in <1s "fetch failed: 404".
    cp -a "$BUILD_OUT_DIST/." "$STAGE_DIR/public/browser/"

    # Run wasm/deploy.sh against the per-run STAGE_DIR. This OVERWRITES
    # the 9 hot-loop artefacts with the snapshot-restore-injected,
    # cache-busted versions, and rewrites cool.html with the
    # __assetMap — so the Phase 1 environment is bit-equivalent to a
    # real deploy. A plain cp-and-stage skips those steps and the
    # gating tests (regression-snapshot-injection, regression-cache-bust,
    # regression-html-304, regression-hot-switch-watchdog,
    # regression-cluster-c, regression-viewer-cache) all fail at <1s.
    # Use --no-restart to leave the host's running editor-static / relay
    # alone (Phase 1 spawns its own pair on free ports below); --no-smoke
    # because the host's deploy-smoke target isn't relevant here;
    # --no-brotli because Phase 1 servers serve identity (no Accept-Encoding
    # negotiation in the local URLs). LOCK_FILE=/dev/null lets the
    # parallel CI builds (Azure + local) stage independently — neither
    # writes to /tmp/static-deploy/public.
    BUILD_DIR="$CI_STATE_DIR/online-build" \
    PUB="$STAGE_DIR/public" \
    LOCK_FILE=/dev/null \
        bash "$WORKSPACE/wasm/deploy.sh" --no-restart --no-smoke --no-brotli 2>&1 \
        | sed 's/^/  [stage-deploy] /' | tail -40

    # The viewer reads its own UI assets relative to wasm/viewer-public/
    # in the source tree, so we don't need to stage those — but we do
    # need a writable LOCAL_STORAGE_DIR for uploads, already created.
    EDITOR_PORT=$(pick_free_port)
    VIEWER_PORT=$(pick_free_port)
    RELAY_PORT=$(pick_free_port)

    EDITOR_URL_LOCAL="http://127.0.0.1:$EDITOR_PORT"
    VIEWER_URL_LOCAL="http://127.0.0.1:$VIEWER_PORT"
    RELAY_URL_LOCAL="ws://127.0.0.1:$RELAY_PORT"

    echo "--- Phase 1: spawning local servers ---"
    echo "  editor-static  → $EDITOR_URL_LOCAL  (PUB=$STAGE_DIR/public)"
    echo "  viewer         → $VIEWER_URL_LOCAL  (storage=$STAGE_DIR/storage)"
    echo "  message-relay  → $RELAY_URL_LOCAL"

    # editor-static-server.js
    # DOCS overrides the default /tmp/static-deploy/.wasm-docs (the
    # user's host-side dir, root-owned). Without this the CI process
    # gets EACCES on every document upload and the tests time out
    # waiting for the doc to load.
    PUB="$STAGE_DIR/public" \
    DOCS="$STAGE_DIR/wasm-docs" \
    HTTP_PORT="$EDITOR_PORT" \
    FILE_STORAGE_URL="$VIEWER_URL_LOCAL" \
        node "$WORKSPACE/wasm/editor-static-server.js" \
        > "$REPORT_DIR/editor.log" 2>&1 &
    LOCAL_SERVER_PIDS+=($!)

    # viewer-server.js — backed by real Azure storage (coolwasmfiles)
    # rather than the local FS. The local storage backend doesn't surface
    # the `displayName` field that the deployed ci-viewer.szebeni.hu and
    # staging viewer-server return, so tests that check the title-bar
    # filename (regression-docname-switch / -samedoc-flicker / viewer-e2e
    # / cross-format-matrix) saw the opaque fileId hex instead and
    # red-failed only in this CI phase. Same-storage as ci-viewer keeps
    # phase-1 bit-equivalent to the deployed stack.
    #
    # ensure_storage_key (sourced above) exports AZURE_STORAGE_KEY by
    # listing the storage account keys via the runner's MI. viewer-server
    # reads DOC_STORAGE_KEY, so we pass the same value through.
    PORT="$VIEWER_PORT" \
    STORAGE_BACKEND=azure \
    DOC_STORAGE_ACCOUNT="$ACCT" \
    DOC_STORAGE_CONTAINER="${DOC_STORAGE_CONTAINER:-userdata}" \
    DOC_STORAGE_KEY="$AZURE_STORAGE_KEY" \
    FILE_STORAGE_URL="$VIEWER_URL_LOCAL" \
    EDITOR_URL="$EDITOR_URL_LOCAL" \
    RELAY_URL="$RELAY_URL_LOCAL" \
        node "$WORKSPACE/wasm/viewer-server.js" \
        > "$REPORT_DIR/viewer.log" 2>&1 &
    LOCAL_SERVER_PIDS+=($!)

    # message-relay.js
    PORT="$RELAY_PORT" \
        node "$WORKSPACE/wasm/message-relay.js" \
        > "$REPORT_DIR/relay.log" 2>&1 &
    LOCAL_SERVER_PIDS+=($!)

    for port in "$EDITOR_PORT" "$VIEWER_PORT" "$RELAY_PORT"; do
        if ! wait_for_port "$port"; then
            echo "ERROR: server on port $port failed to listen within 30 s" >&2
            tail -20 "$REPORT_DIR/editor.log" "$REPORT_DIR/viewer.log" "$REPORT_DIR/relay.log" 2>/dev/null
            exit 1
        fi
    done
    echo "[OK] all local servers listening."

    export FILE_STORAGE_URL="$VIEWER_URL_LOCAL"
    export EDITOR_URL="$EDITOR_URL_LOCAL"
    export RELAY_URL="$RELAY_URL_LOCAL"
    export VIEWER_URL="$VIEWER_URL_LOCAL"
    export TEST_TARGET="local"

elif [[ "$TEST_TARGET" == "azure-deploy" ]]; then
    # Legacy mode: source Azure URLs from the host-managed .env.deploy.
    if [[ ! -f "$ENV_DEPLOY_HOST" ]]; then
        echo "ERROR: $ENV_DEPLOY_HOST not found — needed for TEST_TARGET=azure-deploy URLs" >&2
        exit 1
    fi
    set -a; source "$ENV_DEPLOY_HOST"; set +a
    export FILE_STORAGE_URL="${VIEWER_URL:?VIEWER_URL must be set in ~/ENV/online-staging-deploy.env}"
    export EDITOR_URL="${EDITOR_URL:?EDITOR_URL must be set in ~/ENV/online-staging-deploy.env}"
    export RELAY_URL="${RELAY_URL:?RELAY_URL must be set in ~/ENV/online-staging-deploy.env}"
    # Per-deploy folder id: the just-deployed editor lives at
    # ${EDITOR}/<APP_BUILD_ID>/. Surface it to test-env.js so tests
    # that need the explicit prefix (test-regression-editor-deploy-
    # folder.js) construct the right URL. Tests using legacy flat
    # URLs continue to work via editor-server's DEFAULT_DEPLOY_ID
    # app-settings fallback.
    export EDITOR_DEPLOY_ID="$APP_BID"
    export TEST_TARGET="azure-deploy"
else
    echo "ERROR: unknown TEST_TARGET=$TEST_TARGET (expected local | azure-deploy)" >&2
    exit 1
fi

{
    echo "=== Phase 1 — TEST_TARGET=$TEST_TARGET ==="
    echo "  FILE_STORAGE_URL=$FILE_STORAGE_URL"
    echo "  EDITOR_URL=$EDITOR_URL"
    echo "  RELAY_URL=$RELAY_URL"
    echo "  APP_BUILD_ID=$APP_BID  LO_BUILD_ID=${LO_BUILD_ID:-?}"
    echo "  GIT_SHA=${GIT_SHA:-?}"
    echo "  TEST_OUTPUT_ROOT=$TEST_OUTPUT_ROOT"
    echo "==========================================="
} > "$LOG"

# ── Phase 1: run the full TESTS array via the parallel runner ────────
TEST_JOBS="${TEST_JOBS_OVERRIDE:-2}"
# Pass the eventual public URL of the per-test reports through to the
# JUnit emitter so each <testcase> has a clickable deep-link.
JUNIT_BASE_URL="$SITE/app-builds/$APP_BID/tests/output/reports"
set +e
( cd "$WORKSPACE/wasm" && JOBS="$TEST_JOBS" JUNIT_BASE_URL="$JUNIT_BASE_URL" bash run-all-tests-parallel.sh ) >> "$LOG" 2>&1
PHASE1_RC=$?
set -e

# Tear down the local servers as soon as Phase 1 is done so they don't
# linger during Azure smoke or upload (the trap also kills them, but
# this gives a clean shutdown line in the log).
if [[ ${#LOCAL_SERVER_PIDS[@]} -gt 0 ]]; then
    echo "--- Phase 1 done: stopping local servers ---" >> "$LOG"
    for pid in "${LOCAL_SERVER_PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
    done
    LOCAL_SERVER_PIDS=()
fi

if [[ -f "$TEST_OUTPUT/reports/index.html" ]]; then
    PHASE1_PASS=$(grep -oE 'badge-pass|<tr class="pass"' "$TEST_OUTPUT/reports/index.html" | wc -l)
    PHASE1_FAIL=$(grep -oE 'badge-fail|<tr class="fail"' "$TEST_OUTPUT/reports/index.html" | wc -l)
fi
if (( PHASE1_PASS == 0 && PHASE1_FAIL == 0 )); then
    PHASE1_PASS="$(grep -cE '^pass ' "$LOG" || true)"
    PHASE1_FAIL="$(grep -cE '^fail ' "$LOG" || true)"
fi

# ── Phase 2: Azure smoke (only when phase 1 was local + smoke is enabled) ──
PHASE2_PASS=0
PHASE2_FAIL=0
PHASE2_RC=0
PHASE2_RAN=0

if [[ "$TEST_TARGET" == "local" ]] \
   && [[ "${SKIP_AZURE_SMOKE:-0}" != "1" ]] \
   && [[ -f "$ENV_DEPLOY_HOST" ]]; then

    PHASE2_RAN=1
    {
        echo ""
        echo "=== Phase 2 — Azure smoke (JOBS=1) ==="
    } >> "$LOG"

    # Pull Azure URLs into a sub-shell scope so they don't override the
    # local URLs already captured for any per-test report metadata.
    AZURE_DOWNLOAD_BUDGET="${AZURE_SMOKE_DOWNLOAD_MS:-30000}"
    SMOKE_PASS=0
    SMOKE_FAIL=0
    SMOKE_LOG_DIR="$TEST_OUTPUT/azure-smoke-logs"
    mkdir -p "$SMOKE_LOG_DIR"

    # Subset chosen to cover the three things that can break in
    # deployment but not in code: CSP+COOP/COEP headers (prewarm),
    # static asset routing for the viewer (pptx-viewer), and a
    # full single-user open/edit/save cycle (singleuser).
    SMOKE_TESTS=(
        "azure-prewarm:test-prewarm.js"
        "azure-pptx-viewer:test-pptx-viewer.js"
        "azure-singleuser:test-singleuser.js"
    )

    (
        # Subshell so URL re-export is scoped here.
        set -a
        # shellcheck disable=SC1090
        source "$ENV_DEPLOY_HOST"
        set +a
        export FILE_STORAGE_URL="${VIEWER_URL:?VIEWER_URL must be set in ~/ENV/online-staging-deploy.env}"
        export EDITOR_URL="${EDITOR_URL:?EDITOR_URL must be set in ~/ENV/online-staging-deploy.env}"
        export RELAY_URL="${RELAY_URL:?RELAY_URL must be set in ~/ENV/online-staging-deploy.env}"
        export TEST_TARGET="azure-deploy"
        export DOWNLOAD_BUDGET_MS="$AZURE_DOWNLOAD_BUDGET"
        # JOBS=1 means JOBS_SCALE=1 — patience timeouts not widened
        # for parallelism, but DOWNLOAD_BUDGET_MS adds the wall-time
        # wait for the WASM bundle to come down off Azure.
        export JOBS_SCALE=1
        echo "  FILE_STORAGE_URL=$FILE_STORAGE_URL"
        echo "  EDITOR_URL=$EDITOR_URL"
        echo "  DOWNLOAD_BUDGET_MS=$DOWNLOAD_BUDGET_MS"
        echo "===================="

        for entry in "${SMOKE_TESTS[@]}"; do
            slug="${entry%%:*}"
            script="${entry##*:}"
            log="$SMOKE_LOG_DIR/$slug.log"
            echo ""
            echo "--- $slug ($script) ---"
            START="$(date -u +%s)"
            set +e
            timeout 1800 node "$WORKSPACE/wasm/$script" > "$log" 2>&1
            rc=$?
            set -e
            END="$(date -u +%s)"
            DUR_T=$((END - START))
            if (( rc == 0 )); then
                echo "[PASS] $slug ($DUR_T s)"
            else
                echo "[FAIL rc=$rc] $slug ($DUR_T s)"
                echo "  --- last 20 log lines ---"
                tail -20 "$log" | sed 's/^/  /'
                echo "  --- end ---"
            fi
        done
    ) >> "$LOG" 2>&1

    # Tally Phase 2 from the log lines we just wrote.
    PHASE2_PASS="$(grep -cE '^\[PASS\] ' "$LOG" || true)"
    PHASE2_FAIL="$(grep -cE '^\[FAIL ' "$LOG" || true)"
    if (( PHASE2_FAIL > 0 )); then
        PHASE2_RC=1
    fi
fi

# ── Combined verdict ────────────────────────────────────────────────
TEST_RC=0
if (( PHASE1_RC != 0 || PHASE1_FAIL > 0 || PHASE2_RC != 0 )); then
    TEST_RC=1
fi
PASS_COUNT=$((PHASE1_PASS + PHASE2_PASS))
FAIL_COUNT=$((PHASE1_FAIL + PHASE2_FAIL))

END_TS="$(date -u +%s)"
DUR=$((END_TS - START_TS))

cat > "$SUMMARY_JSON" <<JSON
{
  "app_build_id": "$APP_BID",
  "exit_code": $TEST_RC,
  "duration_seconds": $DUR,
  "pass_count_approx": ${PASS_COUNT:-0},
  "fail_count_approx": ${FAIL_COUNT:-0},
  "phase1": { "target": "$TEST_TARGET", "pass": $PHASE1_PASS, "fail": $PHASE1_FAIL, "rc": $PHASE1_RC },
  "phase2": { "ran": $PHASE2_RAN, "pass": $PHASE2_PASS, "fail": $PHASE2_FAIL, "rc": $PHASE2_RC },
  "completed_utc": "$(date -u -d "@$END_TS" +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

# ── Wrapper HTML report ──────────────────────────────────────────────
STATUS_COLOUR="#2e7d32"; STATUS_TEXT="PASSED"
if [[ "$TEST_RC" != 0 ]]; then STATUS_COLOUR="#c62828"; STATUS_TEXT="FAILED (exit $TEST_RC)"; fi

LOG_ESC="$(python3 -c 'import html,sys; print(html.escape(open(sys.argv[1]).read()))' "$LOG")"
HAS_RICH_REPORT="$( [[ -f "$TEST_OUTPUT/reports/index.html" ]] && echo 1 || echo 0 )"

cat > "$REPORT_DIR/index.html" <<HTML
<!doctype html>
<meta charset="utf-8">
<title>tests for $APP_BID</title>
<style>
body{font:14px system-ui;margin:2rem;max-width:80rem}
h1{margin-bottom:.2rem}.muted{color:#666}
.badge{display:inline-block;padding:.2rem .6rem;border-radius:4px;color:white;background:$STATUS_COLOUR;font-weight:600}
pre{background:#0b1021;color:#d6e1ff;padding:1rem;border-radius:6px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.4}
a{color:#0066cc}
.box{border:1px solid #ddd;border-radius:6px;padding:1rem;margin:1rem 0}
.stat{display:inline-block;margin-right:1rem}
</style>
<h1>Tests for online build <code>$APP_BID</code></h1>
<p>Status: <span class="badge">$STATUS_TEXT</span> · duration ${DUR}s</p>
<p>
  <span class="stat"><strong>Phase 1 (local, JOBS=$TEST_JOBS):</strong> ${PHASE1_PASS}p / ${PHASE1_FAIL}f</span>
  <span class="stat"><strong>Phase 2 (Azure smoke, JOBS=1):</strong> $( (( PHASE2_RAN )) && echo "${PHASE2_PASS}p / ${PHASE2_FAIL}f" || echo "skipped" )</span>
</p>
<p><a href="../">← back to build summary</a> · <a href="summary.json">summary.json</a> · <a href="run.log">raw run.log</a></p>
$( [[ "$HAS_RICH_REPORT" == 1 ]] && cat <<RICH
<div class="box">
  <h3>Per-test reports + screenshots</h3>
  <p>Browse the full grid: <a href="output/reports/"><strong>open the test report grid</strong></a>.</p>
</div>
RICH
)
<details><summary>Wrapper run.log (full stdout/stderr)</summary>
<pre>$LOG_ESC</pre>
</details>
HTML

upload() {
    local src="$1" name="$2"
    local ctype=""
    case "$src" in
        *.png) ctype="image/png" ;;
        *.html) ctype="text/html; charset=utf-8" ;;
        *.json) ctype="application/json" ;;
        *.log|*.txt) ctype="text/plain; charset=utf-8" ;;
    esac
    local args=(--account-name "$ACCT" --container-name '$web'
                --name "$name" --file "$src" --overwrite --no-progress)
    [[ -n "$ctype" ]] && args+=(--content-type "$ctype")
    az storage blob upload "${args[@]}" >/dev/null
}

upload "$LOG"                  "app-builds/$APP_BID/tests/run.log"
upload "$SUMMARY_JSON"         "app-builds/$APP_BID/tests/summary.json"
upload "$REPORT_DIR/index.html" "app-builds/$APP_BID/tests/index.html"

# Upload junit.xml emitted by run-all-tests-parallel.sh's host-side
# REPORTS dir. Mirror it into REPORT_DIR so the workflow's
# upload-artifact step (path: junit.xml relative to workspace) resolves
# from the same source.
JUNIT_HOST="/tmp/static-deploy/public/reports/junit.xml"
if [[ -f "$JUNIT_HOST" ]]; then
    upload "$JUNIT_HOST" "app-builds/$APP_BID/tests/junit.xml"
    cp "$JUNIT_HOST" "$REPORT_DIR/junit.xml"
fi

# Step Summary — clickable links per test + suite, rendered on the
# GitHub Actions run page. Reads the same per-test .result files the
# JUnit emitter does, so links and statuses stay in lockstep.
write_step_summary() {
    local sum="${GITHUB_STEP_SUMMARY:-}"
    [[ -n "$sum" ]] || return 0
    local results_host="/tmp/static-deploy/public/reports/.logs"
    [[ -d "$results_host" ]] || return 0

    local report_base="$SITE/app-builds/$APP_BID/tests"
    local pass_n=0 fail_n=0 skip_n=0 total_t=0
    for r in "$results_host"/*.result; do
        [[ -f "$r" ]] || continue
        IFS='|' read -r slug status elapsed _t _d _s < "$r"
        case "$status" in
            pass) pass_n=$((pass_n+1)) ;;
            fail) fail_n=$((fail_n+1)) ;;
            *)    skip_n=$((skip_n+1)) ;;
        esac
        total_t=$((total_t + ${elapsed:-0}))
    done

    {
        echo "## WASM test suite — \`$APP_BID\`"
        echo
        echo "**Phase 1 (local):** $pass_n passed · $fail_n failed · $skip_n skipped — total **${total_t}s**"
        if (( PHASE2_RAN )); then
            echo
            echo "**Phase 2 (Azure smoke):** ${PHASE2_PASS} passed · ${PHASE2_FAIL} failed"
        fi
        echo
        echo "📊 [Open the full suite report]($report_base/) · [JUnit XML]($report_base/junit.xml) · [run.log]($report_base/run.log)"
        echo
        echo "| # | Test | Status | Duration | Report |"
        echo "|---|------|--------|----------|--------|"
        local i=1
        for r in "$results_host"/*.result; do
            [[ -f "$r" ]] || continue
            IFS='|' read -r slug status elapsed title _d _s < "$r"
            local icon="❓"
            case "$status" in
                pass) icon="✅" ;;
                fail) icon="❌" ;;
                skip|missing) icon="⚪" ;;
            esac
            local link="[open]($report_base/output/reports/$slug.html)"
            printf '| %d | %s | %s %s | %ss | %s |\n' \
                "$i" "${title:-$slug}" "$icon" "$status" "${elapsed:-0}" "$link"
            i=$((i+1))
        done
        if (( fail_n > 0 )); then
            echo
            echo "### ❌ Failed tests"
            for r in "$results_host"/*.result; do
                IFS='|' read -r slug status elapsed title _d _s < "$r"
                [[ "$status" == "fail" ]] || continue
                echo "- **$title** (\`$slug\`) — [report]($report_base/output/reports/$slug.html) · [log]($report_base/output/reports/.logs/$slug.log)"
            done
        fi
    } >> "$sum"
    echo "[OK] wrote GitHub step summary"
}
write_step_summary

# ── Stitch in host-side artefacts the tests wrote outside $TEST_OUTPUT ──
SHOTS_HOST="/tmp/static-deploy/public"
HOTSWITCH_HOST="/tmp/hot-switch-report"

mirror_fresh_files() {
    local src="$1" dst="$2"; shift 2
    [[ -d "$src" ]] || return 0
    local find_args=()
    if (( $# > 0 )); then
        find_args+=( '(' )
        local first=1
        for pat in "$@"; do
            (( first )) || find_args+=( -o )
            find_args+=( -name "$pat" )
            first=0
        done
        find_args+=( ')' )
    fi
    local count=0
    while IFS= read -r f; do
        local rel="${f#$src/}"
        mkdir -p "$dst/$(dirname "$rel")"
        cp -p "$f" "$dst/$rel"
        count=$((count + 1))
    done < <(find "$src" -type f "${find_args[@]}" -newer "$RUN_START_MARKER" 2>/dev/null)
    echo "  mirror $src → $dst : $count file(s)"
}

echo "--- Mirroring host artefacts into $TEST_OUTPUT ---"
# Include .log + .result + .xml so per-test log links from the GitHub
# step summary resolve, and downstream tooling can re-read structured
# per-test results / the JUnit XML.
mirror_fresh_files "$SHOTS_HOST/reports" "$TEST_OUTPUT/reports" '*.html' '*.json' '*.log' '*.result' '*.xml'

for shotdir in "$SHOTS_HOST"/shots*; do
    [[ -d "$shotdir" ]] || continue
    name="$(basename "$shotdir")"
    mirror_fresh_files "$shotdir" "$TEST_OUTPUT/$name" '*.png' 'checklist.json'
done

SNAPMS_SRC="$HOTSWITCH_HOST/snapshot-milestones"
if [[ -d "$SNAPMS_SRC" ]] && find "$SNAPMS_SRC" -newer "$RUN_START_MARKER" -print -quit 2>/dev/null | grep -q .; then
    mirror_fresh_files "$SNAPMS_SRC" "$TEST_OUTPUT/snapshot-milestones" '*.html' '*.png' '*.json'
    cat > "$TEST_OUTPUT/reports/snapshot-milestones.html" <<'HTML'
<!doctype html><meta charset="utf-8"><title>Snapshot Milestones — redirecting…</title>
<meta http-equiv="refresh" content="0; url=../snapshot-milestones/">
<script>location.replace('../snapshot-milestones/');</script>
<p><a href="../snapshot-milestones/">Open the snapshot-milestones rich report</a></p>
HTML
fi

TIMING_SRC="$SHOTS_HOST/timing-report"
if [[ -d "$TIMING_SRC" ]] && find "$TIMING_SRC" -newer "$RUN_START_MARKER" -print -quit 2>/dev/null | grep -q .; then
    mirror_fresh_files "$TIMING_SRC" "$TEST_OUTPUT/timing-report" '*.html' '*.png' '*.json'
    cat > "$TEST_OUTPUT/reports/timing-report.html" <<'HTML'
<!doctype html><meta charset="utf-8"><title>Timing Report — redirecting…</title>
<meta http-equiv="refresh" content="0; url=../timing-report/">
<script>location.replace('../timing-report/');</script>
<p><a href="../timing-report/">Open the timing-report rich report</a></p>
HTML
fi

if [[ "$HAS_RICH_REPORT" == 1 ]]; then
    echo "--- Uploading $TEST_OUTPUT → tests/output ---"
    az storage blob upload-batch \
        --account-name "$ACCT" \
        --destination '$web' \
        --destination-path "app-builds/$APP_BID/tests/output" \
        --source "$TEST_OUTPUT" \
        --pattern '*' \
        --overwrite \
        --no-progress 2>&1 | tail -5 || true
fi

# Patch the per-build index.html so the tests box gets a real link.
PATCHED="$(mktemp)"
az storage blob download --account-name "$ACCT" \
    --container-name '$web' --name "app-builds/$APP_BID/index.html" \
    --file "$PATCHED" --no-progress >/dev/null
python3 - "$PATCHED" "$STATUS_TEXT" "$STATUS_COLOUR" <<'PYEOF'
import sys
p, st, col = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(p).read()
new_box = (
    f'<div class="box" id="tests"><h3>Tests</h3>'
    f'<p>Status: <span style="background:{col};color:white;padding:.2rem .6rem;border-radius:4px;">{st}</span> '
    f'— <a href="tests/">full report</a> &middot; <a href="tests/summary.json">summary.json</a></p></div>'
)
import re
out = re.sub(r'<div class="box" id="tests">.*?</div>', new_box, src, count=1, flags=re.S)
open(p,'w').write(out)
PYEOF
upload "$PATCHED" "app-builds/$APP_BID/index.html"
rm -f "$PATCHED"

# Update manifest with combined test_report
MANIFEST="$(mktemp)"
az storage blob download --account-name "$ACCT" \
    --container-name '$web' --name "app-builds/$APP_BID/manifest.json" \
    --file "$MANIFEST" --no-progress >/dev/null
python3 - "$MANIFEST" "$APP_BID" "$TEST_RC" "$DUR" "$PASS_COUNT" "$FAIL_COUNT" \
    "$PHASE1_PASS" "$PHASE1_FAIL" "$PHASE2_RAN" "$PHASE2_PASS" "$PHASE2_FAIL" <<'PYEOF'
import json, sys
(p, app_bid, rc, dur, p_pass, p_fail,
 p1_pass, p1_fail, p2_ran, p2_pass, p2_fail) = sys.argv[1:12]
rc, dur, p_pass, p_fail = int(rc), int(dur), int(p_pass), int(p_fail)
p1_pass, p1_fail = int(p1_pass), int(p1_fail)
p2_ran, p2_pass, p2_fail = int(p2_ran), int(p2_pass), int(p2_fail)
m = json.load(open(p))
m["test_report"] = {
    "url": f"app-builds/{app_bid}/tests/",
    "exit_code": rc,
    "duration_seconds": dur,
    "pass_count": p_pass,
    "fail_count": p_fail,
    "phase1_local": { "pass": p1_pass, "fail": p1_fail },
    "phase2_azure_smoke": (
        { "pass": p2_pass, "fail": p2_fail } if p2_ran else { "skipped": True }
    ),
}
json.dump(m, open(p,'w'), indent=2)
PYEOF
upload "$MANIFEST" "app-builds/$APP_BID/manifest.json"
rm -f "$MANIFEST"

bash "$(dirname "$0")/regen-indexes.sh"

echo "Published: $SITE/app-builds/$APP_BID/tests/"
echo "  Phase 1 (local): ${PHASE1_PASS}p / ${PHASE1_FAIL}f"
if (( PHASE2_RAN )); then
    echo "  Phase 2 (Azure smoke): ${PHASE2_PASS}p / ${PHASE2_FAIL}f"
fi
exit "$TEST_RC"
