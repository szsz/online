#!/usr/bin/env bash
# run-all-tests-parallel.sh — parallel test suite runner.
# Uses xargs -P for batching (more reliable than bash job control).
#
# Usage:  bash wasm/run-all-tests-parallel.sh        # 2 jobs (default)
#         JOBS=4 bash wasm/run-all-tests-parallel.sh # legacy parallel-4
#
# Iter 215: default dropped from 4→2. JOBS=4 had ±5 fail variance
# per run because the relay-broker + viewer-server saturate under
# heavier contention; tests that pass solo timed out in the
# parallel-4 run. JOBS=2 keeps most of the speedup while halving
# the contention pressure.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_OUTPUT_ROOT="${TEST_OUTPUT_ROOT:-/tmp/static-deploy/public}"
REPORTS_DIR="$TEST_OUTPUT_ROOT/reports"
SHOTS_BASE="$TEST_OUTPUT_ROOT"
GENERATOR="$SCRIPT_DIR/generate-report.js"
LOG_DIR="$REPORTS_DIR/.logs"
JOBS="${JOBS:-2}"
# Iter 70: scale 2-browser test patience timeouts proportionally to
# parallelism. See lib/test-env.js scaleTimeout() — tests that route
# their timeouts through it widen automatically when JOBS_SCALE > 1.
export JOBS_SCALE="${JOBS_SCALE:-$JOBS}"
mkdir -p "$REPORTS_DIR" "$LOG_DIR"

