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

# CI's runner workspace at $GITHUB_WORKSPACE/wasm has no .env (it's
# gitignored, lives only on the dev box's main checkout). When deploy.sh
# restarts launch-relay.sh from the runner workspace, that script reads
# its sibling .env — finds none — and dies with "RELAY_PORT unset",
# leaving the host stack offline. Point all the launch-*.sh callees at
# the host's real .env so they pick up RELAY_PORT, certs, etc.
HOST_ENV_FILE="${HOST_ENV_FILE:-/home/localadmin/online/wasm/.env}"
if [[ -r "$HOST_ENV_FILE" ]]; then
    export ENV_FILE="$HOST_ENV_FILE"
    echo "Using host env file: $ENV_FILE"
else
    echo "ERROR: HOST_ENV_FILE not readable: $HOST_ENV_FILE — relay/launchers will fail" >&2
    exit 1
fi

if [[ ! -f "$BUILD_DIR/wasm/online.wasm" ]]; then
    echo "ERROR: $BUILD_DIR/wasm/online.wasm not found — build step did not produce artefacts" >&2
    exit 1
fi

echo "--- Local deploy: BUILD_DIR=$BUILD_DIR  PUB=$PUB ---"

# wasm/deploy.sh uses a flock at /tmp/online-deploy.lock — works across
# concurrent CI runs on the same host without further plumbing.
bash "$WORKSPACE/wasm/deploy.sh"

# Quick smoke: viewer should serve index.html and editor should respond.
# Fail-loud on any backend that doesn't respond (000) — running tests
# against a half-broken stack just wastes the runner's time and produces
# 30+ misleading "test failed: ECONNREFUSED" rows.
sleep 2
echo "--- Smoke ---"
SMOKE_FAILED=0
for url in https://viewer.szebeni.hu/ \
           https://wasm.atgpartners.info/browser/cool.html \
           https://relay.atgpartners.info/healthz; do
    code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$url" || echo 000)"
    printf '  %-60s %s\n' "$url" "$code"
    case "$code" in
        000|5??) SMOKE_FAILED=1 ;;
    esac
done
if [[ "$SMOKE_FAILED" == 1 ]]; then
    echo "ERROR: at least one backend smoke probe failed — host stack is offline" >&2
    echo "       Check /tmp/relay.log /tmp/viewer.log /tmp/editor-static.log" >&2
    exit 1
fi

echo "[OK] Local deploy complete (APP_BUILD_ID=${APP_BUILD_ID:-?})"
