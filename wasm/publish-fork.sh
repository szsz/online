#!/usr/bin/env bash
# Publish the host's local wasm-coediting branch to the GitHub fork as an
# orphan-rooted snapshot. GitHub's fsck rejects upstream LO history (a few
# old commits have malformed author lines), so the fork carries a flattened
# history: one snapshot commit of upstream master + the WASM patches on top.
#
# Workflow:
#   1. Edit on $HOME/libreoffice-core-wasm (full upstream history; rebase
#      against upstream/master normally).
#   2. Run this script.
#   3. Run wasm/build-wasm.sh (fetches the new tip from GitHub).
#
# Usage:
#   bash wasm/publish-fork.sh                 # publish current wasm-coediting
#   bash wasm/publish-fork.sh --dry-run       # show what would happen, don't push
#
# Env:
#   LO_CORE_HOST_DIR  default: $HOME/libreoffice-core-wasm
#   FORK_REMOTE       default: fork

set -euo pipefail

LO_CORE_HOST_DIR="${LO_CORE_HOST_DIR:-$HOME/libreoffice-core-wasm}"
FORK_REMOTE="${FORK_REMOTE:-fork}"
DRY_RUN=false
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
    esac
done

if [ ! -d "$LO_CORE_HOST_DIR/.git" ]; then
    echo "ERROR: $LO_CORE_HOST_DIR is not a git checkout" >&2
    exit 1
fi

cd "$LO_CORE_HOST_DIR"

# How many commits ahead of upstream master is wasm-coediting?
N_PATCHES=$(git rev-list --count upstream/master..wasm-coediting 2>/dev/null || echo 0)
if [ "$N_PATCHES" = "0" ]; then
    echo "ERROR: wasm-coediting has no commits beyond upstream/master" >&2
    exit 1
fi

PARENT_BASE=$(git rev-parse "wasm-coediting~$N_PATCHES")
TIP=$(git rev-parse wasm-coediting)
echo "  wasm-coediting tip:    $TIP"
echo "  base (upstream parent): $PARENT_BASE"
echo "  patches to publish:    $N_PATCHES"
echo ""
git log --oneline "$PARENT_BASE..wasm-coediting"
echo ""

if [ "$DRY_RUN" = true ]; then
    echo "(dry-run; nothing pushed)"
    exit 0
fi

# Build the orphan-rooted form on a scratch branch
SCRATCH="wasm-coediting-flat"
git branch -D "$SCRATCH" 2>/dev/null || true
git checkout "$PARENT_BASE" --quiet
git checkout --orphan "$SCRATCH"
git commit -m "Snapshot of upstream LibreOffice/core master @ ${PARENT_BASE}" --quiet
echo "  orphan snapshot commit: $(git rev-parse HEAD)"
git cherry-pick "${PARENT_BASE}..${TIP}" --quiet
echo "  cherry-picked $N_PATCHES commits onto orphan"
echo ""

# Force-push the scratch as wasm-coediting on the fork
echo "  pushing $SCRATCH:wasm-coediting to $FORK_REMOTE…"
git push -f "$FORK_REMOTE" "$SCRATCH:wasm-coediting"

# Restore wasm-coediting as the active branch on disk
git checkout wasm-coediting --quiet

echo ""
echo "Published. Build pipeline will pull this on next run."
