#!/usr/bin/env bash
# deploy-test.sh — manual deploy to the TEST Azure environment.
#
# Four-tier deploy model:
#
#   local     viewer.szebeni.hu                        (dev box)
#             bash wasm/deploy.sh    (or /local-deploy skill)
#
#   test      wasm-viewer-test.azurewebsites.net       (Azure, manual, throwaway)
#             bash wasm/deploy-test.sh
#             Use this for ad-hoc validation against real Azure
#             without disturbing internal/prod.
#
#   internal  wasm-viewer-internal.azurewebsites.net   (Azure, manual, staging)
#             bash wasm/deploy-internal.sh
#
#   prod      szebeni-wasm-viewer.azurewebsites.net    (Azure, CI-driven on dev push)
#             wasm-ci.yml workflow_dispatch / merge to dev
#
# This script wraps wasm/deploy-azure.sh against the TEST Azure
# config — config file at $HOME/ENV/online-test-deploy.env
# (template: wasm/.env.deploy.test.example).
#
# Usage:
#
#   bash wasm/deploy-test.sh [--commit <sha>]
#                            [--viewer|--relay|--editor]
#
#   bash wasm/deploy-test.sh
#     Deploy current /home/localadmin/online/wasm/online-build/ tree
#     to ALL three test Azure App Services. The build must be already
#     finalized — run 'bash wasm/build-wasm.sh' first.
#
#   bash wasm/deploy-test.sh --commit <sha>
#     Detached-worktree build of <sha>, then deploy. Slower (kit +
#     Emscripten link) but lets you redeploy any historical commit
#     without going through GitHub Actions.
#
#   bash wasm/deploy-test.sh --viewer | --relay | --editor
#     Deploy ONLY the named service. Useful when only one service's
#     bytes changed and you want to skip ~3-5 min of Azure churn.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ENV_FILE="${TEST_ENV_FILE:-$HOME/ENV/online-test-deploy.env}"

COMMIT=""
PASS_ARGS=()

while (( $# > 0 )); do
    case "$1" in
        --commit)  COMMIT="$2"; shift 2 ;;
        --viewer|--relay|--editor|--settings|--create)
            PASS_ARGS+=("$1"); shift ;;
        -h|--help)
            sed -nE '2,/^set -euo/{s|^# ?||;p}' "${BASH_SOURCE[0]}" | head -n 40
            exit 0 ;;
        *)
            echo "ERROR: unknown arg '$1' (try --help)" >&2
            exit 1 ;;
    esac
done

# ── Pre-flight ──────────────────────────────────────────────────────
if [[ ! -f "$TEST_ENV_FILE" ]]; then
    echo "ERROR: $TEST_ENV_FILE not found." >&2
    echo "       Copy wasm/.env.deploy.test.example to that path and fill it in." >&2
    exit 1
fi

if ! az account show >/dev/null 2>&1; then
    echo "ERROR: az CLI not logged in. Run 'az login' first." >&2
    exit 1
fi

ACCT_INFO="$(az account show --query '{name:name, user:user.name}' -o tsv)"
echo "Azure subscription: $ACCT_INFO"

# Source the test env file so we can show what we're about to do.
# shellcheck disable=SC1090
. "$TEST_ENV_FILE"

# ── Pick the build tree ─────────────────────────────────────────────
if [[ -n "$COMMIT" ]]; then
    if ! git -C "$REPO_DIR" cat-file -e "$COMMIT^{commit}" 2>/dev/null; then
        echo "ERROR: commit '$COMMIT' not found in $REPO_DIR" >&2
        exit 1
    fi
    WT="$(mktemp -d -t deploy-test-XXXXXX)"
    trap 'git -C "$REPO_DIR" worktree remove --force "$WT" 2>/dev/null || rm -rf "$WT"' EXIT
    echo "Creating throwaway worktree at $WT for commit $COMMIT…"
    git -C "$REPO_DIR" worktree add --detach "$WT" "$COMMIT"
    echo "Building (cold ccache may take ~30-40 min)…"
    BUILD_DIR="$WT/wasm/online-build" bash "$WT/wasm/build-wasm.sh"
    BUILD_TREE="$WT/wasm/online-build"
