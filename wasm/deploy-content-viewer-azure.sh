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
