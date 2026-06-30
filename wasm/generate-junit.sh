#!/usr/bin/env bash
# Generate a JUnit-XML report from the per-test .result files written by
# run-all-tests.sh / run-all-tests-parallel.sh.
#
# Inputs (env / args):
#   $LOG_DIR              — dir with <slug>.result files (one line, pipe-sep)
#   $REPORTS_DIR          — where to write junit.xml (default: $LOG_DIR/..)
#   --base-url <url>      — optional; if given, each <testcase> gets a
#                           <system-out> with the per-test report URL
#                           (<base-url>/<slug>.html) so JUnit consumers
#                           can deep-link to the rich HTML report.
#
# Each .result line:  slug|status|elapsed|title|description|shots_name
# Each .log line:     /<LOG_DIR>/<slug>.log  (full stdout/stderr of the test)
#
# Output: $REPORTS_DIR/junit.xml — one <testsuite> with one <testcase> per
# slug. Failures get a <failure> body with the LAST 4KB of the test log
# (where the actual error usually is).
#
# Usage:
#   LOG_DIR=/tmp/.../reports/.logs REPORTS_DIR=/tmp/.../reports \
#       bash wasm/generate-junit.sh [--base-url https://…/tests/output/reports]

set -euo pipefail

BASE_URL=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --base-url) BASE_URL="$2"; shift 2 ;;
        --base-url=*) BASE_URL="${1#*=}"; shift ;;
        *) echo "ERROR: unknown arg $1" >&2; exit 1 ;;
    esac
done

LOG_DIR="${LOG_DIR:?LOG_DIR required}"
REPORTS_DIR="${REPORTS_DIR:-$(dirname "$LOG_DIR")}"
OUT="$REPORTS_DIR/junit.xml"

mkdir -p "$REPORTS_DIR"

# XML-escape: & < > " '
xml_escape() {
    sed -e 's/\&/\&amp;/g' \
        -e 's/</\&lt;/g' \
        -e 's/>/\&gt;/g' \
        -e 's/"/\&quot;/g' \
        -e "s/'/\&apos;/g"
}

# Strip ANSI escape codes + control chars XML can't represent. Pipe
# through `iconv -c` to discard invalid UTF-8 byte sequences — Kit's
# logs occasionally interleave non-UTF-8 bytes from binary tile data,
# which would otherwise yield "not well-formed" when an XML parser
# reads the result.
xml_safe_log() {
    # Last 4KB only — error usually surfaces near the tail; full log is in
    # the artefact bundle for anyone who needs the full thing.
    tail -c 4096 "$1" 2>/dev/null \
        | iconv -f utf-8 -t utf-8 -c 2>/dev/null \
        | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' \
        | tr -d '\000-\010\013\014\016-\037' \
        | xml_escape
}

# Aggregate counts + assemble cases.
N_TESTS=0; N_FAIL=0; N_SKIP=0
TOTAL_TIME=0
CASES=""

for result in "$LOG_DIR"/*.result; do
    [[ -f "$result" ]] || continue
    IFS='|' read -r slug status elapsed title description shots_name < "$result"
    : "${slug:?empty slug in $result}"
    : "${elapsed:=0}"
    : "${title:=$slug}"

    N_TESTS=$((N_TESTS + 1))
    TOTAL_TIME=$((TOTAL_TIME + elapsed))

    # XML-escape attribute values.
    name_attr="$(printf '%s' "$slug"  | xml_escape)"
    title_attr="$(printf '%s' "$title" | xml_escape)"

    case_xml="  <testcase classname=\"wasm.suite\" name=\"$name_attr\" time=\"$elapsed\">"

    if [[ "$status" == "fail" ]]; then
        N_FAIL=$((N_FAIL + 1))
        log_file="$LOG_DIR/$slug.log"
        body=""
        [[ -f "$log_file" ]] && body="$(xml_safe_log "$log_file")"
        case_xml+=$'\n'"    <failure message=\"$title_attr failed\" type=\"AssertionError\">"
        case_xml+=$'\n'"<![CDATA["
        # CDATA can contain anything except `]]>`; replace just in case.
        body_cdata="${body//]]>/]]&gt;}"
        case_xml+=$'\n'"$body_cdata"
        case_xml+=$'\n'"]]>"
        case_xml+=$'\n'"    </failure>"
    elif [[ "$status" == "missing" || "$status" == "skip" ]]; then
        N_SKIP=$((N_SKIP + 1))
        case_xml+=$'\n'"    <skipped/>"
    fi

    if [[ -n "$BASE_URL" ]]; then
        url="$BASE_URL/$slug.html"
        case_xml+=$'\n'"    <system-out><![CDATA[Report: $url]]></system-out>"
    fi

    case_xml+=$'\n'"  </testcase>"
    CASES+="$case_xml"$'\n'
done

if [[ "$N_TESTS" -eq 0 ]]; then
    echo "WARN: no .result files found in $LOG_DIR; junit.xml not written" >&2
    exit 0
fi

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HOSTNAME_SHORT="$(hostname -s 2>/dev/null || echo runner)"

{
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo "<testsuites name=\"wasm\" tests=\"$N_TESTS\" failures=\"$N_FAIL\" skipped=\"$N_SKIP\" time=\"$TOTAL_TIME\">"
    echo "<testsuite name=\"wasm.suite\" tests=\"$N_TESTS\" failures=\"$N_FAIL\" skipped=\"$N_SKIP\" time=\"$TOTAL_TIME\" timestamp=\"$TS\" hostname=\"$HOSTNAME_SHORT\">"
    printf '%s' "$CASES"
    echo "</testsuite>"
    echo "</testsuites>"
} > "$OUT"

echo "[OK] wrote $OUT  (tests=$N_TESTS  failures=$N_FAIL  skipped=$N_SKIP  total=${TOTAL_TIME}s)"
