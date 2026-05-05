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
#
# Authentication
# --------------
# The script uses whatever identity `az` CLI is currently logged in as —
# run `az login` once on the machine (or configure `AZURE_*` env vars for
# a service principal before invoking `az login --service-principal`).
# The script itself does not perform a login step.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Default brotli quality is fast (q2) for inner-loop deploys; raise via
# BROTLI_QUALITY=11 for prod-grade wire bytes. Exported so child scripts
# (precompress-br.js, brotli-sidecar.sh) inherit it.
export BROTLI_QUALITY="${BROTLI_QUALITY:-2}"

# ── Load config ──────────────────────────────────────────────────
# Default points at the staging config out-of-repo; caller overrides
# with ENV_FILE=<path> to target a different Azure environment
# (e.g. wasm/deploy-internal.sh sets it to ~/ENV/online-internal-deploy.env).
ENV_FILE="${ENV_FILE:-$HOME/ENV/online-staging-deploy.env}"
if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: $ENV_FILE not found. Copy wasm/.env.deploy.staging.example to that path"
    echo "       (or another location of your choice) and fill it in;"
    echo "       optionally set ENV_FILE=<path> to point at it."
    exit 1
fi
echo "deploy-azure: using ENV_FILE=$ENV_FILE"
# shellcheck disable=SC1090
source "$ENV_FILE"

# Validate required vars
for var in RESOURCE_GROUP APP_SERVICE_PLAN VIEWER_APP_NAME RELAY_APP_NAME EDITOR_APP_NAME \
           VIEWER_URL RELAY_URL EDITOR_URL DOC_STORAGE_ACCOUNT DOC_STORAGE_CONTAINER; do
    if [[ -z "${!var:-}" ]]; then
        echo "ERROR: $var is not set in $ENV_FILE"
        exit 1
    fi
done

# Fail early if az CLI isn't logged in — every code path uses it.
if ! az account show --only-show-errors >/dev/null 2>&1; then
    echo "ERROR: Azure CLI is not logged in. Run \`az login\` first."
    echo "       Alternatively, the CI runner should be configured with a"
    echo "       service principal via \`az login --service-principal ...\`"
    echo "       before this script is invoked."
    exit 1
fi

# If the env file names a specific subscription, make it active.
if [[ -n "${AZURE_SUBSCRIPTION:-}" ]]; then
    az account set --subscription "$AZURE_SUBSCRIPTION" --only-show-errors
