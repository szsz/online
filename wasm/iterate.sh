#!/bin/bash
# wasm/iterate.sh — one-shot build+deploy+report cycle for warm-restore work.
#
# Usage:
#   bash wasm/iterate.sh             # rebuild LO Core libs (incremental) + Online + deploy + run milestone report
#   bash wasm/iterate.sh --no-core   # skip LO Core rebuild (Online + deploy + report)
#   bash wasm/iterate.sh --no-deploy # build only, skip brotli + report
#   bash wasm/iterate.sh --no-test   # build + deploy, skip the milestone report
#
# After deploy the script kicks off test-snapshot-milestones.js which
# republishes https://viewer.szebeni.hu/report/snapshot-milestones/ with
# a fresh per-iteration cold/warm × writer/calc/impress run, screenshots
# at every milestone, and the iframe DOM verification banner. The report
# stamp is the iteration's deploy timestamp so each iteration overwrites
# the prior one cleanly.
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
NO_TEST=false
for arg in "$@"; do
    case "$arg" in
        --no-core)   NO_CORE=true ;;
        --no-deploy) NO_DEPLOY=true ;;
        --no-test)   NO_TEST=true ;;
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

# 5. Run milestone report — re-publishes
#    https://viewer.szebeni.hu/report/snapshot-milestones/ with fresh
#    cold/warm runs for writer/calc/impress and DOM-verified screenshots
#    so every iteration's effect on warm-path reliability is visible.
#    Skipped if --no-test or --no-deploy (no point running against stale
#    artifacts).
if [ "$NO_TEST" != true ] && [ "$NO_DEPLOY" != true ]; then
    step "Running milestone report (tests/snapshot/test-snapshot-milestones.js)"
    cd "$SCRIPT_DIR"
    node tests/snapshot/test-snapshot-milestones.js 2>&1 | tail -30 || {
        echo "[$(($(date +%s)-T0))s] WARNING: milestone report failed (see /tmp/hot-switch-report/snapshot-milestones/)"
    }
fi

step "Done in $(($(date +%s)-T0))s"