# Parse TESTS array from canonical runner.
mapfile -t TESTS < <(awk '
    /^TESTS=\(/   { in_tests = 1; next }
    /^\)/         { if (in_tests) { exit } }
    in_tests && /^[[:space:]]*"/ {
        sub(/^[[:space:]]+"/, "")
        sub(/"$/, "")
        print
    }
' "$SCRIPT_DIR/run-all-tests.sh")

NUM_TESTS=${#TESTS[@]}
echo "Loaded $NUM_TESTS tests, JOBS=$JOBS"
echo "Reports: $REPORTS_DIR"
echo "Logs:    $LOG_DIR"

# Worker script — invoked by xargs.
WORKER="$LOG_DIR/_worker.sh"
cat > "$WORKER" <<'WORKER_EOF'
#!/usr/bin/env bash
SCRIPT_DIR="$1"; SHOTS_BASE="$2"; REPORTS_DIR="$3"; LOG_DIR="$4"
GENERATOR="$5"; entry="$6"

IFS='|' read -r slug script title description shots_name <<< "$entry"
shots_dir="$SHOTS_BASE/$shots_name"
report_file="$REPORTS_DIR/$slug.html"
log_file="$LOG_DIR/$slug.log"
tmpdir="/tmp/test-${slug}-$$-$RANDOM"
mkdir -p "$tmpdir"

# Iter 77: scale per-test wrapper timeout under contention (matches
# the env.scaleTimeout widening inside tests). Floor at 1800s so
# JOBS_SCALE=1 keeps the prior ceiling.
SCALE="${JOBS_SCALE:-1}"
case "$SCALE" in *.*) SCALE_INT=$(printf '%.0f' "$SCALE") ;; *) SCALE_INT="$SCALE" ;; esac
WRAPPER_TIMEOUT=$(( 1800 * SCALE_INT ))
[ "$WRAPPER_TIMEOUT" -lt 1800 ] && WRAPPER_TIMEOUT=1800

t_start=$(date +%s)
status="pass"
TMPDIR="$tmpdir" timeout "$WRAPPER_TIMEOUT" node "$SCRIPT_DIR/$script" > "$log_file" 2>&1
rc=$?
if [ $rc -ne 0 ]; then status="fail"; fi
elapsed=$(( $(date +%s) - t_start ))

echo "$slug|$status|$elapsed|$title|$description|$shots_name" > "$LOG_DIR/$slug.result"
node "$GENERATOR" --name "$title" --desc "$description" --shots "$shots_dir" \
    --output "$report_file" --status "$status" >> "$log_file" 2>&1
rm -rf "$tmpdir" 2>/dev/null

echo "$status  ${elapsed}s  $slug" >&2
WORKER_EOF
chmod +x "$WORKER"

# Clear stale results
rm -f "$LOG_DIR"/*.result

T0=$(date +%s)

# Dispatch via xargs -P for batched parallelism.
# -n 1 + -I {} conflict; use only -I.
printf '%s\n' "${TESTS[@]}" | \
    xargs -d '\n' -P "$JOBS" -I {} \
    "$WORKER" "$SCRIPT_DIR" "$SHOTS_BASE" "$REPORTS_DIR" "$LOG_DIR" "$GENERATOR" "{}"

TOTAL_WALL=$(( $(date +%s) - T0 ))
echo
echo "=== All tests done in ${TOTAL_WALL}s wall ==="

# Generate summary index
TIMESTAMP="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
PASSED=0; FAILED=0; TOTAL=0
ROWS_HTML=""
# HTML-escape title/description before injecting into the table cells.
# A literal `<id>` (e.g. in "/wasm/<id>?access_token=…") in a test
# description used to make the browser parser treat it as an unknown
# HTML tag and swallow the rest of the table — a row 46 test's `<id>`
# truncated the rendered table to 46 rows on build 2026-05-17-085355,
# while the summary at the top still showed Total: 107.
html_escape() {
    printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\\&#39;/g"
}

i=1
for entry in "${TESTS[@]}"; do
    IFS='|' read -r slug script title description shots_name <<< "$entry"
    result="$LOG_DIR/$slug.result"
    if [ ! -f "$result" ]; then
        status="missing"; elapsed=0
    else
        IFS='|' read -r r_slug status elapsed r_title r_desc r_shots < "$result"
    fi
    TOTAL=$((TOTAL + 1))
    if [ "$status" = "pass" ]; then PASSED=$((PASSED + 1)); else FAILED=$((FAILED + 1)); fi
    title_esc=$(html_escape "$title")
    desc_esc=$(html_escape "$description")
    slug_esc=$(html_escape "$slug")
    ROWS_HTML+="<tr class=\"$status\"><td>$i</td><td><a href=\"${slug_esc}.html\">${title_esc}</a></td>"
    ROWS_HTML+="<td class=\"s\">$status</td><td class=\"dur\">${elapsed}</td>"
    ROWS_HTML+="<td>${desc_esc}</td></tr>"
    i=$((i + 1))
done

cat > "$REPORTS_DIR/index.html" <<HTMLEOF
<!doctype html><html><head><meta charset="utf-8"/>
<title>WASM Test Suite — ${TIMESTAMP}</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:1200px;margin:2rem auto;padding:0 1rem;color:#222}
h1{border-bottom:2px solid #333;padding-bottom:.3em}
table{border-collapse:collapse;width:100%;margin:1rem 0;font-size:14px}
th,td{border:1px solid #ddd;padding:6px 10px;text-align:left;vertical-align:middle}
th{background:#f4f4f4}
tr.pass td.s{background:#dfd}
tr.fail td.s,tr.missing td.s{background:#fdd}
.dur{text-align:right;font-variant-numeric:tabular-nums}
.embed-section{margin:2rem 0;padding:1rem;border:1px solid #eee;background:#fafafa}
.embed-section h2{margin-top:0}
.embed-section iframe{width:100%;height:600px;border:1px solid #ccc}
.summary-stat{font-size:18px;margin:.5em 0}
.pass-count{color:#22863a;font-weight:600}
.fail-count{color:#cb2431;font-weight:600}
</style></head><body>
<h1>WASM Test Suite — ${TIMESTAMP}</h1>
<p class="summary-stat">Wall time: <strong>${TOTAL_WALL}s</strong> (parallel, ${JOBS} jobs).
Total: ${TOTAL} · Passed: <span class="pass-count">${PASSED}</span> ·
Failed: <span class="fail-count">${FAILED}</span></p>
<table>
<thead><tr><th>#</th><th>Test</th><th class="s">Status</th><th class="dur">Time (s)</th><th>Description</th></tr></thead>
<tbody>${ROWS_HTML}</tbody></table>

<div class="embed-section">
<h2>Snapshot Milestones (per-doc cold/warm × N=3 trials)</h2>
<!-- Relative path resolves on both local viewer and Azure publish.
     The rich report is mirrored to ../snapshot-milestones/ (sibling
     of this reports/ dir) by test-and-publish.sh and the local
     deploy. /report/snapshot-milestones/ (absolute) only worked on
     the local viewer with its `/report/*` static route, not on the
     coolwasmfiles.z6.web.core.windows.net publish path. -->
<p><a href="../snapshot-milestones/">Open in new tab →</a></p>
<iframe src="../snapshot-milestones/"></iframe>
</div>

</body></html>
HTMLEOF

echo "Summary: $PASSED/$TOTAL passed (${FAILED} failed). Wall: ${TOTAL_WALL}s"
echo "URL: https://viewer.szebeni.hu/reports/"

# JUnit XML for CI consumers (GitHub Actions, etc). The CI publisher
# can pass --base-url to inject per-test report URLs into <system-out>.
# JUNIT_BASE_URL env propagates the base URL for local runs (optional).
JUNIT_ARGS=()
if [ -n "${JUNIT_BASE_URL:-}" ]; then
    JUNIT_ARGS=(--base-url "$JUNIT_BASE_URL")
fi
LOG_DIR="$LOG_DIR" REPORTS_DIR="$REPORTS_DIR" \
    bash "$SCRIPT_DIR/generate-junit.sh" "${JUNIT_ARGS[@]}" || true
