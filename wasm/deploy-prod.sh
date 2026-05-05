#!/usr/bin/env bash
# deploy-prod.sh — manual wrapper around wasm/deploy-azure.sh.
#
# Two modes:
#
#   bash wasm/deploy-prod.sh
#     Deploy whatever's currently in /home/localadmin/lo-wasm-ci-state/
#     online-build/ (the most recent local-CI build's tree, or a tree
#     you've built yourself with `bash wasm/build-wasm.sh`).
#
#   bash wasm/deploy-prod.sh --commit <sha>
#     Check out <sha> on a detached HEAD in a temp worktree, run
#     `bash wasm/build-wasm.sh` against it, then deploy the resulting
#     online-build/ tree. Lets you redeploy any historical commit
#     without going through GitHub Actions (slower than --no-build
#     since you pay the C++ kit + Emscripten link). The original
#     working tree is left untouched.
#
# Optional flags (passed through to wasm/deploy-azure.sh):
#   --no-brotli   skip brotli regeneration (faster — but the App
#                 Service will serve plain content; CDN compression
#                 wraps it OK)
#   --skip-viewer / --skip-relay / --skip-editor    skip individual
#                 App Service uploads
#
# Targets:
#   Viewer:  https://szebeni-wasm-viewer.azurewebsites.net
#   Editor:  https://szebeni-wasm-static.azurewebsites.net
#   Relay:   wss://szebeni-wasm-relay.azurewebsites.net
#
# Config file: wasm/.env.deploy (gitignored). Reads:
#   RESOURCE_GROUP, APP_SERVICE_PLAN, VIEWER_APP_NAME, RELAY_APP_NAME,
#   EDITOR_APP_NAME, FILE_STORAGE_URL, EDITOR_URL, RELAY_URL,
#   STORAGE_BACKEND, DOC_STORAGE_ACCOUNT, DOC_STORAGE_CONTAINER.
# See wasm/.env.deploy.example for the full template.
#
# Pre-requisites:
#   - `az login` valid for the target subscription (run interactively
#     once or have a service principal pre-configured)
#   - The signed-in identity has Contributor on the resource group
#   - wasm/.env.deploy filled in
#   - For default mode: a fresh online-build/ tree (~5-10 min if you
#     ran wasm/build-wasm.sh recently, otherwise expect a 10-40 min
#     build before deploy starts)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${CI_STATE_DIR:-/home/localadmin/lo-wasm-ci-state}"

COMMIT=""
PASS_ARGS=()
while (( $# > 0 )); do
    case "$1" in
        --commit) COMMIT="$2"; shift 2 ;;
        --no-brotli|--skip-viewer|--skip-relay|--skip-editor)
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
if [[ ! -f "$REPO_DIR/wasm/.env.deploy" ]]; then
    echo "ERROR: $REPO_DIR/wasm/.env.deploy not found." >&2
    echo "       Copy wasm/.env.deploy.example and fill in the Azure values." >&2
    exit 1
fi

if ! az account show >/dev/null 2>&1; then
    echo "ERROR: az CLI not logged in. Run 'az login' first." >&2
    exit 1
fi

ACCT_INFO="$(az account show --query '{name:name, user:user.name, id:id}' -o tsv)"
echo "Azure subscription: $ACCT_INFO"

# ── Pick the build tree ─────────────────────────────────────────────
if [[ -n "$COMMIT" ]]; then
    # Detached-HEAD worktree path: build a specific commit without
    # disturbing the user's working tree.
    if ! git -C "$REPO_DIR" cat-file -e "$COMMIT^{commit}" 2>/dev/null; then
        echo "ERROR: commit '$COMMIT' not found in $REPO_DIR" >&2
        exit 1
    fi
    WT="$(mktemp -d -t deploy-prod-XXXXXX)"
    trap 'git -C "$REPO_DIR" worktree remove --force "$WT" 2>/dev/null || rm -rf "$WT"' EXIT
    echo "Creating throwaway worktree at $WT for commit $COMMIT…"
    git -C "$REPO_DIR" worktree add --detach "$WT" "$COMMIT"

    echo "Building (cold ccache may take ~30-40 min)…"
    BUILD_DIR="$WT/wasm/online-build" bash "$WT/wasm/build-wasm.sh"

    BUILD_TREE="$WT/wasm/online-build"
else
    BUILD_TREE="$STATE_DIR/online-build"
    if [[ ! -f "$BUILD_TREE/wasm/online.wasm" ]]; then
        echo "ERROR: $BUILD_TREE/wasm/online.wasm not found." >&2
        echo "       Either run 'bash wasm/build-wasm.sh' first, or pass --commit <sha>." >&2
        exit 1
    fi
fi

FINGERPRINT="$(md5sum "$BUILD_TREE/wasm/online.wasm" | cut -c1-16)"
WASM_SIZE="$(du -h "$BUILD_TREE/wasm/online.wasm" | cut -f1)"
WASM_MTIME="$(stat -c %y "$BUILD_TREE/wasm/online.wasm")"

# ── Confirm with the user ───────────────────────────────────────────
. "$REPO_DIR/wasm/.env.deploy"
echo
echo "==============================================================="
echo "  About to deploy to Azure:"
echo "    Viewer:  $VIEWER_URL"
echo "    Editor:  $EDITOR_URL"
echo "    Relay:   $RELAY_URL"
echo "    RG:      $RESOURCE_GROUP"
echo
echo "  Build tree: $BUILD_TREE"
echo "    online.wasm:  $WASM_SIZE  fp=$FINGERPRINT"
echo "    last modified: $WASM_MTIME"
[[ -n "$COMMIT" ]] && echo "    git commit:   $COMMIT"
echo "==============================================================="
echo
read -r -p "Proceed? [y/N] " ANS
[[ "$ANS" == "y" || "$ANS" == "Y" ]] || { echo "aborted."; exit 1; }

# ── Run the actual deploy ───────────────────────────────────────────
# wasm/deploy-azure.sh expects build artefacts at $REPO/wasm/online-build/.
# Symlink the chosen build tree so we don't move bytes.
ln -sfT "$BUILD_TREE" "$REPO_DIR/wasm/online-build"

bash "$REPO_DIR/wasm/deploy-azure.sh" "${PASS_ARGS[@]}"

echo
echo "Smoke:"
for u in "$VIEWER_URL/" "$EDITOR_URL/browser/cool.html" "${RELAY_URL/wss:/https:}/healthz"; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "$u" || echo 000)"
    printf '  %-60s %s\n' "$u" "$code"
done

echo
echo "[OK] Deploy done. Tail App Service logs with:"
echo "  az webapp log tail --resource-group $RESOURCE_GROUP --name $VIEWER_APP_NAME"
