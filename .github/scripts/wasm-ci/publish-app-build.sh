#!/usr/bin/env bash
# Publish per-build summary + manifest + the three deploy zips for an
# online deploy, all under app-builds/<APP_BUILD_ID>/ on coolwasmfiles.
#
# Storage layout (under $web container, served via static-website endpoint):
#   app-builds/<APP_BUILD_ID>/index.html      — summary card with links
#   app-builds/<APP_BUILD_ID>/manifest.json   — { build_id, lo_build_id, git, zips:[…] }
#   app-builds/<APP_BUILD_ID>/viewer.zip      — exact bytes deployed to viewer App Service
#   app-builds/<APP_BUILD_ID>/relay.zip       — exact bytes deployed to relay App Service
#   app-builds/<APP_BUILD_ID>/editor.zip      — exact bytes deployed to editor App Service
#   app-builds/index.html                     — list of recent app builds
#   index.html                                — top-level (lo + app builds)
#
# Why archive the zips: today's `workflow_dispatch --online_sha` redeploy
# path rebuilds from source. Same SHA + same LO_BUILD_ID *should* produce
# identical bytes, but npm transitive drift or compiler-version changes
# can break that contract. By archiving the actual zips that just shipped
# to staging, `wasm/promote-online-build.sh` can replay those exact bytes
# into internal/prod without recompiling — the strongest reproducibility
# guarantee available short of a content-addressed build.
set -euo pipefail

# shellcheck source=_lib.sh
source "$(dirname "$0")/_lib.sh"
ensure_storage_key

APP_BID="${APP_BUILD_ID:?}"
LO_BID="${LO_BUILD_ID:?}"
ACCT="${AZURE_STORAGE_ACCOUNT:?}"
SITE="${STATIC_SITE_BASE:?}"

# EDITOR_BUILD_ID: which editor folder on FD this Online build is
# wired to. Set explicitly by the new editor-build workflow when it
# rebuilds the editor alone; in wasm-ci.yml (combined build) it
# defaults to APP_BID (editor was rebuilt in the same run).
EDITOR_BID="${EDITOR_BUILD_ID:-$APP_BID}"

# Content-preview commit this online build is paired with — the repo pin
# (wasm/CONTENT_VIEWER_COMMIT.txt). Recorded in the manifest + build card
# alongside lo_build_id / editor_build_id so every app-build says which
# content viewer the editor belongs in.
CV_COMMIT=""
_CV_LIB="$(cd "$(dirname "$0")/../../.." && pwd)/wasm/lib/cv-provenance.sh"
if [[ -f "$_CV_LIB" ]]; then
    # shellcheck source=/dev/null
    source "$_CV_LIB"
    CV_COMMIT="$(cv_pinned_commit)"
fi

# Source the staging deploy env to discover where deploy-azure.sh staged
# the three zips (VIEWER_DEPLOY_DIR, RELAY_DEPLOY_DIR, EDITOR_DEPLOY_DIR).
# This is the same env file the deploy step sourced; the zips it produced
# live at "${DEPLOY_DIR}.zip" alongside the dirs and persist after deploy.
STAGING_DEPLOY_ENV="${STAGING_DEPLOY_ENV:-$HOME/ENV/online-staging-deploy.env}"
if [[ ! -f "$STAGING_DEPLOY_ENV" ]]; then
    echo "ERROR: $STAGING_DEPLOY_ENV not found — cannot locate deploy zips." >&2
    exit 1
fi
# shellcheck disable=SC1090
source "$STAGING_DEPLOY_ENV"

# Only viewer + relay zips are produced by deploy-azure.sh now.
# Editor zip used to live here too, but the editor moved to Front
# Door + Storage in 2026-05-12 — the FD folder IS the artefact, no
# per-build zip is archived (the manifest at editor-builds/<id>/
# records its identity).
VIEWER_ZIP="${VIEWER_DEPLOY_DIR:?VIEWER_DEPLOY_DIR not set in $STAGING_DEPLOY_ENV}.zip"
RELAY_ZIP="${RELAY_DEPLOY_DIR:?RELAY_DEPLOY_DIR not set}.zip"

for z in "$VIEWER_ZIP" "$RELAY_ZIP"; do
    if [[ ! -f "$z" ]]; then
        echo "ERROR: deploy zip missing: $z" >&2
        echo "       deploy-azure.sh must have run successfully before this script." >&2
        exit 1
    fi
done

OUT="$(mktemp -d)"
trap "rm -rf '$OUT'" EXIT

# Hash + size each zip so promote can verify integrity before deploy.
md5_of() { md5sum "$1" | cut -d' ' -f1; }
size_of() { stat -c '%s' "$1"; }

VIEWER_MD5="$(md5_of "$VIEWER_ZIP")";  VIEWER_SIZE="$(size_of "$VIEWER_ZIP")"
RELAY_MD5="$(md5_of "$RELAY_ZIP")";    RELAY_SIZE="$(size_of "$RELAY_ZIP")"

cat > "$OUT/manifest.json" <<JSON
{
  "app_build_id": "$APP_BID",
  "editor_build_id": "$EDITOR_BID",
  "lo_build_id": "$LO_BID",
  "content_viewer_commit": "$CV_COMMIT",
  "git_sha": "${GIT_SHA:-}",
  "git_ref": "${GIT_REF:-}",
  "completed_utc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "endpoints": {
    "viewer": "${VIEWER_URL:-https://szebeni-wasm-viewer.azurewebsites.net}",
    "editor": "${EDITOR_URL:-https://wasmeditor-enhhe6gndwb0d2ej.a02.azurefd.net}/$EDITOR_BID",
    "relay":  "${RELAY_URL:-wss://szebeni-wasm-relay.azurewebsites.net}"
  },
  "zips": [
    { "service": "viewer", "name": "viewer.zip", "size": $VIEWER_SIZE, "md5": "$VIEWER_MD5" },
    { "service": "relay",  "name": "relay.zip",  "size": $RELAY_SIZE,  "md5": "$RELAY_MD5"  }
  ],
  "test_report": null
}
JSON

