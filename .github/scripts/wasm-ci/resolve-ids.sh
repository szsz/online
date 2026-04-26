#!/usr/bin/env bash
# Resolve APP_BUILD_ID and LO_BUILD_ID for this CI run, write to GITHUB_OUTPUT.
#
# Inputs (env):
#   LO_BUILD_ID_OVERRIDE  — optional manual override (workflow_dispatch input)
#   GH_RUN_NUMBER         — github.run_number
#
# wasm/LO_BUILD_ID is the source of truth when no override is given.
# The literal token __LATEST__ in that file means "follow lo-builds/latest.txt
# in the storage account" — useful early on, but for reproducibility devs
# should pin to a real ID.
set -euo pipefail

# shellcheck source=_lib.sh
source "$(dirname "$0")/_lib.sh"
ensure_storage_key

APP_BUILD_ID="$(date -u +%Y-%m-%d)-${GH_RUN_NUMBER}"

LO_BID="${LO_BUILD_ID_OVERRIDE:-}"
if [[ -z "$LO_BID" ]]; then
    if [[ ! -f wasm/LO_BUILD_ID ]]; then
        echo "ERROR: wasm/LO_BUILD_ID file not found" >&2
        exit 1
    fi
    LO_BID="$(grep -v '^[[:space:]]*#' wasm/LO_BUILD_ID | grep -v '^[[:space:]]*$' | head -1 | tr -d '[:space:]')"
fi

if [[ "$LO_BID" == "__LATEST__" ]]; then
    echo "Resolving __LATEST__ against lo-builds/latest.txt …"
    # `az storage blob download --file -` writes the blob payload to stdout AND
    # the operation metadata JSON to stdout, concatenated. Capturing via $(...)
    # used to make LO_BID become the metadata JSON, then propagate downstream
    # as a giant path. Download to a temp file and read its contents.
    TMP_LATEST="$(mktemp)"
    az storage blob download \
        --account-name "${AZURE_STORAGE_ACCOUNT:?}" \
        --container-name '$web' \
        --name 'lo-builds/latest.txt' \
        --file "$TMP_LATEST" \
        --no-progress \
        -o none >/dev/null 2>&1 || true
    LO_BID="$(tr -d '[:space:]' < "$TMP_LATEST" 2>/dev/null || true)"
    rm -f "$TMP_LATEST"
    if [[ -z "$LO_BID" ]]; then
        echo "ERROR: __LATEST__ requested but lo-builds/latest.txt is empty or unreachable." >&2
        echo "       Either run a libreoffice-core-wasm CI build first, or pin a literal ID in wasm/LO_BUILD_ID." >&2
        exit 1
    fi
fi

echo "APP_BUILD_ID = $APP_BUILD_ID"
echo "LO_BUILD_ID  = $LO_BID"
{
    echo "app_build_id=$APP_BUILD_ID"
    echo "lo_build_id=$LO_BID"
} >> "$GITHUB_OUTPUT"
