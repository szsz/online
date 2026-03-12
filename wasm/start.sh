#!/bin/bash
# Start everything: deploy files, start static server + relay server.
# Usage: bash wasm/start.sh
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

SERVE_PORT=6931
RELAY_PORT=9090

# Step 1: Deploy latest files
bash wasm/deploy.sh

# Step 2: Install ws module if needed
if ! node -e "require('ws')" 2>/dev/null; then
    echo "Installing ws module..."
    npm install --no-save ws
fi

# Step 3: Kill any existing processes on our ports
for port in $SERVE_PORT $RELAY_PORT; do
    pid=$(lsof -ti:$port 2>/dev/null || true)
    if [ -n "$pid" ]; then
        echo "Killing existing process on port $port (PID $pid)..."
        kill $pid 2>/dev/null || true
        sleep 1
    fi
done

# Step 4: Start relay server in background
echo ""
echo "Starting relay server on port $RELAY_PORT..."
node wasm/relay-server.js &
RELAY_PID=$!

# Step 5: Start static file server in background
echo "Starting file server on port $SERVE_PORT..."
node wasm/serve.js $SERVE_PORT &
SERVE_PID=$!

sleep 1
echo ""
echo "============================================"
echo "  All services running!"
echo "============================================"
echo ""
echo "  File upload mode:"
echo "    http://localhost:$SERVE_PORT/wasm.html"
echo ""
echo "  File upload + relay (p2p coediting):"
echo "    http://localhost:$SERVE_PORT/wasm.html?relay=ws://localhost:$RELAY_PORT/host?room=default"
echo ""
echo "  Thin client (Browser B):"
echo "    http://localhost:$SERVE_PORT/relay-client.html?relayServer=ws://localhost:$RELAY_PORT&relayRoom=default"
echo ""
echo "============================================"
echo "Press Ctrl+C to stop all services"
echo ""

trap "kill $RELAY_PID $SERVE_PID 2>/dev/null; exit" INT TERM
wait
