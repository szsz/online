#!/usr/bin/env bash
# deploy-azure.sh — Deploy COOL WASM co-editing to Azure App Services.
#
# Usage:
#   bash wasm/deploy-azure.sh                  # deploy all three services
#   bash wasm/deploy-azure.sh --create         # first time: create App Services
#   bash wasm/deploy-azure.sh --viewer         # deploy viewer only
#   bash wasm/deploy-azure.sh --relay          # deploy relay only
#   bash wasm/deploy-azure.sh --editor         # deploy editor only
#   bash wasm/deploy-azure.sh --settings       # update app settings only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Load config ──────────────────────────────────────────────────
ENV_FILE="${SCRIPT_DIR}/.env.deploy"
if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: $ENV_FILE not found. Copy .env.deploy and fill in secrets."
    exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

# Validate required vars
for var in RESOURCE_GROUP APP_SERVICE_PLAN VIEWER_APP_NAME RELAY_APP_NAME EDITOR_APP_NAME \
           VIEWER_URL RELAY_URL EDITOR_URL DOC_STORAGE_ACCOUNT DOC_STORAGE_KEY DOC_STORAGE_CONTAINER; do
    if [[ -z "${!var:-}" ]]; then
        echo "ERROR: $var is not set in $ENV_FILE"
        exit 1
    fi
done

# ── Parse flags ──────────────────────────────────────────────────
DO_CREATE=false
DO_VIEWER=false
DO_RELAY=false
DO_EDITOR=false
DO_SETTINGS=false
DO_ALL=true

for arg in "$@"; do
    case "$arg" in
        --create)   DO_CREATE=true ;;
        --viewer)   DO_VIEWER=true; DO_ALL=false ;;
        --relay)    DO_RELAY=true; DO_ALL=false ;;
        --editor)   DO_EDITOR=true; DO_ALL=false ;;
        --settings) DO_SETTINGS=true; DO_ALL=false ;;
        *) echo "Unknown flag: $arg"; exit 1 ;;
    esac
done

if $DO_ALL; then
    DO_VIEWER=true
    DO_RELAY=true
    DO_EDITOR=true
fi

# ── Create App Services ─────────────────────────────────────────
if $DO_CREATE; then
    echo "=== Creating App Services ==="

    # Refuse Free/Shared tier — WASM serving needs at least Basic.
    PLAN_SKU="$(az appservice plan show --name "$APP_SERVICE_PLAN" \
        --resource-group "$RESOURCE_GROUP" --query 'sku.tier' -o tsv 2>/dev/null || true)"
    case "$PLAN_SKU" in
        ""|Free|Shared)
            echo "ERROR: App Service Plan '$APP_SERVICE_PLAN' is on tier '$PLAN_SKU'."
            echo "       Free/Shared tiers cannot serve WASM at acceptable speed."
            echo "       Use Basic (B1) or higher."
            exit 1 ;;
        *) echo "  Plan tier OK: $PLAN_SKU" ;;
    esac

    for APP in "$VIEWER_APP_NAME" "$RELAY_APP_NAME" "$EDITOR_APP_NAME"; do
        echo "  Creating $APP..."
        # Capture stderr so we can distinguish "already exists" (benign) from
        # real errors (quota exceeded, name taken, auth, etc.).
        ERR_FILE="$(mktemp)"
        if az webapp create \
                --resource-group "$RESOURCE_GROUP" \
                --plan "$APP_SERVICE_PLAN" \
                --name "$APP" \
                --runtime "NODE:20-lts" \
                2>"$ERR_FILE" >/dev/null; then
            echo "    created"
        elif grep -qiE "already (exists|in use)|WebsiteAlreadyExists" "$ERR_FILE"; then
            echo "    already exists (skipping)"
        else
            echo "ERROR: az webapp create failed for $APP:"
            sed 's/^/      /' "$ERR_FILE"
            rm -f "$ERR_FILE"
            exit 1
        fi
        rm -f "$ERR_FILE"
    done

    # Enable WebSockets on relay
    echo "  Enabling WebSockets on $RELAY_APP_NAME..."
    az webapp config set \
        --resource-group "$RESOURCE_GROUP" \
        --name "$RELAY_APP_NAME" \
        --web-sockets-enabled true >/dev/null

    echo ""
fi

