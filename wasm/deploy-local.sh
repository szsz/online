#!/bin/bash
# Local deployment: rebuild in Docker, copy to static-deploy, start server.
# Usage:
#   bash wasm/deploy-local.sh          # full rebuild + deploy + start server
#   bash wasm/deploy-local.sh --skip-build  # skip Docker rebuild, just copy JS/HTML + restart
#   bash wasm/deploy-local.sh --server-only # just restart the server (no file copies)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_DIR="C:/tmp/static-deploy"
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

    echo "--- Copying source files into container ---"
    docker cp "$REPO_DIR/kit/ChildSession.cpp" "$CONTAINER:/lo/online/kit/ChildSession.cpp"
    echo "  ChildSession.cpp"

    for f in relay-host.js relay-client-boot.js relay-client.html relay-server.js relay-crypto.js emscripten-module.js wasm-crypto-sw.js; do
        if [ -f "$SCRIPT_DIR/$f" ]; then
            docker cp "$SCRIPT_DIR/$f" "$CONTAINER:/lo/online/wasm/$f"
            echo "  $f"
        fi
    done

    echo "--- Clean relink in container ---"
    docker exec "$CONTAINER" bash -c "cd /lo/online && rm -f browser/dist/online.js browser/dist/online.wasm browser/dist/online.worker.js"
    docker exec "$CONTAINER" bash -c "cd /lo/online && make 2>&1" | tail -5
    echo "  Build complete"

    echo "--- Copying build artifacts ---"
    rm -f "$PUBLIC_DIR/online.js" "$PUBLIC_DIR/online.wasm" "$PUBLIC_DIR/online.worker.js"
    docker cp "$CONTAINER:/lo/online/browser/dist/online.js" "$PUBLIC_DIR/online.js"
    docker cp "$CONTAINER:/lo/online/browser/dist/online.wasm" "$PUBLIC_DIR/online.wasm"
    echo "  online.js online.wasm"
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
for pid in $(netstat -ano 2>/dev/null | grep ":${PORT}.*LISTENING" | awk '{print $5}' | sort -u); do
    taskkill //F //PID "$pid" 2>/dev/null && echo "  Killed PID $pid" || true
done
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
