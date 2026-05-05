#!/usr/bin/env bash
# Deploy the just-built Online bundle to the dev box's CI stack.
# Reads $ENV_FILE (set by the runner agent's .env, defaults to
# wasm/.env.ci) for hostnames / ports / cert paths / PUB tree.
#
# This wraps wasm/deploy.sh which does the heavy lifting:
#   - rsync into $PUB/{,browser/}
#   - apply HEAPU8 snapshot inject into online.js
#   - rotate hashed JS filenames + cache-bust
#   - re-emit brotli (.br) sidecars
#   - restart the relay (so all clients reconnect on new code)
#
# All hostnames / ports / cert paths are sourced from $ENV_FILE — never
# hardcode them here. To target the ad-hoc dev stack instead, point
# ENV_FILE at wasm/.env (but the dev box's CI workflow should always
# use wasm/.env.ci, so the live ad-hoc editor at viewer.szebeni.hu is
# never disturbed by a CI run).
#
# Inputs (env):
#   APP_BUILD_ID  — informational, written to a banner blob
#   ENV_FILE      — path to the env definition (default wasm/.env.ci)

set -euo pipefail

WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
STATE_DIR="${CI_STATE_DIR:-/home/localadmin/lo-wasm-ci-state}"

# Resolve ENV_FILE — runner agent sets it to wasm/.env.ci; allow callers
# to override (handy for one-off "deploy to ad-hoc" via this same script).
: "${ENV_FILE:=/home/localadmin/online/wasm/.env.ci}"
if [[ ! -r "$ENV_FILE" ]]; then
    echo "ERROR: ENV_FILE not readable: $ENV_FILE" >&2
    exit 1
fi
echo "ENV_FILE=$ENV_FILE"

# Source the env file. Lines are key=value (single = on first match);
# value may contain further '=' signs (URLs, ROUTES). Set as defaults —
# the calling shell's existing env wins, same convention as launch-*.sh.
while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    if [[ -z "${!key+x}" ]]; then
        export "$key=$value"
    fi
done < "$ENV_FILE"

# wasm/deploy.sh defaults to BUILD_DIR=$REPO/wasm/online-build (the symlink
# in the workspace) — but the CI build wrote into the persistent CI dir
# at $STATE_DIR/online-build (via build-online.sh's bind-mount). Point
# deploy.sh at it explicitly.
export BUILD_DIR="$STATE_DIR/online-build"
# PUB came from $ENV_FILE; reject unset rather than fall through to the
# host's /tmp/static-deploy/public default (which is the AD-HOC stack).
: "${PUB:?PUB must be set in $ENV_FILE — got nothing}"
export PUB

# Required for the smoke step + for tests downstream — these are the
# public URLs reachable through the SNI router on :443.
: "${FILE_STORAGE_URL:?FILE_STORAGE_URL must be set in $ENV_FILE}"
: "${EDITOR_URL:?EDITOR_URL must be set in $ENV_FILE}"
: "${RELAY_URL:?RELAY_URL must be set in $ENV_FILE}"

if [[ ! -f "$BUILD_DIR/wasm/online.wasm" ]]; then
    echo "ERROR: $BUILD_DIR/wasm/online.wasm not found — build step did not produce artefacts" >&2
    exit 1
fi

echo "--- Local deploy: BUILD_DIR=$BUILD_DIR  PUB=$PUB ---"

# wasm/deploy.sh uses a flock at /tmp/online-deploy.lock per PUB tree.
# Override per-stack so the CI deploy doesn't block the ad-hoc deploy.
LOCK_FILE="${LOCK_FILE:-${PUB%/public}.lock}" \
    bash "$WORKSPACE/wasm/deploy.sh"

# Smoke through the SNI router. Fail-loud on any backend that doesn't
# respond (000 / 5xx) — running tests against a half-broken stack just
# wastes the runner's time and produces dozens of misleading
# "test failed: ECONNREFUSED" rows.
sleep 2
echo "--- Smoke ---"
SMOKE_FAILED=0
# RELAY_URL is wss://...; the relay itself answers HTTP on /healthz.
RELAY_HEALTHZ="${RELAY_URL/wss:/https:}"
RELAY_HEALTHZ="${RELAY_HEALTHZ/ws:/http:}/healthz"
for url in "$FILE_STORAGE_URL/" "$EDITOR_URL/browser/cool.html" "$RELAY_HEALTHZ"; do
    code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$url" || echo 000)"
    printf '  %-60s %s\n' "$url" "$code"
    case "$code" in
        000|5??) SMOKE_FAILED=1 ;;
    esac
done
if [[ "$SMOKE_FAILED" == 1 ]]; then
    echo "ERROR: at least one backend smoke probe failed — CI stack is offline" >&2
    echo "       Check /tmp/relay-ci.log /tmp/viewer-ci.log /tmp/editor-static-ci.log" >&2
    exit 1
fi

echo "[OK] Local deploy complete (APP_BUILD_ID=${APP_BUILD_ID:-?})"
