#!/usr/bin/env bash
# Run wasm/run-all-tests.sh against the JUST-DEPLOYED Azure App Services
# (TEST_TARGET=azure-deploy) and publish a report under app-builds/<ID>/tests/.
#
# Isolation from the local dev environment:
#   - No local services started; tests hit the deployed Azure URLs only.
#   - URLs sourced from $CI_STATE_DIR/.env.deploy (host-managed, not in repo).
#   - lib/test-env.js skips its wasm/.env requirement when these URLs are
#     already in process.env, so we don't need to drop a .env in the runner
#     checkout.
set -euo pipefail

# shellcheck source=_lib.sh
source "$(dirname "$0")/_lib.sh"
ensure_storage_key

APP_BID="${APP_BUILD_ID:?}"
ACCT="${AZURE_STORAGE_ACCOUNT:?}"
SITE="${STATIC_SITE_BASE:?}"
WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"

# ── Source App Services URLs from the host-managed .env.deploy ──────────
ENV_DEPLOY_HOST="${CI_STATE_DIR:?}/.env.deploy"
if [[ ! -f "$ENV_DEPLOY_HOST" ]]; then
    echo "ERROR: $ENV_DEPLOY_HOST not found — needed for TEST_TARGET=azure-deploy URLs" >&2
    exit 1
fi
# shellcheck disable=SC1090
set -a; source "$ENV_DEPLOY_HOST"; set +a

# Tests read FILE_STORAGE_URL, EDITOR_URL, RELAY_URL from env (lib/test-env.js).
# .env.deploy already provides VIEWER_URL/EDITOR_URL/RELAY_URL with the right
# values; FILE_STORAGE_URL is the viewer (which fronts the document storage).
export FILE_STORAGE_URL="${VIEWER_URL:?VIEWER_URL must be set in .env.deploy}"
export EDITOR_URL="${EDITOR_URL:?EDITOR_URL must be set in .env.deploy}"
export RELAY_URL="${RELAY_URL:?RELAY_URL must be set in .env.deploy}"
export TEST_TARGET="azure-deploy"

REPORT_DIR="$(mktemp -d)"
trap "rm -rf '$REPORT_DIR'" EXIT

# ── Install wasm/node_modules + puppeteer's Chromium (persistent cache) ──
# The test scripts require puppeteer; without node_modules every test
# crashes at `Cannot find module 'puppeteer'`. We keep node_modules,
# the npm download cache, and puppeteer's Chromium binary in $CI_STATE_DIR
# so the second-and-later runs reinstall in seconds.
NODE_MODULES_HOST="${CI_STATE_DIR}/online-node-modules"
NPM_CACHE_HOST="${CI_STATE_DIR}/npm-cache"
PUPPETEER_CACHE_HOST="${CI_STATE_DIR}/puppeteer-cache"
mkdir -p "$NODE_MODULES_HOST" "$NPM_CACHE_HOST" "$PUPPETEER_CACHE_HOST"
export PUPPETEER_CACHE_DIR="$PUPPETEER_CACHE_HOST"

# Replace whatever's at wasm/node_modules with a symlink to the host cache,
# so npm writes into the persistent location and tests find the modules.
rm -rf "$WORKSPACE/wasm/node_modules"
ln -s "$NODE_MODULES_HOST" "$WORKSPACE/wasm/node_modules"

# Reinstall when the lock file changes (or on the first run). The marker
# file inside the persistent dir records the lock file we last installed
# from; if it differs from the current one, do a fresh `npm ci`.
LOCK="$WORKSPACE/wasm/package-lock.json"
INSTALLED_FROM="$NODE_MODULES_HOST/.installed-from-lock"
if [[ ! -f "$INSTALLED_FROM" ]] || ! cmp -s "$LOCK" "$INSTALLED_FROM"; then
    echo "--- Installing wasm/node_modules (cache=$NPM_CACHE_HOST chromium=$PUPPETEER_CACHE_HOST) ---"
    # Empty the persistent dir so npm ci sees a clean slate. The symlink
    # we just made is preserved by removing dir contents, not the dir.
    find "$NODE_MODULES_HOST" -mindepth 1 -delete 2>/dev/null || true
    (cd "$WORKSPACE/wasm" && npm ci --cache "$NPM_CACHE_HOST" --prefer-offline --no-audit --no-fund 2>&1 | tail -8)
    cp "$LOCK" "$INSTALLED_FROM"
    echo "[OK] node_modules installed."
else
    echo "[OK] node_modules cache hit (lockfile unchanged)."
fi

# Direct run-all-tests.sh's per-test HTML reports + screenshots into a
# per-build subtree so we can upload them all together at the end. The
# layout (created by run-all-tests.sh + generate-report.js):
#   $TEST_OUTPUT/reports/index.html             — top-level test grid
#   $TEST_OUTPUT/reports/<slug>.html            — per-test detail page
#   $TEST_OUTPUT/shots[-<slug>]/*.png           — screenshots
TEST_OUTPUT="$REPORT_DIR/output"
mkdir -p "$TEST_OUTPUT"
export TEST_OUTPUT_ROOT="$TEST_OUTPUT"

