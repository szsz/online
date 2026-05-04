#!/usr/bin/env bash
# Deploy the just-built Online bundle to the dev box's local web roots
# (viewer.szebeni.hu / wasm.atgpartners.info / relay.atgpartners.info).
# This wraps wasm/deploy.sh which already does the heavy lifting:
#   - rsync into /tmp/static-deploy/public/{,browser/}
#   - apply HEAPU8 snapshot inject into online.js
#   - rotate hashed JS filenames + cache-bust
#   - re-emit brotli (.br) sidecars
#   - restart the relay (so all clients reconnect on new code)
#
# Inputs (env):
#   APP_BUILD_ID — informational, written to a banner blob
#
# This is a no-op for Azure App Services. It only touches the dev-box host
# the self-hosted runner is on.

set -euo pipefail

WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
STATE_DIR="${CI_STATE_DIR:-/home/localadmin/lo-wasm-ci-state}"

# wasm/deploy.sh defaults to BUILD_DIR=$REPO/wasm/online-build (the symlink
# in the workspace) — but the CI build wrote into the persistent CI dir
# at $STATE_DIR/online-build (via build-online.sh's bind-mount). Point
# deploy.sh at it explicitly.
export BUILD_DIR="$STATE_DIR/online-build"
export PUB="${PUB:-/tmp/static-deploy/public}"

if [[ ! -f "$BUILD_DIR/wasm/online.wasm" ]]; then
    echo "ERROR: $BUILD_DIR/wasm/online.wasm not found — build step did not produce artefacts" >&2
    exit 1
fi

echo "--- Local deploy: BUILD_DIR=$BUILD_DIR  PUB=$PUB ---"

# wasm/deploy.sh uses a flock at /tmp/online-deploy.lock — works across
# concurrent CI runs on the same host without further plumbing.
bash "$WORKSPACE/wasm/deploy.sh"

# Quick smoke: viewer should serve index.html and editor should respond.
sleep 2
echo "--- Smoke ---"
for url in https://viewer.szebeni.hu/ \
           https://wasm.atgpartners.info/browser/cool.html \
           https://relay.atgpartners.info/healthz; do
    code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$url" || echo 000)"
    printf '  %-60s %s\n' "$url" "$code"
done

echo "[OK] Local deploy complete (APP_BUILD_ID=${APP_BUILD_ID:-?})"
