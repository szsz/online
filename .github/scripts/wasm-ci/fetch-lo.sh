#!/usr/bin/env bash
# Download LibreOffice core artefacts for the pinned LO_BUILD_ID.
#
# Layout we expect at coolwasmfiles ($web container):
#   lo-builds/<LO_BUILD_ID>/MANIFEST.json
#   lo-builds/<LO_BUILD_ID>/lo-core.tar.zst   (instdir + workdir bits + headers + exports)
#
# The artefact is cached on the runner host at $CI_STATE_DIR/lo-cache/<ID>/
# so re-runs on the same ID don't re-download.
set -euo pipefail

# shellcheck source=_lib.sh
source "$(dirname "$0")/_lib.sh"
ensure_storage_key

LO_BID="${LO_BUILD_ID:?LO_BUILD_ID required}"
CACHE_ROOT="${CI_STATE_DIR:?CI_STATE_DIR required}/lo-cache"
DEST="$CACHE_ROOT/$LO_BID"
TARBALL="$DEST/lo-core.tar.zst"

# ── Prune stale lo-cache/<LO_BID> dirs (>7 days old) ──────────
# Each tarball is ~1–2 GB; without cleanup the runner's disk fills up.
# Skip the current LO_BID so a re-run on the same ID never wipes itself.
if [[ -d "$CACHE_ROOT" ]]; then
    find "$CACHE_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +7 \
        ! -name "$LO_BID" -print -exec rm -rf {} + 2>/dev/null || true
fi

mkdir -p "$DEST"

if [[ -f "$DEST/.complete" ]]; then
    echo "[OK] LO build $LO_BID already cached at $DEST"
    exit 0
fi

echo "Downloading lo-builds/$LO_BID/MANIFEST.json …"
az storage blob download \
    --account-name "${AZURE_STORAGE_ACCOUNT:?}" \
    --container-name '$web' \
    --name "lo-builds/$LO_BID/MANIFEST.json" \
    --file "$DEST/MANIFEST.json" \
    --no-progress \
    -o none >/dev/null

echo "Downloading lo-builds/$LO_BID/lo-core.tar.zst …"
az storage blob download \
    --account-name "$AZURE_STORAGE_ACCOUNT" \
    --container-name '$web' \
    --name "lo-builds/$LO_BID/lo-core.tar.zst" \
    --file "$TARBALL" \
    --no-progress \
    -o none >/dev/null

# Sanity-check sha256 from the manifest if present.
EXPECTED_SHA="$(jq -r '.lo_core_tar_sha256 // empty' "$DEST/MANIFEST.json" 2>/dev/null || true)"
if [[ -n "$EXPECTED_SHA" ]]; then
    ACTUAL_SHA="$(sha256sum "$TARBALL" | awk '{print $1}')"
    if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
        echo "ERROR: tarball sha256 mismatch (got $ACTUAL_SHA, manifest says $EXPECTED_SHA)" >&2
        rm -f "$TARBALL"
        exit 1
    fi
fi

touch "$DEST/.complete"
echo "[OK] Cached at $DEST  ($(du -sh "$TARBALL" | cut -f1))"
