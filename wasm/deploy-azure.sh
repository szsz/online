#!/bin/bash
# Deploy COOL WASM P2P co-editing to Azure.
# Usage: bash wasm/deploy-azure.sh [build|deploy|cdn|static|relay|all]
#   build   - rebuild WASM binary in Docker container
#   deploy  - copy artifacts from container to local deploy dirs
#   cdn     - upload large assets to Azure CDN ($web container)
#   static  - package and deploy the static file server
#   relay   - package and deploy the relay WebSocket server
#   all     - do all of the above (default)
#
# Requires: az CLI (logged in), docker, zip, node

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Load config ───────────────────────────────────────────────────
DEPLOY_CONFIG="$SCRIPT_DIR/.deploy"
if [ ! -f "$DEPLOY_CONFIG" ]; then
    echo "ERROR: $DEPLOY_CONFIG not found."
    echo "Copy .deploy.example to .deploy and fill in your values."
    exit 1
fi
# shellcheck disable=SC1090
source "$DEPLOY_CONFIG"

# Validate required variables
for var in DOCKER_CONTAINER RESOURCE_GROUP STATIC_APP_NAME RELAY_APP_NAME \
           CDN_STORAGE_ACCOUNT CDN_CONTAINER DEPLOY_CONTAINER \
           DOC_STORAGE_ACCOUNT_NAME DOC_STORAGE_ACCOUNT_KEY DOC_STORAGE_CONTAINER \
           CDN_URL RELAY_URL STATIC_DEPLOY_DIR RELAY_DEPLOY_DIR SAS_EXPIRY; do
    if [ -z "${!var}" ]; then
        echo "ERROR: $var is not set in .deploy"
        exit 1
    fi
done

cd "$REPO_DIR"

# ── Helpers ───────────────────────────────────────────────────────
step_header() { echo ""; echo "=== $1 ==="; }
check_docker() {
    if ! docker ps >/dev/null 2>&1; then
        echo "ERROR: Docker is not running. Start Docker Desktop and try again."
        exit 1
    fi
    if ! docker ps --format '{{.Names}}' | grep -q "^${DOCKER_CONTAINER}$"; then
        echo "ERROR: Container '$DOCKER_CONTAINER' is not running."
        echo "  Start it with: docker start $DOCKER_CONTAINER"
        exit 1
    fi
}

# ── Step: Build ───────────────────────────────────────────────────
step_build() {
    step_header "Build: syncing source files to container"
    check_docker

    for f in $BUILD_SYNC_FILES; do
        if [ -f "$f" ]; then
            docker cp "$f" "$DOCKER_CONTAINER:/lo/online/$f"
            echo "  Synced $f"
        fi
    done

    step_header "Build: compiling WASM binary in container"
    docker exec "$DOCKER_CONTAINER" bash -c '
        source /home/builder/emsdk/emsdk_env.sh 2>/dev/null
        cd /lo/online/wasm
        make -j$(nproc) 2>&1
    '
    echo "  Build complete"
}