# Per-build summary HTML — links to the live endpoints, the LO core
# build it was linked against, the three downloadable zips, and the
# (later-attached) test report. Promote consumers find the zip URLs
# from the manifest, not by parsing this HTML.
fmt_mb() { awk -v n="$1" 'BEGIN{printf "%.1f", n/1048576}'; }

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
code.hash{font-size:.85em;color:#666}
</style>
<h1>Online build <code>$APP_BID</code></h1>
<p class="muted">Built against LibreOffice <a href="../../lo-builds/$LO_BID/">$LO_BID</a>
   · Editor folder <a href="../../editor-builds/$EDITOR_BID/">$EDITOR_BID</a></p>

<div class="box">
  <div><span class="k">Git SHA:</span> <code>${GIT_SHA:-?}</code></div>
  <div><span class="k">Git ref:</span> <code>${GIT_REF:-?}</code></div>
  <div><span class="k">Content viewer:</span> $( [[ -n "$CV_COMMIT" ]] && echo "<a href=\"https://bitbucket.org/tresorit/content-preview/commits/$CV_COMMIT\"><code>${CV_COMMIT:0:7}</code></a> <span class=\"muted\">(content-preview, pinned)</span>" || echo "<code>?</code>" )</div>
  <div><span class="k">Completed (UTC):</span> $(date -u +%Y-%m-%dT%H:%M:%SZ)</div>
</div>

<div class="box">
  <h3>Live endpoints (just deployed)</h3>
  <ul>
    <li>Viewer &nbsp;<a href="${VIEWER_URL:-https://szebeni-wasm-viewer.azurewebsites.net}">${VIEWER_URL:-https://szebeni-wasm-viewer.azurewebsites.net}</a></li>
    <li>Editor &nbsp;<a href="${EDITOR_URL:-https://wasmeditor-enhhe6gndwb0d2ej.a02.azurefd.net}/$EDITOR_BID/browser/dist/cool.html">${EDITOR_URL:-https://wasmeditor-enhhe6gndwb0d2ej.a02.azurefd.net}/$EDITOR_BID/</a> &nbsp;<span class="muted">(Front Door + Storage static-site)</span></li>
    <li>Relay  &nbsp;<code>${RELAY_URL:-wss://szebeni-wasm-relay.azurewebsites.net}</code></li>
  </ul>
</div>

<div class="box">
  <h3>Deploy zips (replayable via <code>wasm/promote-online-build.sh</code>)</h3>
  <ul>
    <li><a href="viewer.zip">viewer.zip</a> &nbsp;<span class="muted">$(fmt_mb "$VIEWER_SIZE") MB</span> &nbsp;<code class="hash">md5 $VIEWER_MD5</code></li>
    <li><a href="relay.zip">relay.zip</a> &nbsp;<span class="muted">$(fmt_mb "$RELAY_SIZE") MB</span> &nbsp;<code class="hash">md5 $RELAY_MD5</code></li>
    <li>Editor: <a href="../../editor-builds/$EDITOR_BID/">editor-builds/$EDITOR_BID/</a> &nbsp;<span class="muted">(Front Door static — no per-build zip)</span></li>
  </ul>
  <p class="muted">Promote: <code>bash wasm/promote-online-build.sh $APP_BID ~/ENV/online-internal-deploy.env</code></p>
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

# Upload the three zips first — if they fail, the build summary should
# not be made visible (manifest is the source of truth for promote, and
# a manifest pointing at missing zips is worse than no manifest).
echo "Uploading zips ($(fmt_mb "$VIEWER_SIZE") + $(fmt_mb "$RELAY_SIZE") MB)..."
upload "$VIEWER_ZIP" "app-builds/$APP_BID/viewer.zip"
upload "$RELAY_ZIP"  "app-builds/$APP_BID/relay.zip"

# Now the manifest + summary HTML.
upload "$OUT/manifest.json" "app-builds/$APP_BID/manifest.json"
upload "$OUT/index.html"    "app-builds/$APP_BID/index.html"

# Update the latest pointer LAST — only flip after the manifest + zips
# are durably uploaded. promote-online-build.sh fetches via
# `app-builds/latest.txt`, so a half-uploaded build must never become
# `latest`. Mirror the convention used by lo-builds/latest.txt so a
# uniform consumer (LO promote, online promote) can resolve "latest".
echo -n "$APP_BID" > "$OUT/latest.txt"
upload "$OUT/latest.txt" "app-builds/latest.txt"

# Refresh the app-builds list and the root index. NON-FATAL: the
# manifest + per-build index are already uploaded above, so the build
# itself is durable. If listing-page regen fails (env var drift, az
# transient, etc.), don't fail the whole build-deploy job — that
# would skip the test step (`needs: build-deploy`), even though the
# build artefacts are fine. The next dev push will refresh the
# listing; today's failure is a missing entry, not a missing build.
bash "$(dirname "$0")/regen-indexes.sh" || {
    echo "WARNING: regen-indexes.sh failed (exit $?). Listing pages may be stale until the next push refreshes them. Build artefacts at $SITE/app-builds/$APP_BID/ are unaffected." >&2
}

echo "Published: $SITE/app-builds/$APP_BID/"
echo "         + $SITE/app-builds/latest.txt now points at $APP_BID"
