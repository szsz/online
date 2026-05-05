#!/usr/bin/env bash
# deploy-internal.sh — manual deploy to one of the dev box's INTERNAL stacks.
#
# Two parallel local stacks share :443 via the SNI router:
#
#   adhoc  →  https://viewer.szebeni.hu        (live dev playground)
#             https://wasm.atgpartners.info    (editor)
#             wss://relay.atgpartners.info     (relay)
#             config: ~/ENV/online.env  (PUB=/tmp/static-deploy/public)
#
#   ci     →  https://ci-viewer.szebeni.hu     (CI lane)
#             https://ci-editor.atgpartners.info
#             wss://ci-relay.atgpartners.info
#             config: ~/ENV/online-ci.env  (PUB=/tmp/static-deploy-ci/public)
#
# AZURE PROD App Services are NOT touched by this script. Use the
# wasm-ci.yml workflow_dispatch (or merge to dev) to push to prod.
#
# Usage:
#
#   bash wasm/deploy-internal.sh [--target adhoc|ci] [--commit <sha>]
#                                [--no-brotli] [--no-smoke]
#
#   bash wasm/deploy-internal.sh
#     Deploy current /home/localadmin/lo-wasm-ci-state/online-build/
#     tree to the ad-hoc stack (viewer.szebeni.hu).
#
#   bash wasm/deploy-internal.sh --target ci
#     Same tree, but push to the CI stack (ci-viewer.szebeni.hu).
#     Useful for testing the CI lane without dispatching wasm-ci-local.yml.
#
#   bash wasm/deploy-internal.sh --commit <sha>
#     Detached-worktree build of <sha>, then deploy. Slower (you pay
#     the kit + Emscripten link) but lets you redeploy any commit
#     without going through CI.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${CI_STATE_DIR:-/home/localadmin/lo-wasm-ci-state}"

TARGET="adhoc"
COMMIT=""
PASS_ARGS=()

while (( $# > 0 )); do
    case "$1" in
        --target)    TARGET="$2"; shift 2 ;;
        --commit)    COMMIT="$2"; shift 2 ;;
        --no-brotli|--no-smoke|--no-inject)
            PASS_ARGS+=("$1"); shift ;;
        -h|--help)
            sed -nE '2,/^set -euo/{s|^# ?||;p}' "${BASH_SOURCE[0]}" | head -n 40
            exit 0 ;;
        *)
            echo "ERROR: unknown arg '$1' (try --help)" >&2
            exit 1 ;;
    esac
done

case "$TARGET" in
    adhoc) ENV_FILE="$HOME/ENV/online.env" ;;
    ci)    ENV_FILE="$HOME/ENV/online-ci.env" ;;
    *)     echo "ERROR: --target must be 'adhoc' or 'ci' (got: $TARGET)" >&2; exit 1 ;;
esac
[[ -r "$ENV_FILE" ]] || { echo "ERROR: $ENV_FILE not readable" >&2; exit 1; }

# Source values from the chosen env file as defaults — caller's shell wins.
while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    [[ -z "${!key+x}" ]] && export "$key=$value"
done < "$ENV_FILE"
export ENV_FILE

# ── Pick the build tree ─────────────────────────────────────────────
if [[ -n "$COMMIT" ]]; then
    if ! git -C "$REPO_DIR" cat-file -e "$COMMIT^{commit}" 2>/dev/null; then
        echo "ERROR: commit '$COMMIT' not found in $REPO_DIR" >&2
        exit 1
    fi
    WT="$(mktemp -d -t deploy-internal-XXXXXX)"
    trap 'git -C "$REPO_DIR" worktree remove --force "$WT" 2>/dev/null || rm -rf "$WT"' EXIT
    echo "Creating throwaway worktree at $WT for commit $COMMIT…"
    git -C "$REPO_DIR" worktree add --detach "$WT" "$COMMIT"
    echo "Building (cold ccache may take ~30-40 min)…"
    BUILD_DIR="$WT/wasm/online-build" bash "$WT/wasm/build-wasm.sh"
    BUILD_TREE="$WT/wasm/online-build"
else
    BUILD_TREE="$STATE_DIR/online-build"
    [[ -f "$BUILD_TREE/wasm/online.wasm" ]] || {
        echo "ERROR: $BUILD_TREE/wasm/online.wasm not found." >&2
        echo "       Run 'bash wasm/build-wasm.sh' first or pass --commit <sha>." >&2
        exit 1; }
fi

FINGERPRINT="$(md5sum "$BUILD_TREE/wasm/online.wasm" | cut -c1-16)"
WASM_SIZE="$(du -h "$BUILD_TREE/wasm/online.wasm" | cut -f1)"

echo
echo "==============================================================="
echo "  Target:  $TARGET ($ENV_FILE)"
echo "    Viewer:  $FILE_STORAGE_URL"
echo "    Editor:  $EDITOR_URL"
echo "    Relay:   $RELAY_URL"
echo "    PUB:     $PUB"
echo
echo "  Build tree: $BUILD_TREE"
echo "    online.wasm: $WASM_SIZE  fp=$FINGERPRINT"
[[ -n "$COMMIT" ]] && echo "    commit:      $COMMIT"
echo "==============================================================="
read -r -p "Proceed? [y/N] " ANS
[[ "$ANS" == "y" || "$ANS" == "Y" ]] || { echo "aborted."; exit 1; }

# Pre-stage the LO browser/dist tree (deploy.sh's Step 2 is incremental;
# without this, fresh PUB trees miss cool.html / editor.html / etc.).
mkdir -p "$PUB/browser"
cp -a "$BUILD_TREE/browser/dist/." "$PUB/browser/"

# Per-stack deploy lock so the two stacks can deploy concurrently.
LOCK_FILE="${LOCK_FILE:-${PUB%/public}.lock}"

BUILD_DIR="$BUILD_TREE" PUB="$PUB" LOCK_FILE="$LOCK_FILE" \
    bash "$REPO_DIR/wasm/deploy.sh" "${PASS_ARGS[@]}"

echo
echo "Smoke through SNI router:"
RELAY_HEALTHZ="${RELAY_URL/wss:/https:}"
RELAY_HEALTHZ="${RELAY_HEALTHZ/ws:/http:}/healthz"
for u in "$FILE_STORAGE_URL/" "$EDITOR_URL/browser/cool.html" "$RELAY_HEALTHZ"; do
    code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$u" || echo 000)"
    printf '  %-60s %s\n' "$u" "$code"
done

echo
echo "[OK] Deployed to $TARGET ($FILE_STORAGE_URL)."
