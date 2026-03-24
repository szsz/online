#!/bin/bash
# Local deployment: rebuild in Docker, copy to static-deploy, start server.
# Usage:
#   bash wasm/deploy-local.sh          # full rebuild + deploy + start server
#   bash wasm/deploy-local.sh --skip-build  # skip Docker rebuild, just copy JS/HTML + restart
#   bash wasm/deploy-local.sh --server-only # just restart the server (no file copies)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* || "$(uname -s)" == CYGWIN* ]]; then
    DEPLOY_DIR="C:/tmp/static-deploy"
else
    DEPLOY_DIR="/tmp/static-deploy"
fi
PUBLIC_DIR="$DEPLOY_DIR/public"
CONTAINER="lo-wasm-server"
PORT=6931

SKIP_BUILD=false
SERVER_ONLY=false
for arg in "$@"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=true ;;
        --server-only) SERVER_ONLY=true; SKIP_BUILD=true ;;
    esac
done

echo "=== Local WASM Deploy ==="

# --- Docker rebuild ---
if [ "$SKIP_BUILD" = false ]; then
    if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER}$"; then
        echo "ERROR: Docker container '$CONTAINER' is not running. Start Docker Desktop first,"
        echo "       or use --skip-build to skip the rebuild step."
        exit 1
    fi

    # Determine container paths: init-local.sh uses /lo/online + /lo/online-build,
    # but older setups may have everything in /lo/online directly.
    CBUILD="/lo/online-build"
    CSRC="/lo/online"
    if ! docker exec "$CONTAINER" test -d "$CBUILD" 2>/dev/null; then
        CBUILD="/lo/online"
    fi

    echo "--- Copying source files into container ---"
    for f in kit/ChildSession.cpp kit/Kit.cpp kit/KitWebSocket.cpp wasm/wasmapp.cpp wsd/DocumentBroker.cpp; do
        if [ -f "$REPO_DIR/$f" ]; then
            docker cp "$REPO_DIR/$f" "$CONTAINER:$CSRC/$f"
            echo "  $(basename $f)"
        fi
    done

    for f in relay-host.js relay-client-boot.js relay-client.html relay-server.js relay-crypto.js emscripten-module.js wasm-crypto-sw.js; do
        if [ -f "$SCRIPT_DIR/$f" ]; then
            docker cp "$SCRIPT_DIR/$f" "$CONTAINER:$CSRC/wasm/$f"
            echo "  $f"
        fi
    done

    echo "--- Clean relink in container ---"
    docker exec "$CONTAINER" bash -c "
        source /home/builder/emsdk/emsdk_env.sh 2>/dev/null
        cd $CBUILD
        rm -f wasm/online.js wasm/online.wasm wasm/online.worker.js \
              browser/dist/online.js browser/dist/online.wasm browser/dist/online.worker.js
        emmake make -j\$(nproc) 2>&1
    " | tail -10
    echo "  Build complete"

    echo "--- Copying build artifacts ---"
    rm -f "$PUBLIC_DIR/online.js" "$PUBLIC_DIR/online.wasm" "$PUBLIC_DIR/online.worker.js"
    for f in online.js online.wasm online.worker.js; do
        if docker exec "$CONTAINER" test -f "$CBUILD/wasm/$f" 2>/dev/null; then
            docker cp "$CONTAINER:$CBUILD/wasm/$f" "$PUBLIC_DIR/$f"
        elif docker exec "$CONTAINER" test -f "$CBUILD/browser/dist/$f" 2>/dev/null; then
            docker cp "$CONTAINER:$CBUILD/browser/dist/$f" "$PUBLIC_DIR/$f"
        fi
    done
    echo "  online.js online.wasm"

    echo "--- Brotli compression ---"
    for f in online.wasm soffice.data bundle.js l10n-all.js online.js bundle.css; do
        if [ -f "$PUBLIC_DIR/$f" ]; then
            brotli -c -q 11 "$PUBLIC_DIR/$f" > "$PUBLIC_DIR/${f}.br"
            orig=$(wc -c < "$PUBLIC_DIR/$f" | tr -d ' ')
            comp=$(wc -c < "$PUBLIC_DIR/${f}.br" | tr -d ' ')
            echo "  $f: $orig → $comp bytes"
        fi
    done
fi

# --- Copy JS/HTML overlay files ---
if [ "$SERVER_ONLY" = false ]; then
    echo "--- Copying wasm overlay files ---"
    for f in relay-host.js relay-client-boot.js relay-client.html relay-crypto.js wasm-crypto-sw.js emscripten-module.js; do
        if [ -f "$SCRIPT_DIR/$f" ]; then
            cp "$SCRIPT_DIR/$f" "$PUBLIC_DIR/$f"
            echo "  $f"
        fi
    done
    if [ -f "$REPO_DIR/browser/html/wasm.html" ]; then
        cp "$REPO_DIR/browser/html/wasm.html" "$PUBLIC_DIR/wasm.html"
        echo "  wasm.html"
    fi
fi

# --- Kill existing server ---
echo "--- Restarting server on port $PORT ---"
if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* || "$(uname -s)" == CYGWIN* ]]; then
    for pid in $(netstat -ano 2>/dev/null | grep ":${PORT}.*LISTENING" | awk '{print $5}' | sort -u); do
        taskkill //F //PID "$pid" 2>/dev/null && echo "  Killed PID $pid" || true
    done
else
    for pid in $(lsof -ti ":${PORT}" 2>/dev/null); do
        kill "$pid" 2>/dev/null && echo "  Killed PID $pid" || true
    done
fi
sleep 1

# --- Start server (foreground) ---
echo "--- Starting server ---"
cd "$DEPLOY_DIR"

# Verify it will serve correctly
node -e "
const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname, 'public');
const test = path.join(root, 'wasm.html');
if (!fs.existsSync(test)) {
    console.error('ERROR: ' + test + ' not found');
    process.exit(1);
}
console.log('  ROOT: ' + root);
console.log('  Files: online.js=' + (fs.existsSync(path.join(root,'online.js'))?'OK':'MISSING') +
    ', online.wasm=' + (fs.existsSync(path.join(root,'online.wasm'))?'OK':'MISSING') +
    ', wasm.html=' + (fs.existsSync(path.join(root,'wasm.html'))?'OK':'MISSING'));
"

echo "=== Starting on http://localhost:$PORT/wasm.html ==="
exec node server.js