# ── Configure App Settings ───────────────────────────────────────
configure_settings() {
    echo "=== Configuring App Settings ==="

    # Viewer settings — uses Azure Blob storage backend in App Services.
    # The viewer-server.js defaults to STORAGE_BACKEND=local for dev; we
    # explicitly set it to azure here so the deployed instance reads/writes
    # blobs instead of the (empty) container's local filesystem.
    echo "  Viewer ($VIEWER_APP_NAME)..."
    az webapp config appsettings set \
        --resource-group "$RESOURCE_GROUP" \
        --name "$VIEWER_APP_NAME" \
        --settings \
            STORAGE_BACKEND="azure" \
            FILE_STORAGE_URL="$VIEWER_URL" \
            EDITOR_URL="$EDITOR_URL" \
            RELAY_URL="$RELAY_URL" \
            DOC_STORAGE_ACCOUNT="$DOC_STORAGE_ACCOUNT" \
            DOC_STORAGE_KEY="$DOC_STORAGE_KEY" \
            DOC_STORAGE_CONTAINER="$DOC_STORAGE_CONTAINER" \
            WEBSITE_NODE_DEFAULT_VERSION="~20" \
        > /dev/null

    # Relay settings
    echo "  Relay ($RELAY_APP_NAME)..."
    az webapp config appsettings set \
        --resource-group "$RESOURCE_GROUP" \
        --name "$RELAY_APP_NAME" \
        --settings \
            FILE_STORAGE_URL="$VIEWER_URL" \
            WEBSITE_NODE_DEFAULT_VERSION="~20" \
        > /dev/null

    # Enable WebSockets on relay
    az webapp config set \
        --resource-group "$RESOURCE_GROUP" \
        --name "$RELAY_APP_NAME" \
        --web-sockets-enabled true \
        > /dev/null

    # Editor settings
    echo "  Editor ($EDITOR_APP_NAME)..."
    az webapp config appsettings set \
        --resource-group "$RESOURCE_GROUP" \
        --name "$EDITOR_APP_NAME" \
        --settings \
            FILE_STORAGE_URL="$VIEWER_URL" \
            RELAY_URL="$RELAY_URL" \
            WEBSITE_NODE_DEFAULT_VERSION="~20" \
        > /dev/null

    echo ""
}

if $DO_SETTINGS; then
    configure_settings
    echo "Done (settings only)."
    exit 0
fi

# Always configure settings before deploying
configure_settings

# ── Helper: stage, zip, deploy, smoke-test ──────────────────────
deploy_app() {
    local APP_NAME=$1
    local DEPLOY_DIR=$2
    local SMOKE_PATH=${3:-/}            # path to GET for smoke test (default: /)
    local SMOKE_CONTAINS=${4:-}         # optional body substring to require
    local ZIP_PATH="${DEPLOY_DIR}.zip"

    echo "  Zipping $DEPLOY_DIR..."
    rm -f "$ZIP_PATH"
    (cd "$DEPLOY_DIR" && zip -qr "$ZIP_PATH" .)

    echo "  Deploying to $APP_NAME..."
    az webapp deploy \
        --resource-group "$RESOURCE_GROUP" \
        --name "$APP_NAME" \
        --type zip \
        --src-path "$ZIP_PATH"

    # Smoke test: poll the app for up to 90s waiting for a 2xx/3xx response,
    # and (if SMOKE_CONTAINS is set) requiring the body to contain the
    # given substring. The body check catches "served the wrong page" bugs
    # — e.g. if the bundle accidentally serves editor.html at / instead of
    # the sidebar viewer.
    local URL="https://${APP_NAME}.azurewebsites.net${SMOKE_PATH}"
    if [[ -n "$SMOKE_CONTAINS" ]]; then
        echo "  Smoke test: GET $URL  (must contain '$SMOKE_CONTAINS')"
    else
        echo "  Smoke test: GET $URL"
    fi
    local i HTTP BODY
    for i in $(seq 1 18); do
        BODY_FILE="$(mktemp)"
        HTTP="$(curl -ks -o "$BODY_FILE" -w '%{http_code}' --max-time 10 "$URL" || echo 000)"
        if [[ "$HTTP" =~ ^[23] ]]; then
            if [[ -z "$SMOKE_CONTAINS" ]] || grep -q -- "$SMOKE_CONTAINS" "$BODY_FILE"; then
                rm -f "$BODY_FILE"
                echo "    OK (HTTP $HTTP after ${i}*5s)"
                echo "  Done: https://${APP_NAME}.azurewebsites.net"
                echo ""
                return 0
            fi
            echo "    HTTP $HTTP but body missing '$SMOKE_CONTAINS' — wrong page served?"
        fi
        rm -f "$BODY_FILE"
        sleep 5
    done
    echo "  WARNING: smoke test failed (last HTTP=$HTTP). Check logs:"
    echo "    az webapp log tail --resource-group $RESOURCE_GROUP --name $APP_NAME"
    echo ""
    return 1
}

