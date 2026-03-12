#!/bin/bash
# Copy relay/upload files to browser/dist (no Docker needed)
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

echo "Deploying files to browser/dist..."
for f in relay-host.js relay-client-boot.js relay-client.html relay-server.js emscripten-module.js; do
    cp "wasm/$f" "browser/dist/$f"
    echo "  $f"
done
cp "browser/html/wasm.html" "browser/dist/wasm.html"
echo "  wasm.html"
echo "Done."
