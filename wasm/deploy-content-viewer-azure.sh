#!/usr/bin/env bash
# deploy-content-viewer-azure.sh — deploy the Tresorit content-preview SPA
# (its built dist/) to the viewer App Service, served by content-viewer-server.js,
# in place of the legacy viewer. The WASM editor is served separately by the
# Front Door and proxied into the SPA by content-preview's service worker, so
# this App Service is pure static hosting (no v2 storage / relay).
#
# Env (from $ENV_FILE, e.g. ~/ENV/online-test-deploy.env):
#   RESOURCE_GROUP, VIEWER_APP_NAME, VIEWER_URL
# Extra:
#   CONTENT_VIEWER_DIST_SRC  built content-preview dist/ (default ~/content-preview/dist)
#
# Usage:
#   ENV_FILE=~/ENV/online-test-deploy.env bash wasm/deploy-content-viewer-azure.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$HOME/ENV/online-test-deploy.env}"
if [[ -f "$ENV_FILE" ]]; then set -a; source "$ENV_FILE"; set +a; fi

# Content-viewer provenance helpers + the repo-pinned content-preview commit
# (wasm/CONTENT_VIEWER_COMMIT.txt). We deploy whatever dist/ was built, but
# warn loudly (or fail with STRICT_CV_PIN=1) when the checkout being deployed
# doesn't match the pin, so the deployed /version.json can't silently drift
# from what this online tree expects.
source "$SCRIPT_DIR/lib/cv-provenance.sh"
CP_PINNED="$(cv_pinned_commit)"

for v in RESOURCE_GROUP VIEWER_APP_NAME VIEWER_URL; do
    [[ -n "${!v:-}" ]] || { echo "ERROR: $v unset (set in $ENV_FILE)"; exit 1; }
done
CONTENT_VIEWER_DIST_SRC="${CONTENT_VIEWER_DIST_SRC:-$HOME/content-preview/dist}"
[[ -f "$CONTENT_VIEWER_DIST_SRC/index.html" ]] || {
    echo "ERROR: no index.html at $CONTENT_VIEWER_DIST_SRC — build content-preview first"; exit 1; }

VDIR=/tmp/content-viewer-deploy-azure
echo "=== Staging content-viewer ($VDIR) ==="
rm -rf "$VDIR"; mkdir -p "$VDIR/dist"
cp "$SCRIPT_DIR/content-viewer-server.js" "$VDIR/server.js"
cp -r "$CONTENT_VIEWER_DIST_SRC/." "$VDIR/dist/"

# version.json — deploy provenance served at /version.json. The CV test-run
# table reads it to attribute results to exact content-preview + editor
# builds. cp commit comes from the dist's source repo (the dir above dist/);
# the pinned editor version is recovered from the baked bundle (the
# collabora-<UTC-ts>/ asset prefix is embedded verbatim at build time).
CP_REPO_DIR="$(dirname "$CONTENT_VIEWER_DIST_SRC")"
CP_SHA="$(git -C "$CP_REPO_DIR" rev-parse HEAD 2>/dev/null || echo '')"
CP_BRANCH="$(git -C "$CP_REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"

# Enforce the pin: the checkout we're about to deploy must match
# wasm/CONTENT_VIEWER_COMMIT.txt. Mismatch is a warning by default (the pin may
# legitimately be moving in the same change) and hard-fails under STRICT_CV_PIN=1.
if [[ -n "$CP_PINNED" && -n "$CP_SHA" && "$CP_PINNED" != "$CP_SHA" ]]; then
    echo "  WARNING: content-preview checkout ($CP_SHA) != pinned commit ($CP_PINNED)" >&2
    echo "           pin: wasm/CONTENT_VIEWER_COMMIT.txt" >&2
    echo "           to match:  git -C $CP_REPO_DIR checkout $CP_PINNED  (then rebuild dist)" >&2
    if [[ "${STRICT_CV_PIN:-0}" == "1" ]]; then
        echo "  ERROR: STRICT_CV_PIN=1 and checkout != pin — refusing to deploy." >&2
        exit 1
    fi
elif [[ -z "$CP_PINNED" ]]; then
    echo "  NOTE: no wasm/CONTENT_VIEWER_COMMIT.txt pin found (recording deployed HEAD only)"
fi

COLLAB_VER="$(grep -rhoE 'collabora-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z' \
    "$VDIR/dist/assets/"*.js 2>/dev/null | head -1 | sed 's/^collabora-//')"
cat > "$VDIR/dist/version.json" <<EOF
{
  "cp_commit": "$CP_SHA",
  "cp_commit_pinned": "$CP_PINNED",
  "cp_branch": "$CP_BRANCH",
  "collabora_version": "$COLLAB_VER",
  "deployed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
echo "  version.json: cp=$CP_SHA ($CP_BRANCH) pinned=${CP_PINNED:-none} collabora=$COLLAB_VER"
cat > "$VDIR/package.json" <<'JSON'
{
  "name": "cool-content-viewer",
  "version": "1.0.0",
  "private": true,
  "scripts": { "start": "node server.js" },
  "dependencies": { "express": "^5.2.1" }
}
JSON
echo "  Installing npm dependencies..."
(cd "$VDIR" && npm install --production --silent)

echo "=== App settings (dist path served by content-viewer-server.js) ==="
# CONTENT_VIEWER_DIST → the deployed dist/. Clear SSL_* so the server listens
# plain HTTP on Azure's $PORT (Azure terminates TLS at the platform).
az webapp config appsettings set \
    --resource-group "$RESOURCE_GROUP" --name "$VIEWER_APP_NAME" \
    --settings CONTENT_VIEWER_DIST=/home/site/wwwroot/dist SSL_CERT= SSL_KEY= \
               SCM_DO_BUILD_DURING_DEPLOYMENT=false WEBSITE_NODE_DEFAULT_VERSION="~20" \
    --output none
# Ensure npm start is the entrypoint (Oryx default; set explicitly to be safe).
az webapp config set \
    --resource-group "$RESOURCE_GROUP" --name "$VIEWER_APP_NAME" \
    --startup-file "npm start" --output none

echo "=== Zip + deploy to $VIEWER_APP_NAME ==="
ZIP="$VDIR.zip"; rm -f "$ZIP"; (cd "$VDIR" && zip -qr "$ZIP" .)
OK=0
for try in 1 2 3; do
    if az webapp deploy --resource-group "$RESOURCE_GROUP" --name "$VIEWER_APP_NAME" \
            --type zip --clean true --src-path "$ZIP"; then OK=1; break; fi
    echo "  deploy failed (attempt $try/3); waiting 30s"; sleep 30
done
[[ "$OK" == 1 ]] || { echo "ERROR: az webapp deploy failed 3×"; exit 1; }

echo "=== Smoke test ==="
URL="$VIEWER_URL/collabora-tester"
for i in $(seq 1 18); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$URL" || echo 000)
    hdr=$(curl -s -D - -o /dev/null --max-time 10 "$VIEWER_URL/" | grep -i "cross-origin-embedder" || true)
    if [[ "$code" == "200" ]]; then
        echo "  OK $URL → $code   [$hdr]"
        echo
        echo "  content-viewer live: $URL"
        exit 0
    fi
    echo "  waiting for app ($code)…"; sleep 5
done
echo "ERROR: smoke test never returned 200 for $URL"; exit 1
