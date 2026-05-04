#!/bin/bash
# Fetch a published LibreOffice WASM core build from coolwasmfiles and
# extract it into a per-ID cache dir. Idempotent: a `.complete` marker
# means a previous run already extracted; we just re-export the path.
#
# Usage:
#   bash wasm/fetch-lo-build.sh                # use wasm/LO_BUILD_ID
#   bash wasm/fetch-lo-build.sh 2026-05-03-18  # explicit ID
#   LO_BUILD_ID=2026-05-03-18 bash wasm/fetch-lo-build.sh
#
# Output:
#   prints the extracted path on stdout (suitable for $(…) capture).
#   the path contains `core/` and `core-build/` subdirs that match
#   /lo/core and /lo/core-build inside the build container.
#
# No Azure auth needed — fetches via the public static-website endpoint.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PIN_FILE="$SCRIPT_DIR/LO_BUILD_ID"
STATIC_SITE_BASE="${STATIC_SITE_BASE:-https://coolwasmfiles.z6.web.core.windows.net}"
CACHE_ROOT="${LO_CACHE_ROOT:-$HOME/.cache/lo-builds}"

LO_BID="${1:-${LO_BUILD_ID:-}}"
if [[ -z "$LO_BID" ]]; then
    if [[ ! -f "$PIN_FILE" ]]; then
        echo "ERROR: $PIN_FILE missing and no ID given" >&2
        exit 1
    fi
    LO_BID="$(grep -v '^[[:space:]]*#' "$PIN_FILE" | grep -v '^[[:space:]]*$' | head -1 | tr -d '[:space:]')"
fi

# __LATEST__ resolves against the public static-website endpoint.
if [[ "$LO_BID" == "__LATEST__" ]]; then
    LO_BID="$(curl -fsSL "$STATIC_SITE_BASE/lo-builds/latest.txt" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ -z "$LO_BID" ]]; then
        echo "ERROR: __LATEST__ requested but $STATIC_SITE_BASE/lo-builds/latest.txt is empty/missing" >&2
        exit 1
    fi
fi

DEST="$CACHE_ROOT/$LO_BID"
TARBALL="$DEST/lo-core.tar.zst"
MANIFEST="$DEST/MANIFEST.json"
EXTRACTED="$DEST/extracted"

mkdir -p "$DEST"

if [[ -f "$EXTRACTED/.complete" ]]; then
    echo "[OK] LO build $LO_BID already cached at $EXTRACTED" >&2
    echo "$EXTRACTED"
    exit 0
fi

# Need zstd + jq + sha256sum on the host (NOT inside docker — we extract
# on the host so the build container can bind-mount the result).
for cmd in curl zstd tar sha256sum; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "ERROR: '$cmd' not installed (apt-get install $cmd)" >&2
        exit 1
    fi
done

MANIFEST_URL="$STATIC_SITE_BASE/lo-builds/$LO_BID/MANIFEST.json"
TARBALL_URL="$STATIC_SITE_BASE/lo-builds/$LO_BID/lo-core.tar.zst"

echo "Downloading $MANIFEST_URL …" >&2
if ! curl -fsSL "$MANIFEST_URL" -o "$MANIFEST"; then
    echo "ERROR: $MANIFEST_URL not reachable. Is $LO_BID a valid build?" >&2
    echo "       List available builds: curl -s $STATIC_SITE_BASE/lo-builds/" >&2
    exit 1
fi

echo "Downloading $TARBALL_URL ($(du -sh /dev/null | awk '{print $1}') target) …" >&2
curl -fSL --progress-bar "$TARBALL_URL" -o "$TARBALL"

# Optional sha256 verification from the manifest.
if command -v jq >/dev/null 2>&1; then
    EXPECTED_SHA="$(jq -r '.lo_core_tar_sha256 // empty' "$MANIFEST" 2>/dev/null || true)"
else
    EXPECTED_SHA="$(grep -oE '"lo_core_tar_sha256"[[:space:]]*:[[:space:]]*"[a-f0-9]{64}"' "$MANIFEST" \
                    | grep -oE '[a-f0-9]{64}' || true)"
fi
if [[ -n "$EXPECTED_SHA" ]]; then
    ACTUAL_SHA="$(sha256sum "$TARBALL" | awk '{print $1}')"
    if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
        echo "ERROR: tarball sha256 mismatch (got $ACTUAL_SHA, manifest says $EXPECTED_SHA)" >&2
        rm -f "$TARBALL"
        exit 1
    fi
fi

echo "Extracting to $EXTRACTED …" >&2
rm -rf "$EXTRACTED"
mkdir -p "$EXTRACTED"
tar -I 'zstd -d -T0' -xf "$TARBALL" -C "$EXTRACTED"
touch "$EXTRACTED/.complete"

echo "[OK] LO build $LO_BID ready at $EXTRACTED ($(du -sh "$EXTRACTED" | cut -f1))" >&2
echo "$EXTRACTED"
