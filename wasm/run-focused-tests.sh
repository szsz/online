#!/usr/bin/env bash
# run-focused-tests.sh — fast iter cycle for targeted bug work.
#
# Runs only the tests relevant to:
#   - copy/paste cluster (B→A propagation bugs)
#   - xlsx → xlsx hot-switch
#   - pptx → pptx hot-switch
#   - snapshot milestones (perf gate)
#
# Plus the new singleuser-copy-paste, hotswitch-xlsx, hotswitch-pptx tests
# once they exist.
#
# Usage:  bash wasm/run-focused-tests.sh             # JOBS=2
#         JOBS=4 bash wasm/run-focused-tests.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_OUTPUT_ROOT="${TEST_OUTPUT_ROOT:-/tmp/static-deploy/public}"
REPORTS_DIR="$TEST_OUTPUT_ROOT/reports-focused"
SHOTS_BASE="$TEST_OUTPUT_ROOT"
GENERATOR="$SCRIPT_DIR/generate-report.js"
LOG_DIR="$REPORTS_DIR/.logs"
JOBS="${JOBS:-2}"
mkdir -p "$REPORTS_DIR" "$LOG_DIR"

# Focused test list. Each entry: slug|script|title|description|shots-dir
TESTS=(
    # Copy/paste cluster
    "regression-mouse-select-copypaste|test-regression-mouse-select-copypaste.js|Regression: Mouse Select + Copy/Paste|Mouse click/double-click selection + copy/paste between 2 browsers|shots-regression-mouse-select-copypaste"
    "regression-paste-coedit|test-regression-paste-coedit.js|Regression: Paste Co-Edit|Text and image paste in 2-browser co-edit|shots-regression-paste-coedit"
    "regression-checkpoint-cursor-delete|test-regression-checkpoint-cursor-delete.js|Regression: Checkpoint Rotation + Cursor + Late-Join Delete|A inserts B selects A saves checkpoint rotates with cursor snapshot C joins B deletes all converge|shots-regression-checkpoint-cursor"
    "regression-plaintext-paste|test-regression-plaintext-paste.js|Regression: Plaintext Paste|Plaintext-only paste path|shots-regression-plaintext-paste"
    "latejoin-copypaste|test-late-join-copypaste.js|Late Join + Copy/Paste|Late joiner receives all paste content (internal external text external image)|shots-latejoin-copypaste"
    "e2e-copypaste|test-e2e-copypaste.js|E2E Copy/Paste|Real keyboard copy/paste between two browsers|shots-e2e-copypaste"
    # New single-user copy/paste (kit-side isolation)
    "singleuser-copy-paste|test-singleuser-copy-paste.js|Single-User Copy/Paste|All copy/paste flows in single-user mode (no relay): internal external text image plaintext save round-trip|shots-singleuser-copy-paste"
    # Hot-switch (new files added in iter10/iter11)
    "hotswitch-xlsx|test-hotswitch-xlsx.js|Hot-Switch xlsx → xlsx|Same-type Calc hot-switch via in-place reload|shots-hotswitch-xlsx"
    "hotswitch-pptx|test-hotswitch-pptx.js|Hot-Switch pptx → pptx|Same-type Impress hot-switch via in-place reload|shots-hotswitch-pptx"
    # Perf gate
    "snapshot-milestones|test-snapshot-milestones.js|Snapshot Milestones|Per-doc cold/warm × N=3 trials (writer calc impress)|none"
)

NUM_TESTS=${#TESTS[@]}
echo "Focused: $NUM_TESTS tests, JOBS=$JOBS"
echo "Reports: $REPORTS_DIR"
echo "Logs:    $LOG_DIR"

# Worker (same as parallel runner — invoked by xargs)
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

# Skip gracefully if test file does not exist yet (new tests planned but not authored).
if [ ! -f "$SCRIPT_DIR/$script" ]; then
    echo "skip|0|missing-test-file|$title|$description|$shots_name" > "$LOG_DIR/$slug.result"
    echo "skip 0s $slug (no script: $script)" >&2
    exit 0
fi

t_start=$(date +%s)
status="pass"
TMPDIR="$tmpdir" timeout 1200 node "$SCRIPT_DIR/$script" > "$log_file" 2>&1
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

rm -f "$LOG_DIR"/*.result

T0=$(date +%s)
printf '%s\n' "${TESTS[@]}" | \
    xargs -d '\n' -P "$JOBS" -I {} \
    "$WORKER" "$SCRIPT_DIR" "$SHOTS_BASE" "$REPORTS_DIR" "$LOG_DIR" "$GENERATOR" "{}"

TOTAL_WALL=$(( $(date +%s) - T0 ))
echo
echo "=== Focused done in ${TOTAL_WALL}s wall ==="

PASSED=0; FAILED=0; SKIPPED=0; TOTAL=0
ROWS_HTML=""
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
    case "$status" in
        pass) PASSED=$((PASSED + 1)) ;;
        skip) SKIPPED=$((SKIPPED + 1)) ;;
        *)    FAILED=$((FAILED + 1)) ;;
    esac
    ROWS_HTML+="<tr class=\"$status\"><td>$i</td><td><a href=\"$slug.html\">$title</a></td>"
    ROWS_HTML+="<td class=\"s\">$status</td><td class=\"dur\">${elapsed}</td>"
    ROWS_HTML+="<td>$description</td></tr>"
    i=$((i + 1))
done

TIMESTAMP="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
cat > "$REPORTS_DIR/index.html" <<HTMLEOF
<!doctype html><html><head><meta charset="utf-8"/>
<title>Focused Tests — ${TIMESTAMP}</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:1200px;margin:2rem auto;padding:0 1rem;color:#222}
h1{border-bottom:2px solid #333;padding-bottom:.3em}
table{border-collapse:collapse;width:100%;margin:1rem 0;font-size:14px}
th,td{border:1px solid #ddd;padding:6px 10px;text-align:left;vertical-align:middle}
th{background:#f4f4f4}
tr.pass td.s{background:#dfd}
tr.fail td.s,tr.missing td.s{background:#fdd}
tr.skip td.s{background:#eee;color:#888}
.dur{text-align:right;font-variant-numeric:tabular-nums}
</style></head><body>
<h1>Focused Tests — ${TIMESTAMP}</h1>
<p>Wall: <strong>${TOTAL_WALL}s</strong> (parallel JOBS=${JOBS}).
Total: ${TOTAL} · Pass: ${PASSED} · Fail: ${FAILED} · Skip: ${SKIPPED}</p>
<table>
<thead><tr><th>#</th><th>Test</th><th class="s">Status</th><th class="dur">Time (s)</th><th>Description</th></tr></thead>
<tbody>${ROWS_HTML}</tbody></table>
</body></html>
HTMLEOF

echo "Summary: ${PASSED}/${TOTAL} pass (${FAILED} fail, ${SKIPPED} skip). Wall: ${TOTAL_WALL}s"
echo "URL: https://viewer.szebeni.hu/reports-focused/"
