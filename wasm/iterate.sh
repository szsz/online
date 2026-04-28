#!/bin/bash
# wasm/iterate.sh — one-shot build+deploy cycle for warm-restore work.
#
# Usage:
#   bash wasm/iterate.sh             # rebuild LO Core libs (incremental) + Online + deploy
#   bash wasm/iterate.sh --no-core   # skip LO Core rebuild (Online + deploy only)
#   bash wasm/iterate.sh --no-deploy # build only, skip the brotli compression step
#
# The script keeps lo-wasm-server running across iterations so consecutive
# builds are fast. Use this instead of bash wasm/build-wasm.sh + bash
# wasm/deploy.sh — the latter stops the container after every build, which
# adds ~30 s of cold-start to each iteration.
#
# Prereqs:
#   - lo-wasm-server container exists (created by wasm/build-wasm.sh once)
#   - /home/localadmin/libreoffice-core-wasm bind-mounted at /lo/core
#   - LO Core has been fully built once (instdir/program/soffice.js exists)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTAINER="lo-wasm-server"

NO_CORE=false
NO_DEPLOY=false
for arg in "$@"; do
    case "$arg" in
        --no-core)   NO_CORE=true ;;
        --no-deploy) NO_DEPLOY=true ;;
        *) echo "unknown arg: $arg" >&2; exit 2 ;;
    esac
done

T0=$(date +%s)
step() { echo "[$(($(date +%s)-T0))s] === $* ==="; }

# 1. Ensure container is running.
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}\$"; then
    step "Starting $CONTAINER"
    docker start "$CONTAINER" >/dev/null
    sleep 2
fi

# 2. Rebuild LO Core libs (incremental, no-op if no source changes).
if [ "$NO_CORE" != true ]; then
    step "Rebuilding LO Core libs (Library_sofficeapp Library_comphelper Library_vcl)"
    docker exec "$CONTAINER" bash -c "
        source /home/builder/emsdk/emsdk_env.sh
        cd /lo/core-build && make Library_sofficeapp Library_comphelper Library_vcl -j\$(nproc) 2>&1 | tail -5
    "
fi

# 3. Rebuild Online (incremental).
step "Rebuilding Online (online.wasm)"
docker exec "$CONTAINER" bash -c "
    source /home/builder/emsdk/emsdk_env.sh
    cd /lo/online/wasm/online-build && emmake make -j\$(nproc) 2>&1 | tail -5
"

# 4. Deploy (rehash + brotli + stage to /tmp/static-deploy).
if [ "$NO_DEPLOY" != true ]; then
    step "Deploying to /tmp/static-deploy"
    rm -f /tmp/online-deploy.lock
    bash "$SCRIPT_DIR/deploy.sh" 2>&1 | tail -10
fi

step "Done in $(($(date +%s)-T0))s"
