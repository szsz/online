#!/bin/bash
# Deploy the COOL WASM document viewer to Azure.
# Usage: bash wasm/deploy-viewer.sh [cdn|deploy|all]
#   cdn    - upload large assets (online.wasm, soffice.data + .br) to CDN
#   deploy - package and deploy the viewer server to Azure
#   all    - do both (default)
#
# Requires: az CLI (logged in), brotli, zip

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Load config ───────────────────────────────────────────────────
DEPLOY_CONFIG="$SCRIPT_DIR/.deploy"
if [ ! -f "$DEPLOY_CONFIG" ]; then
    echo "ERROR: $DEPLOY_CONFIG not found."
    exit 1
fi
source "$DEPLOY_CONFIG"

for var in RESOURCE_GROUP VIEWER_APP_NAME CDN_STORAGE_ACCOUNT CDN_CONTAINER \
           DEPLOY_CONTAINER DOC_STORAGE_ACCOUNT_NAME DOC_STORAGE_ACCOUNT_KEY \
           DOC_STORAGE_CONTAINER CDN_URL STATIC_DEPLOY_DIR SAS_EXPIRY; do
    if [ -z "${!var}" ]; then
        echo "ERROR: $var is not set in .deploy"
        exit 1
    fi
done

PUBLIC_DIR="$STATIC_DEPLOY_DIR/public"
cd "$REPO_DIR"

step_header() { echo ""; echo "=== $1 ==="; }

# ── CDN: upload large assets + brotli versions ────────────────────
step_cdn() {
    step_header "CDN: compressing and uploading large assets"

    local files="online.wasm soffice.data soffice.data.js.metadata"

    for f in $files; do
        local filepath="$PUBLIC_DIR/$f"
        if [ ! -f "$filepath" ]; then
            echo "  SKIP $f (not found)"
            continue
        fi

        # Determine content type
        local ct="application/octet-stream"
        case "$f" in
            *.wasm) ct="application/wasm" ;;
            *.js*)  ct="application/javascript" ;;
        esac

        # Upload original
        local size=$(wc -c < "$filepath" | tr -d ' ')
        echo "  Uploading $f ($size bytes)..."
        az storage blob upload \
            --container-name "$CDN_CONTAINER" \
            --account-name "$CDN_STORAGE_ACCOUNT" \
            --file "$filepath" \
            --name "$f" \
            --content-type "$ct" \
            --overwrite --output none 2>&1
        echo "  ✓ $f"

        # Compress with brotli and upload .br version
        local brpath="${filepath}.br"
        if [ ! -f "$brpath" ] || [ "$filepath" -nt "$brpath" ]; then
            echo "  Compressing $f with brotli..."
            brotli -c -q 11 "$filepath" > "$brpath"
        fi
        local brsize=$(wc -c < "$brpath" | tr -d ' ')
        echo "  Uploading ${f}.br ($brsize bytes)..."
        az storage blob upload \
            --container-name "$CDN_CONTAINER" \
            --account-name "$CDN_STORAGE_ACCOUNT" \
            --file "$brpath" \
            --name "${f}.br" \
            --content-type "$ct" \
            --content-encoding "br" \
            --overwrite --output none 2>&1
        echo "  ✓ ${f}.br"
    done
}

# ── Deploy: package and deploy viewer server ──────────────────────
step_deploy() {
    step_header "Viewer: compressing JS/CSS assets"

    # Ensure .br files exist for large JS/CSS
    for f in bundle.js l10n-all.js online.js bundle.css; do
        local filepath="$PUBLIC_DIR/$f"
        local brpath="${filepath}.br"
        if [ -f "$filepath" ] && { [ ! -f "$brpath" ] || [ "$filepath" -nt "$brpath" ]; }; then
            echo "  Compressing $f..."
            brotli -c -q 11 "$filepath" > "$brpath"
        fi
    done

    step_header "Viewer: creating deploy zip"

    cd "$STATIC_DEPLOY_DIR"

    # Ensure node_modules
    if [ ! -d "node_modules" ]; then
        echo "  Installing npm dependencies..."
        npm install --production 2>&1
    fi

    # Exclude large CDN files (served from CDN, not from the app)
    local excludes=()
    for f in online.wasm soffice.data soffice.data.js.metadata; do
        excludes+=("-x" "public/$f")
    done

    rm -f viewer-deploy.zip
    zip -r viewer-deploy.zip \
        server.js package.json package-lock.json .env \
        node_modules/ public/ \
        "${excludes[@]}" \
        >/dev/null 2>&1

    local zip_size=$(wc -c < viewer-deploy.zip | tr -d ' ')
    echo "  Created viewer-deploy.zip ($zip_size bytes)"

    local version="v$(date +%Y%m%d-%H%M%S)"

    step_header "Viewer: uploading deploy zip ($version)"
    local blob_name="viewer-deploy-${version}.zip"
    az storage blob upload \
        --container-name "$DEPLOY_CONTAINER" \
        --account-name "$CDN_STORAGE_ACCOUNT" \
        --file viewer-deploy.zip \
        --name "$blob_name" \
        --content-type "application/zip" \
        --overwrite --output none 2>&1
    echo "  ✓ Uploaded $blob_name"

    step_header "Viewer: generating SAS URL"
    local sas_url
    sas_url=$(az storage blob generate-sas \
        --container-name "$DEPLOY_CONTAINER" \
        --account-name "$CDN_STORAGE_ACCOUNT" \
        --name "$blob_name" \
        --permissions r \
        --expiry "$SAS_EXPIRY" \
        --full-uri \
        --output tsv 2>/dev/null)
    echo "  SAS URL: ${sas_url:0:80}..."

    step_header "Viewer: updating app settings"
    az webapp config appsettings set \
        --name "$VIEWER_APP_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --settings \
            "WEBSITE_RUN_FROM_PACKAGE=$sas_url" \
            "CDN_URL=$CDN_URL" \
            "CDN_VERSION=$version" \
            "SCM_DO_BUILD_DURING_DEPLOYMENT=false" \
            "AZURE_STORAGE_ACCOUNT_NAME=$DOC_STORAGE_ACCOUNT_NAME" \
            "AZURE_STORAGE_ACCOUNT_KEY=$DOC_STORAGE_ACCOUNT_KEY" \
            "AZURE_STORAGE_CONTAINER=$DOC_STORAGE_CONTAINER" \
        --output none 2>&1
    echo "  ✓ App settings updated (CDN_VERSION=$version)"

    step_header "Viewer: restarting app"
    az webapp restart \
        --name "$VIEWER_APP_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --output none 2>&1
    echo "  ✓ $VIEWER_APP_NAME restarted"

    cd "$REPO_DIR"
}

# ── Main ──────────────────────────────────────────────────────────
CMD="${1:-all}"

case "$CMD" in
    cdn)    step_cdn ;;
    deploy) step_deploy ;;
    all)
        step_cdn
        step_deploy
        echo ""
        echo "============================================"
        echo "  Viewer deployed!"
        echo "  https://$VIEWER_APP_NAME.azurewebsites.net/viewer.html"
        echo "  CDN: $CDN_URL"
        echo "============================================"
        ;;
    *)
        echo "Usage: $0 [cdn|deploy|all]"
        exit 1
        ;;
esac