# ── Step: Deploy (copy artifacts to local dirs) ───────────────────
step_deploy() {
    step_header "Deploy: setting up static-deploy directory"
    check_docker
    mkdir -p "$STATIC_DEPLOY_DIR/public"

    # Copy static server.js from wasm/ if not present
    if [ -f "wasm/serve.js" ] && [ ! -f "$STATIC_DEPLOY_DIR/server.js" ]; then
        cp "wasm/serve.js" "$STATIC_DEPLOY_DIR/server.js"
        echo "  Copied serve.js → static-deploy/server.js"
    fi

    # Create package.json for static server if missing
    if [ ! -f "$STATIC_DEPLOY_DIR/package.json" ]; then
        cat > "$STATIC_DEPLOY_DIR/package.json" <<'PKGEOF'
{
  "name": "cool-wasm-static",
  "version": "1.0.0",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "@azure/storage-blob": "^12.31.0",
    "dotenv": "^17.3.1"
  }
}
PKGEOF
        echo "  Generated package.json for static server"
    fi

    # Install static server dependencies if needed
    if [ ! -d "$STATIC_DEPLOY_DIR/node_modules" ]; then
        echo "  Installing static server npm dependencies..."
        (cd "$STATIC_DEPLOY_DIR" && npm install --production 2>&1)
    fi

    step_header "Deploy: copying WASM artifacts from container"
    for f in $WASM_ARTIFACTS; do
        docker cp "$DOCKER_CONTAINER:/lo/online/wasm/$f" "$STATIC_DEPLOY_DIR/public/$f"
        echo "  Copied $f → static-deploy/public/"
    done

    step_header "Deploy: copying COOL frontend from container"
    # Copy the full browser/dist (COOL JS UI) from container to public/
    # This includes cool.html, bundle.js, global.js, CSS, images, etc.
    docker cp "$DOCKER_CONTAINER:/lo/online/browser/dist/." "$STATIC_DEPLOY_DIR/public/"
    echo "  Copied browser/dist/ → static-deploy/public/"

    step_header "Deploy: copying relay JS/HTML files"
    for f in $RELAY_JS_FILES; do
        if [ -f "wasm/$f" ]; then
            cp "wasm/$f" "$STATIC_DEPLOY_DIR/public/$f"
            echo "  Copied $f → static-deploy/public/"
        fi
    done
    for f in $RELAY_HTML_FILES; do
        if [ -f "wasm/$f" ]; then
            cp "wasm/$f" "$STATIC_DEPLOY_DIR/public/$f"
            echo "  Copied $f → static-deploy/public/"
        fi
    done

    # Copy wasm.html to public/ (entry point UI)
    if [ -f "wasm/wasm.html" ]; then
        cp "wasm/wasm.html" "$STATIC_DEPLOY_DIR/public/wasm.html"
        echo "  Copied wasm.html → static-deploy/public/"
    fi

    # Set up relay-deploy directory
    mkdir -p "$RELAY_DEPLOY_DIR"
    if [ -f "wasm/relay-server.js" ]; then
        cp "wasm/relay-server.js" "$RELAY_DEPLOY_DIR/server.js"
        # Ensure relay listens on Azure's PORT
        if ! grep -q 'process.env.PORT' "$RELAY_DEPLOY_DIR/server.js"; then
            sed -i "s/process.env.RELAY_PORT || 9090/process.env.PORT || process.env.RELAY_PORT || 9090/" "$RELAY_DEPLOY_DIR/server.js"
        fi
        echo "  Copied relay-server.js → relay-deploy/server.js"
    fi

    # Create package.json for relay if missing
    if [ ! -f "$RELAY_DEPLOY_DIR/package.json" ]; then
        cat > "$RELAY_DEPLOY_DIR/package.json" <<'PKGEOF'
{
  "name": "cool-wasm-relay",
  "version": "1.0.0",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "ws": "^8.19.0"
  }
}
PKGEOF
        echo "  Generated package.json for relay"
    fi

    # Install relay dependencies if needed
    if [ ! -d "$RELAY_DEPLOY_DIR/node_modules" ]; then
        echo "  Installing relay npm dependencies..."
        (cd "$RELAY_DEPLOY_DIR" && npm install --production 2>&1)
    fi

    # Generate .env for static server
    cat > "$STATIC_DEPLOY_DIR/.env" <<ENVEOF
AZURE_STORAGE_ACCOUNT_NAME=$DOC_STORAGE_ACCOUNT_NAME
AZURE_STORAGE_ACCOUNT_KEY=$DOC_STORAGE_ACCOUNT_KEY
AZURE_STORAGE_CONTAINER=$DOC_STORAGE_CONTAINER
ENVEOF
    echo "  Generated .env"
}

# ── Step: CDN (upload large files) ────────────────────────────────
step_cdn() {
    step_header "CDN: uploading large assets to $CDN_STORAGE_ACCOUNT/$CDN_CONTAINER"

    for f in $CDN_FILES; do
        local filepath="$STATIC_DEPLOY_DIR/public/$f"
        if [ ! -f "$filepath" ]; then
            echo "  SKIP $f (not found)"
            continue
        fi

        # Determine content type
        local ct="application/octet-stream"
        case "$f" in
            *.wasm) ct="application/wasm" ;;
            *.js)   ct="application/javascript" ;;
            *.data) ct="application/octet-stream" ;;
        esac

        local size
        size=$(stat -c%s "$filepath" 2>/dev/null || stat -f%z "$filepath" 2>/dev/null || echo "?")
        echo "  Uploading $f ($size bytes, $ct)..."
        az storage blob upload \
            --container-name "$CDN_CONTAINER" \
            --account-name "$CDN_STORAGE_ACCOUNT" \
            --file "$filepath" \
            --name "$f" \
            --content-type "$ct" \
            --overwrite \
            --output none 2>&1
        echo "  ✓ $f uploaded"
    done
}