LOG="$REPORT_DIR/run.log"
SUMMARY_JSON="$REPORT_DIR/summary.json"
START_TS="$(date -u +%s)"

{
    echo "=== TEST_TARGET=$TEST_TARGET ==="
    echo "  FILE_STORAGE_URL=$FILE_STORAGE_URL"
    echo "  EDITOR_URL=$EDITOR_URL"
    echo "  RELAY_URL=$RELAY_URL"
    echo "  APP_BUILD_ID=$APP_BID  LO_BUILD_ID=${LO_BUILD_ID:-?}"
    echo "  GIT_SHA=${GIT_SHA:-?}"
    echo "  TEST_OUTPUT_ROOT=$TEST_OUTPUT_ROOT"
    echo "==========================================="
} > "$LOG"

set +e
( cd "$WORKSPACE/wasm" && bash run-all-tests.sh ) >> "$LOG" 2>&1
TEST_RC=$?
set -e
END_TS="$(date -u +%s)"
DUR=$((END_TS - START_TS))

# Pass/fail counts: prefer the rich-report grid (run-all-tests.sh writes
# badge-pass / badge-fail rows in $TEST_OUTPUT/reports/index.html). Fall
# back to a log scrape if the rich report is missing (early failure).
if [[ -f "$TEST_OUTPUT/reports/index.html" ]]; then
    PASS_COUNT=$(grep -c 'badge-pass' "$TEST_OUTPUT/reports/index.html" || true)
    FAIL_COUNT=$(grep -c 'badge-fail' "$TEST_OUTPUT/reports/index.html" || true)
else
    PASS_COUNT="$(grep -cE '^\[?[Pp][Aa][Ss][Ss]\]?|✓|^ok ' "$LOG" || true)"
    FAIL_COUNT="$(grep -cE '^\[?[Ff][Aa][Ii][Ll]\]?|✗|^not ok ' "$LOG" || true)"
fi
# run-all-tests.sh exits 0 even if individual tests fail (it only uses
# `set -uo pipefail`, no -e). Reflect actual test status in TEST_RC so
# the GitHub job badge turns red on real failures.
if [[ "$TEST_RC" == 0 && "${FAIL_COUNT:-0}" -gt 0 ]]; then
    TEST_RC=1
fi

cat > "$SUMMARY_JSON" <<JSON
{
  "app_build_id": "$APP_BID",
  "exit_code": $TEST_RC,
  "duration_seconds": $DUR,
  "pass_count_approx": ${PASS_COUNT:-0},
  "fail_count_approx": ${FAIL_COUNT:-0},
  "completed_utc": "$(date -u -d "@$END_TS" +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

# Report HTML — a colour-coded header plus the full log inline.
STATUS_COLOUR="#2e7d32"; STATUS_TEXT="PASSED"
if [[ "$TEST_RC" != 0 ]]; then STATUS_COLOUR="#c62828"; STATUS_TEXT="FAILED (exit $TEST_RC)"; fi

# HTML-escape the log
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
</style>
<h1>Tests for online build <code>$APP_BID</code></h1>
<p>Status: <span class="badge">$STATUS_TEXT</span> · duration ${DUR}s</p>
<p><a href="../">← back to build summary</a> · <a href="summary.json">summary.json</a> · <a href="run.log">raw run.log</a></p>
$( [[ "$HAS_RICH_REPORT" == 1 ]] && cat <<RICH
<div class="box">
  <h3>Per-test reports + screenshots</h3>
  <p>Browse the full grid: <a href="output/reports/"><strong>open the test report grid</strong></a>.</p>
  <p>Each row links to its per-test detail page with screenshots, timings, and step-level checks.</p>
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

# Upload the rich per-test report tree (HTML + screenshots) if it exists.
# Use upload-batch for efficiency; a single tests run can produce hundreds
# of screenshots across ~50 test slugs.
if [[ "$HAS_RICH_REPORT" == 1 ]]; then
    echo "Uploading per-test reports + screenshots from $TEST_OUTPUT …"
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

# Update manifest with test_report link
MANIFEST="$(mktemp)"
az storage blob download --account-name "$ACCT" \
    --container-name '$web' --name "app-builds/$APP_BID/manifest.json" \
    --file "$MANIFEST" --no-progress >/dev/null
python3 - "$MANIFEST" "$APP_BID" "$TEST_RC" "$DUR" <<'PYEOF'
import json, sys
p, app_bid, rc, dur = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
m = json.load(open(p))
m["test_report"] = {
    "url": f"app-builds/{app_bid}/tests/",
    "exit_code": rc,
    "duration_seconds": dur,
}
json.dump(m, open(p,'w'), indent=2)
PYEOF
upload "$MANIFEST" "app-builds/$APP_BID/manifest.json"
rm -f "$MANIFEST"

bash "$(dirname "$0")/regen-indexes.sh"

echo "Published: $SITE/app-builds/$APP_BID/tests/"
exit "$TEST_RC"
