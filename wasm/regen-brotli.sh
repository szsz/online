#!/usr/bin/env bash
# Regenerate online.{js,wasm}.br + bundle.js.br atomically from the
# currently-live /tmp/static-deploy/public/browser/ files.
#
# Why this script exists:
#   Running `brotli -f file -o file.br` directly against the live dir
#   while editor-static-server is serving requests can produce a
#   truncated .br file mid-write — clients then download a half-formed
#   wasm and crash with "code section extends past end of the module".
#   This script writes to a temp file in the same dir and rename(2)s
#   into place, which is atomic.
#
# Why not just always run deploy.sh?
#   deploy.sh refreshes the WHOLE deploy (snapshot injection, dict
#   bundles, hashes). When you only need to regen .br (e.g., after a
#   --no-brotli iteration), this is faster.
#
# Usage:
#   bash wasm/regen-brotli.sh             # default: brotli -q 11 (deploy quality)
#   QUALITY=4 bash wasm/regen-brotli.sh   # faster, ~10% bigger output

set -euo pipefail

PUB="${PUB:-/tmp/static-deploy/public}"
BROWSER_DIR="$PUB/browser"
QUALITY="${QUALITY:-11}"
LOCK_FILE="${LOCK_FILE:-/tmp/online-deploy.lock}"

# Same lock as deploy.sh — these MUST NOT race.
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
    echo "ERROR: deploy.sh or another regen-brotli.sh holds $LOCK_FILE" >&2
    exit 1
fi

cd "$BROWSER_DIR"

for src in online.js online.wasm bundle.js; do
    [ -f "$src" ] || continue
    tmp="$src.br.$$"
    echo -n "  Compressing $src → $src.br (q=$QUALITY)..."
    brotli -f -q "$QUALITY" "$src" -o "$tmp"
    # Verify decompressed bytes match before moving into place
    src_bytes=$(stat -c %s "$src")
    decomp_bytes=$(brotli -d -c "$tmp" | wc -c)
    if [ "$src_bytes" != "$decomp_bytes" ]; then
        echo " FAILED ($decomp_bytes vs $src_bytes bytes)" >&2
        rm -f "$tmp"
        exit 1
    fi
    mv -fT "$tmp" "$src.br"
    echo " $(du -h "$src.br" | cut -f1) ✓"
done

echo "regen-brotli: all .br files atomically updated."
