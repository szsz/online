#!/usr/bin/env bash
# Publish per-build summary + index pages for an online deploy.
#
# Storage layout (under $web container, served via static-website endpoint):
#   app-builds/<APP_BUILD_ID>/index.html   — summary card with links
#   app-builds/<APP_BUILD_ID>/manifest.json
#   app-builds/index.html                  — list of recent app builds
#   index.html                             — top-level (lo + app builds)
#
# We do NOT re-upload the deploy zips here — the editor/relay/viewer are
# already live on App Services. The summary just records what got deployed
# and links the test report (filled in later by test-and-publish.sh).
set -euo pipefail

# shellcheck source=_lib.sh
source "$(dirname "$0")/_lib.sh"
ensure_storage_key

APP_BID="${APP_BUILD_ID:?}"
LO_BID="${LO_BUILD_ID:?}"
ACCT="${AZURE_STORAGE_ACCOUNT:?}"
SITE="${STATIC_SITE_BASE:?}"

OUT="$(mktemp -d)"
trap "rm -rf '$OUT'" EXIT

# Manifest
cat > "$OUT/manifest.json" <<JSON
{
  "app_build_id": "$APP_BID",
  "lo_build_id": "$LO_BID",
  "git_sha": "${GIT_SHA:-}",
  "git_ref": "${GIT_REF:-}",
  "completed_utc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "endpoints": {
    "viewer": "https://szebeni-wasm-viewer.azurewebsites.net",
    "editor": "https://szebeni-wasm-static.azurewebsites.net",
    "relay":  "wss://szebeni-wasm-relay.azurewebsites.net"
  },
  "test_report": null
}
JSON

# Per-build summary HTML (test report link added later by test job, if it runs)
cat > "$OUT/index.html" <<HTML
<!doctype html>
<meta charset="utf-8">
<title>online build $APP_BID</title>
<style>
body{font:14px system-ui;margin:2rem;max-width:60rem}
h1{margin-bottom:.2rem}.muted{color:#666}
.k{display:inline-block;min-width:11rem;color:#555}
a{color:#0066cc;text-decoration:none}a:hover{text-decoration:underline}
.box{border:1px solid #ddd;border-radius:6px;padding:1rem;margin:1rem 0}
</style>
<h1>Online build <code>$APP_BID</code></h1>
<p class="muted">Built against LibreOffice <a href="../../lo-builds/$LO_BID/">$LO_BID</a></p>

<div class="box">
  <div><span class="k">Git SHA:</span> <code>${GIT_SHA:-?}</code></div>
  <div><span class="k">Git ref:</span> <code>${GIT_REF:-?}</code></div>
  <div><span class="k">Completed (UTC):</span> $(date -u +%Y-%m-%dT%H:%M:%SZ)</div>
</div>

<div class="box">
  <h3>Live endpoints (just deployed)</h3>
  <ul>
    <li>Viewer  &nbsp;<a href="https://szebeni-wasm-viewer.azurewebsites.net">szebeni-wasm-viewer.azurewebsites.net</a></li>
    <li>Editor  &nbsp;<a href="https://szebeni-wasm-static.azurewebsites.net">szebeni-wasm-static.azurewebsites.net</a></li>
    <li>Relay   &nbsp;<code>wss://szebeni-wasm-relay.azurewebsites.net</code></li>
  </ul>
</div>

<div class="box" id="tests">
  <h3>Tests</h3>
  <p class="muted">Test report will appear here once the test job completes.</p>
</div>

<p><a href="../">← all online builds</a> · <a href="../../">root</a></p>
HTML

upload() {
    local src="$1" name="$2"
    az storage blob upload \
        --account-name "$ACCT" \
        --container-name '$web' \
        --name "$name" \
        --file "$src" \
        --overwrite \
        --no-progress >/dev/null
}

upload "$OUT/manifest.json" "app-builds/$APP_BID/manifest.json"
upload "$OUT/index.html"   "app-builds/$APP_BID/index.html"

# Refresh the app-builds list and the root index.
bash "$(dirname "$0")/regen-indexes.sh"

echo "Published: $SITE/app-builds/$APP_BID/"