fi

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
                --runtime "NODE:24-lts" \
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

    # ALLOWED_ORIGINS: editor + viewer each default their CORS allow-list to
    # FILE_STORAGE_URL, which covers the azurewebsites.net hostnames. When a
    # vanity domain is in use (files.atgpartners.info → viewer), we need both
    # sides to accept that origin for CORS and for the viewer's
    # Permissions-Policy. Build the comma-separated lists once here.
    local VIEWER_ALLOWED EDITOR_ALLOWED
    VIEWER_ALLOWED="$VIEWER_URL,$EDITOR_URL"
    [[ -n "${VIEWER_EXTRA_ORIGINS:-}" ]] && VIEWER_ALLOWED="$VIEWER_ALLOWED,$VIEWER_EXTRA_ORIGINS"
    EDITOR_ALLOWED="$VIEWER_URL"
    [[ -n "${EDITOR_EXTRA_ORIGINS:-}" ]] && EDITOR_ALLOWED="$EDITOR_ALLOWED,$EDITOR_EXTRA_ORIGINS"

    # Viewer settings — uses Azure Blob storage backend in App Services.
    # Auth via the App Service's MSI (DefaultAzureCredential). The
    # viewer's identity must hold "Storage Blob Data Contributor" on
    # $DOC_STORAGE_ACCOUNT. NO key is set in App Settings; if a stale
    # DOC_STORAGE_KEY exists from a prior deploy, it is removed below.
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
            DOC_STORAGE_CONTAINER="$DOC_STORAGE_CONTAINER" \
            ALLOWED_ORIGINS="$VIEWER_ALLOWED" \
            WEBSITE_NODE_DEFAULT_VERSION="~24" \
        > /dev/null
    # Strip a leftover DOC_STORAGE_KEY app setting if present (safe no-op
    # when absent; the --setting-names form ignores missing keys).
    az webapp config appsettings delete \
        --resource-group "$RESOURCE_GROUP" \
        --name "$VIEWER_APP_NAME" \
        --setting-names DOC_STORAGE_KEY \
        > /dev/null 2>&1 || true

    # Relay settings
    echo "  Relay ($RELAY_APP_NAME)..."
    az webapp config appsettings set \
        --resource-group "$RESOURCE_GROUP" \
        --name "$RELAY_APP_NAME" \
        --settings \
            FILE_STORAGE_URL="$VIEWER_URL" \
            WEBSITE_NODE_DEFAULT_VERSION="~24" \
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
            ALLOWED_ORIGINS="$EDITOR_ALLOWED" \
            WEBSITE_NODE_DEFAULT_VERSION="~24" \
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

    # Retry around `az webapp deploy` — kudu (the SCM endpoint that
    # accepts the zip upload) returns transient 4xx/5xx when:
    #   - a previous deploy on this App Service hasn't fully released
    #     its lock (Azure-side, not visible to us)
    #   - the App Service worker is mid-restart (e.g. after a setting
    #     change or upstream az service blip)
    #   - the kudu container itself is being recycled
    # All of these clear within ~30 s. Three attempts with 30 s back-off
    # is enough cushion without dragging out failures of real bugs
    # (which all hit the same error every retry).
    echo "  Deploying to $APP_NAME..."
    local DEPLOY_OK=0 try=0
    for try in 1 2 3; do
        if az webapp deploy \
                --resource-group "$RESOURCE_GROUP" \
                --name "$APP_NAME" \
                --type zip \
                --src-path "$ZIP_PATH"; then
            DEPLOY_OK=1
            break
        fi
        echo "    az webapp deploy failed (attempt $try/3); waiting 30s before retry"
        sleep 30
    done
    if [[ "$DEPLOY_OK" != "1" ]]; then
        echo "  ERROR: az webapp deploy to $APP_NAME failed 3 times — giving up"
        return 1
    fi

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
    local i HTTP
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

    # Iter 97: Express 5 — viewer-server.js uses path-to-regexp v8
    # wildcard syntax (`*name`) for the /api/files/<nested/path> route,
    # which Express 4's path-to-regexp v0.x silently fails to register.
    # Result on Azure: POST /api/files/<n> 404s, regression-viewer-cache,
    # regression-user-save-checkpoint, folder-api etc. all fail
    # purely due to missing route registration.
    cat > "$VDIR/package.json" <<'VJSON'
{
  "name": "cool-wasm-viewer",
  "version": "1.0.0",
  "private": true,
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "express": "^5.2.1",
    "@azure/storage-blob": "^12.25.0",
    "@azure/identity": "^4.4.0"
  }
}
VJSON

    # Sidebar viewer UI (index.html + bundled blank.docx for prewarm).
    # Served by viewer-server.js at / and as the prewarm-doc fallback for
    # /blank.docx when storage doesn't have one.
    mkdir -p "$VDIR/viewer-public"
    # Copy the whole viewer-public/ tree so new assets (singleuser.html,
    # help.html, images, …) don't have to be added to this list one by one.
    cp -r "$SCRIPT_DIR/viewer-public/." "$VDIR/viewer-public/"

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

    # Server + package.json. No `compression` dep — the editor serves
    # pre-compressed .br files (written below) instead of paying the
    # CPU cost of runtime compression.
    cp "$SCRIPT_DIR/editor-server.js" "$EDIR/server.js"
    # Iter 97: Express 5 — match the source declaration so wildcard
    # path-to-regexp v8 routes (e.g. /api/files/*name) register.
    cat > "$EDIR/package.json" <<'EJSON'
{
  "name": "cool-wasm-editor",
  "version": "1.0.0",
  "private": true,
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "express": "^5.2.1"
  }
}
EJSON

    # Locate build artifacts. The WASM build produces two parallel trees:
    #   wasm/online-build/wasm/         → online.wasm, online.worker.js
    #   wasm/online-build/browser/dist/ → cool.html, bundle.js, online.js,
    #                                     online.wasm, soffice.data, …
    # (the legacy `browser/dist` at the repo root is not produced by this
    #  build; keep it as a fallback for old setups).
    BUILD_ROOT="$SCRIPT_DIR/online-build"
    BUILD_WASM="$BUILD_ROOT/wasm"
    BUILD_DIST="$BUILD_ROOT/browser/dist"
    if [[ ! -d "$BUILD_DIST" ]]; then
        BUILD_DIST="$REPO_ROOT/browser/dist"
    fi

    # Browser dist (cool.html, bundle.js, CSS, images, l10n)
    if [[ -d "$BUILD_DIST" ]]; then
        echo "  Copying browser/dist/ from $BUILD_DIST ..."
        mkdir -p "$EDIR/browser/dist"
        cp -r "$BUILD_DIST/." "$EDIR/browser/dist/"
    else
        echo "  ERROR: browser/dist/ not found (tried $BUILD_ROOT/browser/dist and $REPO_ROOT/browser/dist)"
        echo "         Build the editor first: bash wasm/build-wasm.sh"
        exit 1
    fi

    # WASM artifacts — copied to BOTH root (for direct /online.wasm access)
    # and browser/dist/ (since cool.html loads online.js from /browser/,
    # which then spawns /browser/online.worker.js relative to itself).
    #
    # Artifact pairing: online.js + online.wasm are produced together; the JS
    # embeds data-section sizes the engine validates against the .wasm bytes.
    # Mixing a fresh online.js with a stale online.wasm (e.g. from a parallel
    # link target) will decode fine but fail to instantiate with
    # 'CompileError: section extends past end'. Pick ONE source directory
    # that has both, then copy both from there — never mix sources.
    echo "  Picking paired online.{js,wasm}..."
    PAIRED_DIR=""
    for d in "$BUILD_DIST" "$BUILD_WASM"; do
        if [[ -f "$d/online.js" && -f "$d/online.wasm" ]]; then
            PAIRED_DIR="$d"; break
        fi
    done
    if [[ -z "$PAIRED_DIR" ]]; then
        echo "  ERROR: no directory contains BOTH online.js and online.wasm."
        echo "         Checked: $BUILD_DIST  $BUILD_WASM"
        echo "         Build the editor first: bash wasm/build-wasm.sh"
        exit 1
    fi
    # Warn loudly if the other tree has a different online.wasm — that means
    # the build system has two link targets in flight, and whichever one we
    # didn't pick will silently become wrong on the next rebuild.
    OTHER_DIR=""
    [[ "$PAIRED_DIR" == "$BUILD_DIST" ]] && OTHER_DIR="$BUILD_WASM" || OTHER_DIR="$BUILD_DIST"
    if [[ -f "$OTHER_DIR/online.wasm" ]] && \
       ! cmp -s "$PAIRED_DIR/online.wasm" "$OTHER_DIR/online.wasm"; then
        echo "  WARNING: $OTHER_DIR/online.wasm differs from the one picked."
        echo "           If a later step reads from $OTHER_DIR it will mismatch."
        echo "             picked:   $(md5sum "$PAIRED_DIR/online.wasm" | cut -c1-16)  $PAIRED_DIR/online.wasm"
        echo "             discard:  $(md5sum "$OTHER_DIR/online.wasm"  | cut -c1-16)  $OTHER_DIR/online.wasm"
    fi
    echo "  Paired artefacts source: $PAIRED_DIR"
    echo "    online.js    md5(head)=$(head -c 65536 "$PAIRED_DIR/online.js" | md5sum | cut -c1-16)"
    echo "    online.wasm  md5=$(md5sum "$PAIRED_DIR/online.wasm" | cut -c1-16)"

    echo "  Copying WASM artifacts..."
    find_artifact() {
        local name=$1
        # online.js + online.wasm MUST come from the paired dir (never mix).
        if [[ "$name" == "online.js" || "$name" == "online.wasm" ]]; then
            [[ -f "$PAIRED_DIR/$name" ]] && { echo "$PAIRED_DIR/$name"; return 0; }
            return 1
        fi
        # Everything else: prefer the paired dir, fall back to the other.
        for d in "$PAIRED_DIR" "$OTHER_DIR"; do
            [[ -f "$d/$name" ]] && { echo "$d/$name"; return 0; }
        done
        return 1
    }
    for f in online.js online.wasm online.data online.worker.js soffice.data soffice.data.js.metadata emscripten-module.js; do
        src="$(find_artifact "$f" || true)"
        if [[ -n "$src" ]]; then
            cp "$src" "$EDIR/$f"
            cp "$src" "$EDIR/browser/dist/$f"
            # Carry brotli sidecar from the build tree if it exists
            # (build-wasm.sh / build-online.sh emit .br at quality 11
            # alongside each source file). precompress-br.js below is
            # idempotent — sees the .br is newer than the source and
            # skips the ~15-min recompression of online.wasm.
            if [[ -f "$src.br" ]]; then
                cp "$src.br" "$EDIR/$f.br"
                cp "$src.br" "$EDIR/browser/dist/$f.br"
            fi
        else
            # online.data is only present for --preload-file builds; absence
            # is not fatal for the --package build variant.
            case "$f" in
                online.data) ;;
                *) echo "    WARNING: $f not found in $BUILD_WASM or $BUILD_DIST" ;;
            esac
        fi
    done


    # Relay adapter, wasm-loader, and the Service Worker — copied to both
    # the editor root (for any legacy /relay-adapter.js references) AND
    # under browser/dist/ so cool.html's relative `<script src="…">` and
    # `navigator.serviceWorker.register('sw.js')` resolve via the
    # /browser/ static route.
    for f in relay-adapter.js wasm-loader.js sw.js dict-loader.js; do
        if [[ -f "$SCRIPT_DIR/$f" ]]; then
            cp "$SCRIPT_DIR/$f" "$EDIR/"
            cp "$SCRIPT_DIR/$f" "$EDIR/browser/dist/"
        else
            case "$f" in
                dict-loader.js) echo "    NOTE: $f not found — spellcheck lazy-load disabled" ;;
                *) echo "    WARNING: $f not found — viewer hot-switch / SW cache will fail without it" ;;
            esac
        fi
    done

    # Lazy-load spellcheck dictionaries — produced by wasm/build-dicts.sh.
    # We deploy them under <app>/dicts/ so dict-loader.js (which resolves
    # /dicts/ relative to its own script URL) finds them on the editor
    # origin. Each <lang>.tar.gz is fetched on demand by the client.
    DICTS_SRC="$SCRIPT_DIR/online-build/dicts"
    if [[ -d "$DICTS_SRC" ]] && ls "$DICTS_SRC"/*.tar.gz >/dev/null 2>&1; then
        mkdir -p "$EDIR/dicts"
        cp -f "$DICTS_SRC"/*.tar.gz "$EDIR/dicts/"
        cp -f "$DICTS_SRC/manifest.json" "$EDIR/dicts/"
        DICT_COUNT=$(ls "$EDIR/dicts"/*.tar.gz | wc -l)
        echo "  Bundled $DICT_COUNT language dict bundles ($(du -sh "$EDIR/dicts" | cut -f1))"
    else
        echo "  NOTE: no dict bundles — run 'bash wasm/build-dicts.sh' first (spellcheck will be disabled)"
    fi


    # Substitute the build fingerprint in wasm-loader.js AND sw.js.
    # Snapshots saved by an old build are discarded on restore when the
    # fingerprint differs from the running binary, and the Service
    # Worker's CACHE_NAME embeds it so a fresh deploy lands in a new
    # Cache Storage namespace and the previous build's heavy assets are
    # GC'd by the activate handler. Every deploy must rewrite both
    # placeholders with an identifier of THIS online.wasm — otherwise
    # sw.js falls back to the dev-tree 'cool-editor-dev' name and never
    # rolls between deploys.
    if [[ -f "$EDIR/online.wasm" ]]; then
        FINGERPRINT=$(md5sum "$EDIR/online.wasm" | cut -c1-16)
        echo "  Build fingerprint: $FINGERPRINT"
        for p in "$EDIR/wasm-loader.js" "$EDIR/browser/dist/wasm-loader.js" \
                 "$EDIR/sw.js" "$EDIR/browser/dist/sw.js"; do
            [[ -f "$p" ]] && sed -i "s|__WASM_BUILD_FINGERPRINT__|$FINGERPRINT|g" "$p"
        done
    fi

    # Install dependencies
    echo "  Installing npm dependencies..."
    (cd "$EDIR" && npm install --production --silent)


    # Bake content hashes into asset filenames + cool.html. Renames each
    # long-cacheable asset to <base>.<hash>.<ext>, moves the .br sidecar
    # alongside, and rewrites cool.html (asset refs + Module.locateFile
    # shim ahead of online.js). Runs AFTER brotli so the .br sidecars
    # are renamed in lockstep.

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
