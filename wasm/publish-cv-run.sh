#!/usr/bin/env bash
# publish-cv-run.sh — run the content-viewer test suite against a deployed
# content viewer and publish a provenance-stamped result table to the
# coolwasmfiles static site.
#
#   bash wasm/publish-cv-run.sh                 # full CV suite
#   bash wasm/publish-cv-run.sh cv-coedit-typing cv-singleuser   # subset
#
# Publishes:
#   $web/cv-runs/index.html          rolling table: one row per run with the
#                                    content-preview commit, editor commit +
#                                    version, LO commit + build id, pass/fail
#                                    and a link to the per-run report
#   $web/cv-runs/<runId>/index.html  per-run report (provenance + per-test
#                                    status + logs)
#
# Provenance sources (all deployed truth, not local guesses):
#   <viewer>/version.json                     cp_commit, cp_branch, collabora_version
#   <cdn>/collabora-<ver>/build-info.json     editor git_sha, build id, lo_build_id
#   coolwasmfiles/lo-builds/<id>/MANIFEST.json  LO git_sha
#
# Env: CONTENT_VIEWER_URL (default wasm-viewer-test), EDITOR_CDN_URL
# (default the wasmeditor Front Door), PUBLISH_ACCOUNT (default coolwasmfiles).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTENT_VIEWER_URL="${CONTENT_VIEWER_URL:-https://wasm-viewer-test.azurewebsites.net}"

# Repo-pinned content-preview commit (wasm/CONTENT_VIEWER_COMMIT.txt). Recorded
# in the run alongside the deployed cp_commit so the table flags drift between
# what this tree expects and what was actually tested.
source "$SCRIPT_DIR/lib/cv-provenance.sh"
CP_PINNED="$(cv_pinned_commit)"
EDITOR_CDN_URL="${EDITOR_CDN_URL:-https://wasmeditor-enhhe6gndwb0d2ej.a02.azurefd.net}"
STATIC_SITE_BASE="${STATIC_SITE_BASE:-https://coolwasmfiles.z6.web.core.windows.net}"
PUBLISH_ACCOUNT="${PUBLISH_ACCOUNT:-coolwasmfiles}"
TEST_TIMEOUT="${TEST_TIMEOUT:-1800}"

RUN_ID="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
WORK="$(mktemp -d -t cv-run-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/out/logs"

echo "=== CV test run $RUN_ID → $CONTENT_VIEWER_URL ==="

# ── Provenance ──────────────────────────────────────────────────────
VERSION_JSON="$(curl -fsS --max-time 20 "$CONTENT_VIEWER_URL/version.json" 2>/dev/null || echo '{}')"
CP_COMMIT="$(node -e "console.log((JSON.parse(process.argv[1]).cp_commit)||'')" "$VERSION_JSON" 2>/dev/null || echo '')"
CP_BRANCH="$(node -e "console.log((JSON.parse(process.argv[1]).cp_branch)||'')" "$VERSION_JSON" 2>/dev/null || echo '')"
COLLAB_VER="$(node -e "console.log((JSON.parse(process.argv[1]).collabora_version)||'')" "$VERSION_JSON" 2>/dev/null || echo '')"
BUILD_INFO='{}'
if [[ -n "$COLLAB_VER" ]]; then
    BUILD_INFO="$(curl -fsS --max-time 20 "$EDITOR_CDN_URL/collabora-$COLLAB_VER/build-info.json" 2>/dev/null || echo '{}')"
fi
EDITOR_SHA="$(node -e "console.log((JSON.parse(process.argv[1]).git_sha)||'')" "$BUILD_INFO" 2>/dev/null || echo '')"
EDITOR_BUILD_ID="$(node -e "console.log((JSON.parse(process.argv[1]).id)||'')" "$BUILD_INFO" 2>/dev/null || echo '')"
LO_BUILD_ID="$(node -e "console.log((JSON.parse(process.argv[1]).lo_build_id)||'')" "$BUILD_INFO" 2>/dev/null || echo '')"
LO_SHA=''
if [[ -n "$LO_BUILD_ID" ]]; then
    LO_SHA="$(curl -fsS --max-time 20 "$STATIC_SITE_BASE/lo-builds/$LO_BUILD_ID/MANIFEST.json" 2>/dev/null \
        | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).git_sha||'')}catch(e){console.log('')}})" || echo '')"
fi
echo "  cp=$CP_COMMIT ($CP_BRANCH) pinned=${CP_PINNED:-none}  editor=$EDITOR_SHA @ $COLLAB_VER  lo=$LO_SHA @ $LO_BUILD_ID"

# ── Test list: content-viewer entries from the canonical runner ─────
mapfile -t ALL_TESTS < <(awk '
    /^TESTS=\(/ { in_tests = 1; next }
    /^\)/       { if (in_tests) exit }
    in_tests && /^[[:space:]]*"/ {
        sub(/^[[:space:]]+"/, ""); sub(/"$/, ""); print
    }' "$SCRIPT_DIR/run-all-tests.sh" | grep '|tests/content-viewer/')

