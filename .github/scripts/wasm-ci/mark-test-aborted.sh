#!/usr/bin/env bash
# Defensive guard: when the test job in wasm-ci.yml exits without
# uploading its own summary.json — because the suite hung past the
# step timeout, the runner was force-cancelled, or the job was
# manually cancelled mid-run — the published manifest at
#   app-builds/<APP_BUILD_ID>/manifest.json
# is left with test_report: null. regen-indexes.sh then renders the
# build in app-builds/index.html with a "no tests yet" cell forever,
# which is indistinguishable from "tests still running" and hides
# real CI failures.
#
# This script runs from an `if: always()` step after the test step.
# If the test step already uploaded a populated summary.json, this
# is a no-op. Otherwise it patches the manifest with a synthetic
# test_report marking the run as aborted and rebuilds the indexes
# so the index entry reflects reality.
#
# Inputs (env):
#   APP_BUILD_ID  — the build whose manifest needs the guard
#   GIT_SHA       — informational (passed through)
#   TEST_JOB_STATUS — github job-status string ("success" / "failure"
#                     / "cancelled"). Only set on the cleanup step.
#
# Exit code: 0 on success or no-op (this guard must never fail the
# job — that would obscure the real cancellation reason).
set -euo pipefail

# shellcheck source=_lib.sh
source "$(dirname "$0")/_lib.sh"
ensure_storage_key

APP_BID="${APP_BUILD_ID:?APP_BUILD_ID must be set}"
ACCT="${AZURE_STORAGE_ACCOUNT:?AZURE_STORAGE_ACCOUNT must be set}"
JOB_STATUS="${TEST_JOB_STATUS:-cancelled}"

MANIFEST_BLOB="app-builds/$APP_BID/manifest.json"
SUMMARY_BLOB="app-builds/$APP_BID/tests/summary.json"

# 1) If summary.json was already uploaded by test-and-publish.sh,
#    test-and-publish.sh also updated the manifest — nothing to do.
if az storage blob exists \
      --account-name "$ACCT" --container-name '$web' \
      --name "$SUMMARY_BLOB" \
      --query 'exists' -o tsv 2>/dev/null | grep -q '^true$'; then
    echo "Summary already published; no abort guard needed."
    exit 0
fi

# 2) Fetch the current manifest. If it doesn't exist yet (build-deploy
#    step itself failed before publish-app-build.sh ran), there's
#    nothing to patch.
TMP="$(mktemp)"
trap "rm -f '$TMP'" EXIT
if ! az storage blob download --account-name "$ACCT" \
        --container-name '$web' --name "$MANIFEST_BLOB" \
        --file "$TMP" --no-progress >/dev/null 2>&1; then
    echo "No manifest at $MANIFEST_BLOB — build-deploy never published; nothing to patch."
    exit 0
fi

# 3) Patch test_report with an "aborted" marker and reupload.
python3 - "$TMP" "$JOB_STATUS" <<'PYEOF'
import json, sys, os, datetime
path, status = sys.argv[1], sys.argv[2]
m = json.load(open(path))
# Don't overwrite a real test_report if one snuck in between the
# `blob exists` probe above and this download.
if isinstance(m.get("test_report"), dict) and "exit_code" in m["test_report"]:
    print("test_report already populated; nothing to patch.")
    sys.exit(0)
m["test_report"] = {
    "url": f"app-builds/{m.get('app_build_id','')}/tests/",
    "exit_code": 124,        # standard "timed out / killed" rc
    "duration_seconds": 0,
    "pass_count": 0,
    "fail_count": 0,
    "aborted": True,
    "abort_reason": status,  # "cancelled" / "failure" / etc.
    "marked_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
json.dump(m, open(path, "w"), indent=2)
print(f"Patched manifest: test_report.aborted=true ({status})")
PYEOF

az storage blob upload \
    --account-name "$ACCT" --container-name '$web' \
    --name "$MANIFEST_BLOB" --file "$TMP" \
    --content-type 'application/json' \
    --overwrite --no-progress >/dev/null

# 4) Regenerate the app-builds index so the build's row reflects the
#    abort instead of staying frozen on "no tests yet".
bash "$(dirname "$0")/regen-indexes.sh" || \
    echo "WARN: regen-indexes failed; index will catch up on next run"

echo "Marked $APP_BID as aborted ($JOB_STATUS); indexes refreshed."
