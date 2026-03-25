#!/bin/bash
# Upload LO Core build artifacts to Azure Blob Storage.
# Only uploads directories needed for Online linking (~3.3 GB uncompressed).
# Resolves symlinks before packaging (Azure download won't have them).
#
# Usage: bash wasm/azure-upload-core.sh
#
# Azure credentials:
#   Create wasm/.env.uploadblob with a SAS URL for the target blob:
#
#     BLOB_UPLOAD_URL='https://<account>.blob.core.windows.net/<container>/<blob>?<SAS-query-params>'
#
#   Generate a write SAS token via the Azure portal or:
#     az storage blob generate-sas --account-name <account> --container-name <container> \
#       --name <blob> --permissions cw --expiry <date> --full-uri
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTAINER="lo-wasm-server"
STAGING="/tmp/lo-core-upload"
ARCHIVE="/tmp/lo-core-wasm.tar.gz"

# ---------- Load upload SAS ----------
ENV_FILE="$SCRIPT_DIR/.env.uploadblob"
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found. Run: bash wasm/azure-create-sas.sh"
    exit 1
fi
source "$ENV_FILE"

echo "=== Upload LO Core to Azure Blob ==="
echo ""

# ---------- Verify container has a built core ----------
if ! docker exec "$CONTAINER" test -f /lo/core-build/instdir/program/soffice.js 2>/dev/null; then
    echo "ERROR: No LO Core build in container '$CONTAINER'. Run: bash wasm/build-wasm.sh"
    exit 1
fi
echo "[OK] LO Core build found"

# ---------- Extract only needed directories ----------
echo "--- Extracting needed directories from container ---"
rm -rf "$STAGING"
mkdir -p "$STAGING/core" "$STAGING/core-build/workdir"

echo "  core/include (~21 MB)"
docker cp "$CONTAINER:/lo/core/include" "$STAGING/core/include"
echo "  core/static (~400 KB)"
docker cp "$CONTAINER:/lo/core/static" "$STAGING/core/static"
echo "  core-build/instdir (~760 MB)"
docker cp "$CONTAINER:/lo/core-build/instdir" "$STAGING/core-build/instdir"
echo "  core-build/workdir/LinkTarget/StaticLibrary (~79 MB)"
mkdir -p "$STAGING/core-build/workdir/LinkTarget"
docker cp "$CONTAINER:/lo/core-build/workdir/LinkTarget/StaticLibrary" "$STAGING/core-build/workdir/LinkTarget/StaticLibrary"
echo "  core-build/workdir/UnpackedTarball (~2.3 GB)"
docker cp "$CONTAINER:/lo/core-build/workdir/UnpackedTarball" "$STAGING/core-build/workdir/UnpackedTarball"
echo "  core-build/workdir/CustomTarget (~156 MB)"
docker cp "$CONTAINER:/lo/core-build/workdir/CustomTarget" "$STAGING/core-build/workdir/CustomTarget"
echo "[OK] Extraction complete"

# ---------- Remove symlinks (Azure blob won't preserve them anyway) ----------
echo "--- Removing symlinks ---"
COUNT=$(find "$STAGING" -type l | wc -l)
find "$STAGING" -type l -delete
echo "[OK] Removed $COUNT symlinks"

# ---------- Create tar.gz ----------
echo "--- Compressing ---"
tar -czf "$ARCHIVE" -C "$STAGING" core core-build
ARCHIVE_SIZE=$(du -h "$ARCHIVE" | cut -f1)
echo "[OK] $ARCHIVE ($ARCHIVE_SIZE)"

# ---------- Upload to Azure Blob ----------
echo "--- Uploading to Azure ---"
curl -sfS -X PUT \
    -H "x-ms-blob-type: BlockBlob" \
    -H "Content-Type: application/gzip" \
    --data-binary "@$ARCHIVE" \
    "$BLOB_UPLOAD_URL"
echo "[OK] Uploaded"

# ---------- Cleanup ----------
rm -rf "$STAGING" "$ARCHIVE"

echo ""
echo "=== Upload complete ==="
echo "  Developers can now run: bash wasm/build-wasm.sh (choose option 2)"