if [[ $# -gt 0 ]]; then
    FILTERED=()
    for want in "$@"; do
        for entry in "${ALL_TESTS[@]}"; do
            [[ "$entry" == "$want|"* ]] && FILTERED+=("$entry")
        done
    done
    ALL_TESTS=("${FILTERED[@]}")
fi
echo "  ${#ALL_TESTS[@]} test(s) to run"

# ── Run ─────────────────────────────────────────────────────────────
T_START=$(date +%s)
RESULTS_JSON='[]'
for entry in "${ALL_TESTS[@]}"; do
    IFS='|' read -r slug script title _desc _shots <<< "$entry"
    echo "  → $slug"
    t0=$(date +%s)
    status=pass
    BASE_URL="$CONTENT_VIEWER_URL" timeout "$TEST_TIMEOUT" \
        node "$SCRIPT_DIR/$script" > "$WORK/out/logs/$slug.log" 2>&1 || status=fail
    secs=$(( $(date +%s) - t0 ))
    echo "    $status (${secs}s)"
    RESULTS_JSON="$(node -e "
        const r = JSON.parse(process.argv[1]);
        r.push({ slug: process.argv[2], title: process.argv[3],
                 status: process.argv[4], seconds: parseInt(process.argv[5],10),
                 log: 'logs/' + process.argv[2] + '.log' });
        console.log(JSON.stringify(r));
    " "$RESULTS_JSON" "$slug" "$title" "$status" "$secs")"
done
WALL=$(( $(date +%s) - T_START ))

# ── Render ──────────────────────────────────────────────────────────
node -e "
    fs = require('fs');
    fs.writeFileSync(process.argv[1], JSON.stringify({
        runId: process.argv[2], startedUtc: process.argv[2].replace(/-(\d\d)-(\d\d)Z$/, ':\$1:\$2Z'),
        wallSeconds: parseInt(process.argv[3],10),
        provenance: {
            cp_commit: process.argv[4], cp_branch: process.argv[5],
            editor_version: process.argv[6], editor_commit: process.argv[7],
            editor_build_id: process.argv[8],
            lo_build_id: process.argv[9], lo_commit: process.argv[10],
            target_url: process.argv[11],
            cp_commit_pinned: process.argv[13],
        },
        results: JSON.parse(process.argv[12]),
    }, null, 2));
" "$WORK/run.json" "$RUN_ID" "$WALL" "$CP_COMMIT" "$CP_BRANCH" "$COLLAB_VER" \
  "$EDITOR_SHA" "$EDITOR_BUILD_ID" "$LO_BUILD_ID" "$LO_SHA" "$CONTENT_VIEWER_URL" "$RESULTS_JSON" "$CP_PINNED"

# Seed the rolling table from the currently-published runs.json.
curl -fsS --max-time 20 "$STATIC_SITE_BASE/cv-runs/runs.json" -o "$WORK/existing-runs.json" 2>/dev/null || echo '[]' > "$WORK/existing-runs.json"
node "$SCRIPT_DIR/tools/cv-run-report.js" "$WORK/run.json" "$WORK/out" "$WORK/existing-runs.json"

# ── Publish ─────────────────────────────────────────────────────────
if [[ -z "${AZURE_STORAGE_KEY:-}" ]]; then
    AZURE_STORAGE_KEY="$(az storage account keys list --account-name "$PUBLISH_ACCOUNT" --query '[0].value' -o tsv)"
fi
export AZURE_STORAGE_KEY AZURE_STORAGE_ACCOUNT="$PUBLISH_ACCOUNT"

# Per-run page + logs under cv-runs/<runId>/, rolling table at cv-runs/.
az storage blob upload-batch --destination "\$web" --source "$WORK/out" \
    --destination-path "cv-runs/$RUN_ID" \
    --pattern 'index.html' --overwrite --no-progress --output none
az storage blob upload-batch --destination "\$web" --source "$WORK/out/logs" \
    --destination-path "cv-runs/$RUN_ID/logs" --overwrite --no-progress --output none 2>/dev/null || true
az storage blob upload --container-name "\$web" --name "cv-runs/index.html" \
    --file "$WORK/out/runs-index.html" --content-type "text/html; charset=utf-8" \
    --overwrite --no-progress --output none
az storage blob upload --container-name "\$web" --name "cv-runs/runs.json" \
    --file "$WORK/out/runs.json" --content-type "application/json" \
    --overwrite --no-progress --output none

PASS=$(node -e "console.log(JSON.parse(process.argv[1]).filter(r=>r.status==='pass').length)" "$RESULTS_JSON")
TOTAL=$(node -e "console.log(JSON.parse(process.argv[1]).length)" "$RESULTS_JSON")
echo ""
echo "Run $RUN_ID: $PASS/$TOTAL passed (wall ${WALL}s)"
echo "  Table:  $STATIC_SITE_BASE/cv-runs/"
echo "  Report: $STATIC_SITE_BASE/cv-runs/$RUN_ID/"