# ── Deploy Viewer ────────────────────────────────────────────────
if $DO_VIEWER; then
    echo "=== Staging Viewer ==="
    VDIR="${VIEWER_DEPLOY_DIR}"
    rm -rf "$VDIR"
    mkdir -p "$VDIR"

    # Server + package.json
    cp "$SCRIPT_DIR/viewer-server.js" "$VDIR/server.js"

    # Storage backend abstraction (lib/storage/{index,local,azure}.js).
    # Keep the directory layout so `require('./lib/storage')` resolves.
    mkdir -p "$VDIR/lib/storage"
    cp "$SCRIPT_DIR/lib/storage/index.js" "$VDIR/lib/storage/"
    cp "$SCRIPT_DIR/lib/storage/local.js" "$VDIR/lib/storage/"
    cp "$SCRIPT_DIR/lib/storage/azure.js" "$VDIR/lib/storage/"

    cat > "$VDIR/package.json" <<'VJSON'
{
  "name": "cool-wasm-viewer",
  "version": "1.0.0",
  "private": true,
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "express": "^4.21.0",
    "@azure/storage-blob": "^12.25.0"
  }
}
VJSON

    # Sidebar viewer UI (index.html + bundled blank.docx for prewarm).
    # Served by viewer-server.js at / and as the prewarm-doc fallback for
    # /blank.docx when storage doesn't have one.
    mkdir -p "$VDIR/viewer-public"
    cp "$SCRIPT_DIR/viewer-public/index.html"  "$VDIR/viewer-public/"
    cp "$SCRIPT_DIR/viewer-public/blank.docx"  "$VDIR/viewer-public/"

    # Legacy upload-only UI (editor.html). Served at /upload for
    # backwards compatibility with old share links.
    cp "$REPO_ROOT/browser/html/editor.html" "$VDIR/"

    # Install dependencies
    echo "  Installing npm dependencies..."
    (cd "$VDIR" && npm install --production --silent)

    # Smoke-test path "/" should return the sidebar UI (look for the
    # files panel marker). If a deploy ever serves editor.html at / by
    # accident, the smoke test catches it.
    deploy_app "$VIEWER_APP_NAME" "$VDIR" "/" 'id="files"'
fi

# ── Deploy Relay ─────────────────────────────────────────────────
if $DO_RELAY; then
    echo "=== Staging Relay ==="
    RDIR="${RELAY_DEPLOY_DIR}"
    rm -rf "$RDIR"
    mkdir -p "$RDIR"

    # Server + package.json
    cp "$SCRIPT_DIR/message-relay.js" "$RDIR/server.js"
    cat > "$RDIR/package.json" <<'RJSON'
{
  "name": "cool-wasm-relay",
  "version": "1.0.0",
  "private": true,
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "ws": "^8.20.0"
  }
}
RJSON

    # Install dependencies
    echo "  Installing npm dependencies..."
    (cd "$RDIR" && npm install --production --silent)

    deploy_app "$RELAY_APP_NAME" "$RDIR" "/"
fi

# ── Deploy Editor ────────────────────────────────────────────────
if $DO_EDITOR; then
    echo "=== Staging Editor ==="
    EDIR="${EDITOR_DEPLOY_DIR}"
    rm -rf "$EDIR"
    mkdir -p "$EDIR"

    # Server + package.json
    cp "$SCRIPT_DIR/editor-server.js" "$EDIR/server.js"
    cat > "$EDIR/package.json" <<'EJSON'
{
  "name": "cool-wasm-editor",
  "version": "1.0.0",
  "private": true,
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "express": "^4.21.0",
    "compression": "^1.7.5"
  }
}
EJSON

    # Browser dist (cool.html, bundle.js, CSS, images, l10n)
    DIST_SRC="$REPO_ROOT/browser/dist"
    if [[ -d "$DIST_SRC" ]]; then
        echo "  Copying browser/dist/..."
        mkdir -p "$EDIR/browser/dist"
        cp -r "$DIST_SRC/"* "$EDIR/browser/dist/"
    else
        echo "  WARNING: browser/dist/ not found — build the browser first (make)"
    fi

    # WASM artifacts — copied to BOTH root (for direct /online.wasm access)
    # and browser/dist/ (since cool.html loads online.js from /browser/,
    # which then spawns /browser/online.worker.js relative to itself).
    echo "  Copying WASM artifacts..."
    for f in online.js online.wasm online.data online.worker.js soffice.data soffice.data.js.metadata; do
        if [[ -f "$SCRIPT_DIR/$f" ]]; then
            cp "$SCRIPT_DIR/$f" "$EDIR/"
            cp "$SCRIPT_DIR/$f" "$EDIR/browser/dist/"
        else
            echo "    WARNING: $f not found"
        fi
    done

    # Relay adapter and wasm-loader
    for f in relay-adapter.js wasm-loader.js; do
        if [[ -f "$SCRIPT_DIR/$f" ]]; then
            cp "$SCRIPT_DIR/$f" "$EDIR/"
        fi
    done

    # Install dependencies
    echo "  Installing npm dependencies..."
    (cd "$EDIR" && npm install --production --silent)

    deploy_app "$EDITOR_APP_NAME" "$EDIR" "/"
fi

# ── Summary ──────────────────────────────────────────────────────
echo "=========================================="
echo "Deployment complete!"
echo ""
echo "  Viewer: $VIEWER_URL"
echo "  Relay:  $RELAY_URL"
echo "  Editor: $EDITOR_URL"
echo ""
echo "Open the viewer URL to start co-editing."
echo "=========================================="
