#!/bin/bash
# Build WASM binary inside Docker container, deploy artifacts, and start services.
# Usage: bash wasm/build-and-run.sh [rebuild|deploy|relay|all]
#   rebuild - rebuild WASM binary in Docker container
#   deploy  - copy artifacts from container to browser/dist
#   relay   - start relay server on host (port 9090)
#   all     - do all of the above (default)

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTAINER=lo-wasm-server
RELAY_PORT=9090

cd "$REPO_DIR"

step_rebuild() {
    echo "=== Step 1: Syncing changed source files to container ==="
    # Sync files that may have changed on host
    for f in wasm/wasmapp.cpp wasm/wasmapp.hpp wsd/Storage.cpp wasm/Makefile.am; do
        if [ -f "$f" ]; then
            docker cp "$f" "$CONTAINER:/lo/online/$f"
            echo "  Copied $f"
        fi
    done

    echo "=== Step 2: Rebuilding WASM binary in container ==="
    docker exec "$CONTAINER" bash -c '
        source /home/builder/emsdk/emsdk_env.sh 2>/dev/null
        cd /lo/online/wasm
        make -j$(nproc) 2>&1
    '
    echo "=== Build complete ==="
}

step_deploy() {
    echo "=== Step 3: Copying WASM artifacts to browser/dist ==="
    mkdir -p browser/dist

    for f in online.js online.wasm online.data online.worker.js; do
        docker cp "$CONTAINER:/lo/online/wasm/$f" "browser/dist/$f"
        echo "  Copied $f"
    done

    # Copy relay files to browser/dist so they're served by emrun
    for f in relay-host.js relay-client-boot.js relay-client.html relay-server.js; do
        if [ -f "wasm/$f" ]; then
            cp "wasm/$f" "browser/dist/$f"
            echo "  Copied $f to browser/dist"
        fi
    done

    # Generate relay-client.html from cool.html if cool.html exists and relay-client.html
    # doesn't have proper structure (fallback - the manually created one should work)
    echo "=== Artifacts deployed ==="
}

step_relay() {
    echo "=== Step 4: Setting up relay server ==="

    # Install ws module if needed (on host, not in container)
    if ! node -e "require('ws')" 2>/dev/null; then
        echo "  Installing ws module..."
        npm install --no-save ws 2>&1
    fi

    # Kill existing relay server if running
    if lsof -ti:$RELAY_PORT >/dev/null 2>&1; then
        echo "  Killing existing process on port $RELAY_PORT..."
        kill $(lsof -ti:$RELAY_PORT) 2>/dev/null || true
        sleep 1
    fi

    echo "  Starting relay server on port $RELAY_PORT..."
    node wasm/relay-server.js &
    RELAY_PID=$!
    echo "  Relay server PID: $RELAY_PID"

    # Restart emrun in container to pick up new artifacts
    echo "=== Restarting emrun in container ==="
    docker exec "$CONTAINER" bash -c '
        pkill -f emrun 2>/dev/null || true
        sleep 1
        source /home/builder/emsdk/emsdk_env.sh 2>/dev/null
        cd /lo/online
        nohup emrun --no-browser --port 6931 --hostname 0.0.0.0 browser/dist/cool.html > /tmp/emrun.log 2>&1 &
        sleep 1
        echo "emrun restarted"
    '

    echo ""
    echo "============================================"
    echo "  All services running!"
    echo "============================================"
    echo ""
    echo "  Browser A (WASM host):"
    echo "    http://localhost:6931/browser/dist/cool.html?file_path=/test/example.odt&relay=ws://localhost:$RELAY_PORT/host?room=default"
    echo ""
    echo "  Browser A (WASM host, file upload):"
    echo "    http://localhost:6931/browser/dist/wasm.html?relay=ws://localhost:$RELAY_PORT/host?room=default"
    echo ""
    echo "  Browser B (thin client):"
    echo "    http://localhost:6931/browser/dist/relay-client.html?relayServer=ws://localhost:$RELAY_PORT&relayRoom=default"
    echo ""
    echo "  Relay server: ws://localhost:$RELAY_PORT"
    echo "============================================"
    echo ""
    echo "Press Ctrl+C to stop the relay server"
    wait $RELAY_PID
}

# Parse command
CMD="${1:-all}"

case "$CMD" in
    rebuild)
        step_rebuild
        ;;
    deploy)
        step_deploy
        ;;
    relay)
        step_relay
        ;;
    all)
        step_rebuild
        step_deploy
        step_relay
        ;;
    *)
        echo "Usage: $0 [rebuild|deploy|relay|all]"
        exit 1
        ;;
esac
