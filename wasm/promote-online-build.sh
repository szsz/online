#!/usr/bin/env bash
# promote-online-build.sh — Replay an archived online build into another
# Azure App Services environment without rebuilding from source.
#
# Usage:
#   bash wasm/promote-online-build.sh <APP_BUILD_ID> <ENV_FILE>
#   bash wasm/promote-online-build.sh 2026-05-06-42 ~/ENV/online-internal-deploy.env
#   bash wasm/promote-online-build.sh latest        ~/ENV/online-prod-deploy.env
#
# What this does
# --------------
# 1. Resolves <APP_BUILD_ID> ("latest" → coolwasmfiles app-builds/latest.txt).
# 2. Downloads the three deploy zips (viewer/relay/editor) from
#    coolwasmfiles app-builds/<ID>/ to a temp dir.
# 3. Verifies each zip's MD5 against the manifest (rejects mid-flight
#    swaps or stale CDN copies).
# 4. Sources <ENV_FILE> to learn the target App Service names + apply
#    settings via deploy-azure.sh's existing --settings path.
# 5. Runs `az webapp deploy --type zip --clean true --src-path` against
#    each target App Service.
# 6. Smoke-tests each public URL.
#
# Why this exists
# ---------------
# The default redeploy path (workflow_dispatch on wasm-ci.yml with
# online_sha) rebuilds from source. Same SHA + same LO_BUILD_ID *should*
# produce identical bytes, but npm transitive drift, compiler changes,
# or non-deterministic build steps can break that contract. Promoting
# pre-built zips guarantees the bytes that ran in staging are exactly
# the bytes running in internal/prod.
#
# Authentication
# --------------
# Same as deploy-azure.sh: `az login` first (or service-principal env vars
# already configured). The runner identity needs:
#   - Reader on the coolwasmfiles storage account (to list account keys
#     for blob download)
#   - Contributor on the target Resource Group (to az webapp deploy)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Args ─────────────────────────────────────────────────────────
if [[ $# -lt 2 ]]; then
    cat <<USAGE >&2
Usage: $0 <APP_BUILD_ID|latest> <ENV_FILE>
Example: $0 2026-05-06-42 ~/ENV/online-internal-deploy.env
         $0 latest        ~/ENV/online-prod-deploy.env
USAGE
    exit 2
fi
APP_BID="$1"
ENV_FILE="$2"

if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: env file not found: $ENV_FILE" >&2
    exit 1
fi

# ── Storage config ───────────────────────────────────────────────
AZURE_STORAGE_ACCOUNT="${AZURE_STORAGE_ACCOUNT:-coolwasmfiles}"
STATIC_SITE_BASE="${STATIC_SITE_BASE:-https://coolwasmfiles.z6.web.core.windows.net}"

if ! az account show --only-show-errors >/dev/null 2>&1; then
    echo "ERROR: Azure CLI is not logged in. Run \`az login\` first." >&2
    exit 1
fi

# Resolve "latest" via the public static-website endpoint (no auth, no key).
if [[ "$APP_BID" == "latest" ]]; then
    APP_BID="$(curl -fsSL "$STATIC_SITE_BASE/app-builds/latest.txt" 2>/dev/null \
        | tr -d '[:space:]')"
    if [[ -z "$APP_BID" ]]; then
        echo "ERROR: app-builds/latest.txt is empty or unreachable." >&2
        exit 1
    fi
    echo "Resolved 'latest' → $APP_BID"
fi

# ── Manifest fetch + parse ──────────────────────────────────────
SCRATCH="$(mktemp -d)"
trap "rm -rf '$SCRATCH'" EXIT

MAN_URL="$STATIC_SITE_BASE/app-builds/$APP_BID/manifest.json"
echo "Fetching manifest: $MAN_URL"
if ! curl -fsSL "$MAN_URL" -o "$SCRATCH/manifest.json"; then
    echo "ERROR: manifest not found at $MAN_URL" >&2
    echo "       Verify the APP_BUILD_ID exists at" >&2
    echo "       $STATIC_SITE_BASE/app-builds/" >&2
    exit 1
fi

# Pull the LO build id this app-build was linked against — surfaced
# back to the user so they can sanity-check (e.g. don't promote a
# build linked against an LO core that's incompatible with the target
# env's spellcheck dictionaries). Not enforced; just informational.
LO_BID="$(jq -r '.lo_build_id' "$SCRATCH/manifest.json")"
GIT_SHA="$(jq -r '.git_sha' "$SCRATCH/manifest.json")"
echo "  app_build_id : $APP_BID"
echo "  lo_build_id  : $LO_BID"
echo "  git_sha      : $GIT_SHA"

# ── Download + verify each zip ──────────────────────────────────
download_and_verify() {
    local service="$1" expected_md5="$2" expected_size="$3"
    local out="$SCRATCH/${service}.zip"
    local url="$STATIC_SITE_BASE/app-builds/$APP_BID/${service}.zip"
    echo "  fetching $service.zip ($(awk -v n="$expected_size" 'BEGIN{printf "%.1f", n/1048576}') MB)..."
    curl -fsSL "$url" -o "$out"
    local got_md5; got_md5="$(md5sum "$out" | cut -d' ' -f1)"
    local got_size; got_size="$(stat -c '%s' "$out")"
    if [[ "$got_md5" != "$expected_md5" ]]; then
        echo "ERROR: $service.zip md5 mismatch — expected $expected_md5, got $got_md5" >&2
        echo "       This indicates a corrupted blob or a mid-flight swap." >&2
        exit 1
    fi
    if [[ "$got_size" != "$expected_size" ]]; then
        echo "ERROR: $service.zip size mismatch — expected $expected_size, got $got_size" >&2
        exit 1
    fi
    echo "    md5 OK ($got_md5)"
}

echo "Downloading + verifying zips..."
# The editor moved from App Service to Azure Front Door + Storage in
# 2026-05-12 (iter 246). Builds since then archive only viewer + relay
# zips; the editor is deployed separately by editor-build.yml and
# referenced via EDITOR_DEPLOY_ID app settings on each viewer. Skip
# any zip the manifest doesn't list rather than aborting.
for service in viewer relay editor; do
    md5="$(jq -r ".zips[] | select(.service == \"$service\") | .md5" "$SCRATCH/manifest.json")"
    size="$(jq -r ".zips[] | select(.service == \"$service\") | .size" "$SCRATCH/manifest.json")"
    if [[ -z "$md5" || "$md5" == "null" || -z "$size" || "$size" == "null" ]]; then
        if [[ "$service" == "editor" ]]; then
            echo "  (no editor zip — build is post-FD; editor lives on Front Door, skipping)"
            continue
        fi
        echo "ERROR: manifest does not list $service zip — was this build archived before the zip-archive feature landed?" >&2
        exit 1
    fi
    download_and_verify "$service" "$md5" "$size"
done

# ── Source target env ───────────────────────────────────────────
echo "Loading target env: $ENV_FILE"
# shellcheck disable=SC1090
source "$ENV_FILE"
for var in RESOURCE_GROUP VIEWER_APP_NAME RELAY_APP_NAME \
           VIEWER_URL RELAY_URL EDITOR_URL; do
    if [[ -z "${!var:-}" ]]; then
        echo "ERROR: $var is not set in $ENV_FILE" >&2
        exit 1
    fi
done

# ── Apply settings (idempotent) ─────────────────────────────────
# Settings (CORS / FILE_STORAGE_URL / DOC_STORAGE_*) are environment-
# specific, so they must come from $ENV_FILE — not the staging build.
# deploy-azure.sh has a --settings mode that does exactly this against
# the env it's pointed at; we delegate to it instead of duplicating.
echo "Applying app settings via deploy-azure.sh --settings..."
ENV_FILE="$ENV_FILE" bash "$SCRIPT_DIR/deploy-azure.sh" --settings

# ── Deploy each zip + smoke ─────────────────────────────────────
deploy_zip() {
    local APP_NAME="$1" ZIP="$2" SMOKE_URL="$3"
    echo "Deploying $ZIP → $APP_NAME"
    local try
    for try in 1 2 3; do
        if az webapp deploy \
                --resource-group "$RESOURCE_GROUP" \
                --name "$APP_NAME" \
                --type zip \
                --clean true \
                --src-path "$ZIP"; then
            break
        fi
        echo "  attempt $try/3 failed; sleeping 30s"
        sleep 30
        if [[ "$try" == 3 ]]; then
            echo "ERROR: deploy to $APP_NAME failed after 3 attempts" >&2
            exit 1
        fi
    done
    # Smoke
    local i HTTP
    for i in $(seq 1 18); do
        HTTP="$(curl -ks -o /dev/null -w '%{http_code}' --max-time 10 "$SMOKE_URL" || echo 000)"
        if [[ "$HTTP" =~ ^[23] ]]; then
            echo "  smoke OK (HTTP $HTTP after ${i}*5s) — $SMOKE_URL"
            return 0
        fi
        sleep 5
    done
    echo "  WARNING: smoke failed (last HTTP=$HTTP) — check az webapp log tail --name $APP_NAME" >&2
}

deploy_zip "$VIEWER_APP_NAME" "$SCRATCH/viewer.zip" "$VIEWER_URL/"
deploy_zip "$RELAY_APP_NAME"  "$SCRATCH/relay.zip"  "${RELAY_URL/wss:/https:}/healthz"
# Editor deployment removed iter 246: editor moved off App Service to
# Front Door + Storage static-website. The shared FD endpoint is
# updated by editor-build.yml on editor-side changes; per-tier editor
# pinning is done by flipping the viewer's EDITOR_DEPLOY_ID app setting
# (wasm/promote-editor.sh).

cat <<DONE

==========================================
Promote complete.

  app_build_id : $APP_BID  (linked against LO $LO_BID, git $GIT_SHA)
  target env   : $ENV_FILE

  Viewer : $VIEWER_URL
  Editor : $EDITOR_URL
  Relay  : $RELAY_URL
==========================================
DONE