# ── Step: Static (package and deploy) ─────────────────────────────
step_static() {
    step_header "Static: creating deploy zip"

    # Build exclude list for large CDN files
    local excludes=()
    for f in $CDN_FILES; do
        excludes+=("-x" "public/$f")
    done

    cd "$STATIC_DEPLOY_DIR"

    # Ensure node_modules exist
    if [ ! -d "node_modules" ]; then
        echo "  Installing npm dependencies..."
        npm install --production 2>&1
    fi

    rm -f deploy.zip
    zip -r deploy.zip \
        server.js package.json package-lock.json .env \
        node_modules/ public/ \
        "${excludes[@]}" \
        >/dev/null 2>&1
    local zip_size
    zip_size=$(stat -c%s deploy.zip 2>/dev/null || stat -f%z deploy.zip 2>/dev/null || echo "?")
    echo "  Created deploy.zip ($zip_size bytes)"

    # Pick a version tag
    local version
    version="v$(date +%Y%m%d-%H%M%S)"

    step_header "Static: uploading deploy zip ($version)"
    local blob_name="static-deploy-${version}.zip"
    az storage blob upload \
        --container-name "$DEPLOY_CONTAINER" \
        --account-name "$CDN_STORAGE_ACCOUNT" \
        --file deploy.zip \
        --name "$blob_name" \
        --content-type "application/zip" \
        --overwrite \
        --output none 2>&1
    echo "  ✓ Uploaded $blob_name"

    step_header "Static: generating SAS URL"
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

    step_header "Static: updating app settings"
    az webapp config appsettings set \
        --name "$STATIC_APP_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --settings \
            "WEBSITE_RUN_FROM_PACKAGE=$sas_url" \
            "RELAY_URL=$RELAY_URL" \
            "CDN_URL=$CDN_URL" \
            "CDN_VERSION=$version" \
            "SCM_DO_BUILD_DURING_DEPLOYMENT=false" \
            "AZURE_STORAGE_ACCOUNT_NAME=$DOC_STORAGE_ACCOUNT_NAME" \
            "AZURE_STORAGE_ACCOUNT_KEY=$DOC_STORAGE_ACCOUNT_KEY" \
            "AZURE_STORAGE_CONTAINER=$DOC_STORAGE_CONTAINER" \
        --output none 2>&1
    echo "  ✓ App settings updated (CDN_VERSION=$version)"

    step_header "Static: restarting app"
    az webapp restart \
        --name "$STATIC_APP_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --output none 2>&1
    echo "  ✓ $STATIC_APP_NAME restarted"

    cd "$REPO_DIR"
}

# ── Step: Relay (package and deploy) ──────────────────────────────
step_relay() {
    step_header "Relay: creating deploy zip"

    cd "$RELAY_DEPLOY_DIR"

    # Ensure node_modules exist
    if [ ! -d "node_modules" ]; then
        echo "  Installing npm dependencies..."
        npm install --production 2>&1
    fi

    rm -f relay-deploy.zip
    zip -r relay-deploy.zip \
        server.js package.json package-lock.json \
        node_modules/ \
        >/dev/null 2>&1
    local zip_size
    zip_size=$(stat -c%s relay-deploy.zip 2>/dev/null || stat -f%z relay-deploy.zip 2>/dev/null || echo "?")
    echo "  Created relay-deploy.zip ($zip_size bytes)"

    step_header "Relay: deploying to Azure"
    az webapp deploy \
        --name "$RELAY_APP_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --src-path relay-deploy.zip \
        --type zip \
        --output none 2>&1
    echo "  ✓ $RELAY_APP_NAME deployed"

    cd "$REPO_DIR"
}

# ── Main ──────────────────────────────────────────────────────────
CMD="${1:-all}"

case "$CMD" in
    build)   step_build ;;
    deploy)  step_deploy ;;
    cdn)     step_cdn ;;
    static)  step_static ;;
    relay)   step_relay ;;
    all)
        step_build
        step_deploy
        step_cdn
        step_static
        step_relay
        echo ""
        echo "============================================"
        echo "  All steps complete!"
        echo "============================================"
        echo ""
        echo "  Static: https://$STATIC_APP_NAME.azurewebsites.net/wasm.html"
        echo "  Relay:  $RELAY_URL"
        echo "  CDN:    $CDN_URL"
        echo "============================================"
        ;;
    *)
        echo "Usage: $0 [build|deploy|cdn|static|relay|all]"
        echo ""
        echo "  build   - rebuild WASM binary in Docker container"
        echo "  deploy  - copy artifacts from container to local deploy dirs"
        echo "  cdn     - upload large assets (online.wasm, soffice.data) to CDN"
        echo "  static  - package and deploy the static file server to Azure"
        echo "  relay   - package and deploy the relay WebSocket server to Azure"
        echo "  all     - do all of the above (default)"
        exit 1
        ;;
esac
