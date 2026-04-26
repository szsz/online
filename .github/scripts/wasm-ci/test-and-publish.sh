#!/usr/bin/env bash
# Run wasm/run-all-tests.sh and publish a report under app-builds/<ID>/tests/.
#
# The Azure-deployed services tested are the ones the build-deploy job just
# pushed. run-all-tests.sh today targets the local launches by default; when
# adapting tests to point at the deployed Azure URLs, leave the report-name
# emission alone — this script captures stdout/stderr verbatim and produces
# a simple log.html that the per-build index.html links to.
set -euo pipefail

APP_BID="${APP_BUILD_ID:?}"
ACCT="${AZURE_STORAGE_ACCOUNT:?}"
SITE="${STATIC_SITE_BASE:?}"
WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"

REPORT_DIR="$(mktemp -d)"
trap "rm -rf '$REPORT_DIR'" EXIT

LOG="$REPORT_DIR/run.log"
SUMMARY_JSON="$REPORT_DIR/summary.json"
START_TS="$(date -u +%s)"

set +e
( cd "$WORKSPACE/wasm" && bash run-all-tests.sh ) > "$LOG" 2>&1
TEST_RC=$?
set -e
END_TS="$(date -u +%s)"
DUR=$((END_TS - START_TS))

# Tests report rough pass/fail counts via "ok N tests" / "FAIL" markers in
# the existing scripts; this is a pragmatic best-effort scrape — refine if
# the suite gains a structured reporter.
PASS_COUNT="$(grep -cE '^\[?[Pp][Aa][Ss][Ss]\]?|✓|^ok ' "$LOG" || true)"
FAIL_COUNT="$(grep -cE '^\[?[Ff][Aa][Ii][Ll]\]?|✗|^not ok ' "$LOG" || true)"

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
</style>
<h1>Tests for online build <code>$APP_BID</code></h1>
<p>Status: <span class="badge">$STATUS_TEXT</span> · duration ${DUR}s</p>
<p><a href="../">← back to build summary</a> · <a href="summary.json">summary.json</a></p>
<pre>$LOG_ESC</pre>
HTML

upload() {
    local src="$1" name="$2"
    az storage blob upload \
        --account-name "$ACCT" \
        --auth-mode login \
        --container-name '$web' \
        --name "$name" \
        --file "$src" \
        --overwrite \
        --no-progress >/dev/null
}

upload "$LOG"                  "app-builds/$APP_BID/tests/run.log"
upload "$SUMMARY_JSON"         "app-builds/$APP_BID/tests/summary.json"
upload "$REPORT_DIR/index.html" "app-builds/$APP_BID/tests/index.html"

# Patch the per-build index.html so the tests box gets a real link.
PATCHED="$(mktemp)"
az storage blob download --account-name "$ACCT" --auth-mode login \
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
az storage blob download --account-name "$ACCT" --auth-mode login \
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