else
    BUILD_TREE="$REPO_DIR/wasm/online-build"
    [[ -f "$BUILD_TREE/wasm/online.wasm" ]] || {
        echo "ERROR: $BUILD_TREE/wasm/online.wasm not found." >&2
        echo "       Run 'bash wasm/build-wasm.sh' first or pass --commit <sha>." >&2
        exit 1; }
fi

FINGERPRINT="$(md5sum "$BUILD_TREE/wasm/online.wasm" | cut -c1-16)"
WASM_SIZE="$(du -h "$BUILD_TREE/wasm/online.wasm" | cut -f1)"
WASM_MTIME="$(stat -c %y "$BUILD_TREE/wasm/online.wasm")"

# ── Confirm with the user ───────────────────────────────────────────
echo
echo "==============================================================="
echo "  About to deploy to TEST Azure environment:"
echo "    Viewer:  $VIEWER_URL"
echo "    Editor:  $EDITOR_URL"
echo "    Relay:   $RELAY_URL"
echo "    RG:      $RESOURCE_GROUP"
echo "    Plan:    $APP_SERVICE_PLAN"
echo "    Storage: $DOC_STORAGE_ACCOUNT/$DOC_STORAGE_CONTAINER"
echo
echo "  Build tree: $BUILD_TREE"
echo "    online.wasm:   $WASM_SIZE  fp=$FINGERPRINT"
echo "    last modified: $WASM_MTIME"
[[ -n "$COMMIT" ]] && echo "    git commit:    $COMMIT"
echo
echo "  This deploys to TEST — ad-hoc throwaway tier, NOT internal/prod."
echo "==============================================================="
read -r -p "Proceed? [y/N] " ANS
[[ "$ANS" == "y" || "$ANS" == "Y" ]] || { echo "aborted."; exit 1; }

# ── Run the actual Azure deploy ─────────────────────────────────────
# wasm/deploy-azure.sh expects build artefacts at $REPO/wasm/online-build/.
# Symlink the chosen build tree so we don't move bytes. If a real dir
# exists there from an earlier `bash wasm/build-wasm.sh`, replace it.
if [[ "$BUILD_TREE" != "$REPO_DIR/wasm/online-build" ]]; then
    if [[ -e "$REPO_DIR/wasm/online-build" || -L "$REPO_DIR/wasm/online-build" ]]; then
        sudo rm -rf "$REPO_DIR/wasm/online-build"
    fi
    ln -sfT "$BUILD_TREE" "$REPO_DIR/wasm/online-build"
fi

# Tell deploy-azure.sh to use the test config.
ENV_FILE="$TEST_ENV_FILE" bash "$REPO_DIR/wasm/deploy-azure.sh" "${PASS_ARGS[@]}"

echo
echo "Smoke (Azure App Service public URLs):"
RELAY_HTTP="${RELAY_URL/wss:/https:}"
RELAY_HTTP="${RELAY_HTTP/ws:/http:}"
for u in "$VIEWER_URL/" "$EDITOR_URL/browser/cool.html" "$RELAY_HTTP/healthz"; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "$u" || echo 000)"
    printf '  %-60s %s\n' "$u" "$code"
done

echo
echo "[OK] Deploy to TEST Azure done."
echo "    Tail viewer:  az webapp log tail --resource-group $RESOURCE_GROUP --name $VIEWER_APP_NAME"
# Editor is Front-Door-served from the wasmeditor storage static website
# since the per-deploy-folder migration — there is no editor App Service
# to tail (a stale $EDITOR_APP_NAME reference here made the script exit 1
# AFTER a successful deploy, under set -u).
echo "    Tail relay:   az webapp log tail --resource-group $RESOURCE_GROUP --name $RELAY_APP_NAME"
