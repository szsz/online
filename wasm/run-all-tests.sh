#!/usr/bin/env bash
# run-all-tests.sh — Run all WASM co-editing tests, generate per-test HTML
# reports and a summary index page.
#
# Usage:  bash wasm/run-all-tests.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORTS_DIR="/tmp/static-deploy/public/reports"
SHOTS_BASE="/tmp/static-deploy/public"
GENERATOR="$SCRIPT_DIR/generate-report.js"

mkdir -p "$REPORTS_DIR"

# ── Test definitions ────────────────────────────────────────────────────
# Each entry:  slug | script | human name | description | shots_dir_name
TESTS=(
    "relay|test-relay.js|Relay Test|WebSocket relay message ordering and delivery|none"
    "2browser|test-cursor-debug.js|2-Browser Co-Edit|Two browsers co-editing with cursor sync|shots"
    "3browser|test-3browsers.js|3-Browser Co-Edit|Three browsers simultaneous co-editing|shots3"
    "formats|test-formats.js|Format Tests|Opening multiple document formats|shots-formats"
    "pptx|test-pptx.js|PPTX / Impress|PowerPoint presentation opening in Impress|shots-pptx"
    "pptx-coedit|test-pptx-coedit.js|PPTX Co-Editing|Two browsers co-editing a PowerPoint presentation|shots-pptx-coedit"
    "latejoin|test-late-join.js|Late Join|Late-joining user receives current document state|shots-latejoin"
    "stress|test-stress.js|Stress Test|Rapid concurrent edits under load|shots-stress"
    "caching|test-caching.js|Caching Test|WASM module caching and reuse|shots-caching"
)

# ── Run tests one by one ───────────────────────────────────────────────
declare -A RESULTS   # slug -> pass|fail
TOTAL=0
PASSED=0
FAILED=0

for entry in "${TESTS[@]}"; do
    IFS='|' read -r slug script title description shots_name <<< "$entry"
    shots_dir="$SHOTS_BASE/$shots_name"
    report_file="$REPORTS_DIR/$slug.html"

    echo "========================================"
    echo "  Running: $title  ($script)"
    echo "========================================"

    status="pass"
    if node "$SCRIPT_DIR/$script" 2>&1; then
        echo "  => PASS"
    else
        status="fail"
        echo "  => FAIL (exit code $?)"
    fi

    RESULTS[$slug]="$status"
    TOTAL=$((TOTAL + 1))
    if [ "$status" = "pass" ]; then
        PASSED=$((PASSED + 1))
    else
        FAILED=$((FAILED + 1))
    fi

    # Generate individual report
    node "$GENERATOR" \
        --name "$title" \
        --desc "$description" \
        --shots "$shots_dir" \
        --output "$report_file" \
        --status "$status"
done

# ── Generate summary index page ────────────────────────────────────────
TIMESTAMP="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"

cat > "$REPORTS_DIR/index.html" <<HTMLEOF
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>WASM Co-Editing Test Suite — Summary</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #fff; color: #1a1a1a;
    line-height: 1.5;
  }
  .container { max-width: 720px; margin: 0 auto; padding: 2rem 1.5rem; }
  h1 { margin: 0 0 0.25rem; font-size: 1.75rem; }
  .meta { color: #666; font-size: 0.9rem; margin-bottom: 1.5rem; }
  .summary-bar {
    display: flex; gap: 1rem; margin-bottom: 1.5rem;
    font-weight: 600; font-size: 1rem;
  }
  .summary-bar .total { color: #444; }
  .summary-bar .pass  { color: #16a34a; }
  .summary-bar .fail  { color: #dc2626; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.6rem 0.75rem; }
  th { border-bottom: 2px solid #e5e7eb; font-size: 0.85rem; color: #888; text-transform: uppercase; letter-spacing: 0.04em; }
  td { border-bottom: 1px solid #f0f0f0; }
  tr:last-child td { border-bottom: none; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .badge {
    display: inline-block; padding: 0.15rem 0.6rem; border-radius: 4px;
    color: #fff; font-weight: 600; font-size: 0.85rem;
  }
  .badge-pass { background: #16a34a; }
  .badge-fail { background: #dc2626; }
</style>
</head>
<body>
<div class="container">
  <h1>WASM Co-Editing Test Suite</h1>
  <div class="meta">${TIMESTAMP}</div>
  <div class="summary-bar">
    <span class="total">Total: ${TOTAL}</span>
    <span class="pass">Passed: ${PASSED}</span>
    <span class="fail">Failed: ${FAILED}</span>
  </div>
  <table>
    <thead><tr><th>Status</th><th>Test</th><th>Description</th></tr></thead>
    <tbody>
HTMLEOF

for entry in "${TESTS[@]}"; do
    IFS='|' read -r slug script title description shots_name <<< "$entry"
    st="${RESULTS[$slug]}"
    if [ "$st" = "pass" ]; then
        badge='<span class="badge badge-pass">PASS</span>'
    else
        badge='<span class="badge badge-fail">FAIL</span>'
    fi
    cat >> "$REPORTS_DIR/index.html" <<ROW
      <tr>
        <td>${badge}</td>
        <td><a href="${slug}.html">${title}</a></td>
        <td>${description}</td>
      </tr>
ROW
done

cat >> "$REPORTS_DIR/index.html" <<'HTMLEOF'
    </tbody>
  </table>
</div>
</body>
</html>
HTMLEOF

echo ""
echo "========================================"
echo "  Summary: ${PASSED}/${TOTAL} passed, ${FAILED} failed"
echo "  Report:  ${REPORTS_DIR}/index.html"
echo "========================================"
