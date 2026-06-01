#!/usr/bin/env bash
# build-dist.sh — prepare and upload a minimal Collabora preview deploy
# to Azure Blob Storage (container: contentpreview).
#
# Pipeline:
#   1. Filter   wasm/online-build/browser/dist → wasm/online-build/dist
#               (drop tsbuildinfo, admin/, src/, non-cool root HTMLs)
#   2. Minify   *.js via oxc-minify (in-place)
#   3. Brotli   --best on every file (sidecar .br)
#   4. Upload   to https://<acct>.blob.core.windows.net/contentpreview/
#               collabora-<URL-safe-UTC-timestamp>/...
#               with Content-Encoding: br on every blob.
#
# Usage:
#   wasm/build-dist.sh -a <storage-account>
#   wasm/build-dist.sh --skip-upload                       (steps 1-3 only)
#   wasm/build-dist.sh --skip-build -a <storage-account>   (step 4 only)
#   wasm/build-dist.sh --help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/online-build/browser/dist"
DST="$SCRIPT_DIR/online-build/dist"
CONTAINER="contentpreview"
MINIFY_RUNNER="$SCRIPT_DIR/tools/oxc-minify-runner.js"

usage() {
    cat <<EOF
Usage: $0 [options]

Prepare and upload a minimal Collabora preview deploy to Azure Blob
Storage (container: $CONTAINER).

Options:
  -a, --account <name>   Azure storage account (required unless --skip-upload)
  --skip-upload          Run steps 1-3 only (build/minify/brotli, no upload)
  --skip-build           Skip steps 1-3, upload $DST as-is
  -h, --help             Show this help

Examples:
  $0 -a wasmeditor                        # full pipeline
  $0 --skip-upload                        # local build, no upload
  $0 --skip-build -a wasmeditor           # re-upload existing dist
EOF
}

STORAGE_ACCOUNT=""
SKIP_UPLOAD=""
SKIP_BUILD=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        -a|--account)
            [[ -z "${2:-}" ]] && { echo "ERROR: $1 requires a value" >&2; exit 2; }
            STORAGE_ACCOUNT="$2"
            shift 2
            ;;
        --skip-upload)
            SKIP_UPLOAD=1
            shift
            ;;
        --skip-build)
            SKIP_BUILD=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "ERROR: unknown option: $1" >&2
            echo "Run '$0 --help' for usage." >&2
            exit 2
            ;;
    esac
done

if [[ -n "$SKIP_BUILD" && -n "$SKIP_UPLOAD" ]]; then
    echo "ERROR: --skip-build and --skip-upload together would do nothing." >&2
    exit 2
fi
if [[ -z "$STORAGE_ACCOUNT" && -z "$SKIP_UPLOAD" ]]; then
    echo "ERROR: storage account required. Pass -a <name> or use --skip-upload." >&2
    echo "Run '$0 --help' for usage." >&2
    exit 2
fi

# ── Preflight ────────────────────────────────────────────────────────
if [[ -z "$SKIP_BUILD" ]]; then
    for cmd in node brotli; do
        command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd not on PATH" >&2; exit 1; }
    done
    [[ -d "$SRC" ]] || { echo "ERROR: source dir $SRC not found — build the editor first." >&2; exit 1; }
    [[ -f "$MINIFY_RUNNER" ]] || { echo "ERROR: $MINIFY_RUNNER missing." >&2; exit 1; }
fi
if [[ -z "$SKIP_UPLOAD" ]]; then
    command -v az >/dev/null 2>&1 || { echo "ERROR: az CLI not on PATH" >&2; exit 1; }
    az account show --only-show-errors >/dev/null 2>&1 || {
        echo "ERROR: not logged in to Azure CLI. Run 'az login' first." >&2; exit 1; }
fi
if [[ -n "$SKIP_BUILD" ]]; then
    [[ -d "$DST" ]] || { echo "ERROR: --skip-build set but $DST does not exist — nothing to upload." >&2; exit 1; }
    if ! find "$DST" -type f -print -quit | grep -q .; then
        echo "ERROR: --skip-build set but $DST is empty." >&2; exit 1
    fi
fi

STAMP=$(date -u +"%Y-%m-%dT%H-%M-%SZ")
BLOB_PREFIX="collabora-$STAMP"

echo "=== build-dist: $BLOB_PREFIX ==="
[[ -n "$SKIP_BUILD" ]] && echo "  source:  $DST (--skip-build, using pre-built staging)" || \
    echo "  source:  $SRC"
echo "  staging: $DST"
[[ -n "$SKIP_UPLOAD" ]] && echo "  upload:  SKIPPED" || \
    echo "  upload:  https://$STORAGE_ACCOUNT.blob.core.windows.net/$CONTAINER/$BLOB_PREFIX/"
echo ""

if [[ -n "$SKIP_BUILD" ]]; then
    echo "=== Steps 1-3/4 SKIPPED (--skip-build) ==="
    echo ""
else

# ── Step 1: Filter ───────────────────────────────────────────────────
echo "=== Step 1/4: Filter ==="
rm -rf "$DST"
mkdir -p "$DST"
# cp -a preserves perms/symlinks/mtimes — matters for deterministic
# brotli output (modtime doesn't affect content, but keeps diffs sane).
cp -a "$SRC/." "$DST/"

# Hardcoded prune list. Anything not in here survives.
DROP=(
    "tsconfig.tsbuildinfo"
    "src"
    "admin"
    "admin-bundle.js"
    "adminIntegratorSettings.html"
    "cool-help.html"
    "debug.html"
    "editor.html"
    "framed.doc.html"
    "framed.html"
    "load.doc.html"
    "multidocs.html"
    "wasm.html"
)
DROPPED=0
for entry in "${DROP[@]}"; do
    target="$DST/$entry"
    if [[ -e "$target" ]]; then
        echo "  removed: $entry"
        rm -rf "$target"
        DROPPED=$((DROPPED + 1))
    fi
done
KEPT_FILES=$(find "$DST" -type f | wc -l | tr -d ' ')
KEPT_SIZE=$(du -sh "$DST" | cut -f1)
echo "  Filter: dropped $DROPPED entries, kept $KEPT_FILES files ($KEPT_SIZE)"

# Append wasm/custom.css to bundle.css — WASM-specific overrides that
# hide UI affordances (download-as, repair, view-mode, …) that aren't
# functional in the editor's wasm runtime.
CUSTOM_CSS="$SCRIPT_DIR/custom.css"
BUNDLE_CSS="$DST/bundle.css"
if [[ -f "$CUSTOM_CSS" && -f "$BUNDLE_CSS" ]]; then
    printf '\n' >> "$BUNDLE_CSS"
    cat "$CUSTOM_CSS" >> "$BUNDLE_CSS"
    echo "  Appended $(basename "$CUSTOM_CSS") to bundle.css"
elif [[ ! -f "$CUSTOM_CSS" ]]; then
    echo "  WARNING: $CUSTOM_CSS not found, skipping custom-CSS append" >&2
else
    echo "  WARNING: $BUNDLE_CSS not found, skipping custom-CSS append" >&2
fi

# Inject local-loader.js — "open one local file in iframe" bootstrap.
# No-op when ?localFileId= is absent, so the regular collaboration
# flow served by COOLWSD is unaffected. Shipping as an external file
# lets Step 2 minify it and Step 3 brotli it like every other asset.
LOCAL_LOADER="$SCRIPT_DIR/local-loader.js"
COOL_HTML="$DST/cool.html"
if [[ -f "$LOCAL_LOADER" && -f "$COOL_HTML" ]]; then
    cp "$LOCAL_LOADER" "$DST/local-loader.js"
    # Insert <script src="local-loader.js" defer> before the existing
    # emscripten-module.js line. Deferred scripts run in DOM order, so
    # the loader executes before emscripten-module.js / bundle.js call
    # createOnlineModule. awk (not sed) for BSD/GNU portability. The
    # !done guard is idempotent if the matched line ever duplicates.
    awk '
        /<script src="emscripten-module\.js" defer><\/script>/ && !done {
            print "  <script src=\"local-loader.js\" defer></script>"
            done = 1
        }
        { print }
    ' "$COOL_HTML" > "$COOL_HTML.tmp" && mv "$COOL_HTML.tmp" "$COOL_HTML"
    echo "  Injected local-loader.js into cool.html"
elif [[ ! -f "$LOCAL_LOADER" ]]; then
    echo "  WARNING: $LOCAL_LOADER not found, skipping local-loader injection" >&2
else
    echo "  WARNING: $COOL_HTML not found, skipping local-loader injection" >&2
fi
echo ""

# ── Step 2: Minify JS ────────────────────────────────────────────────
echo "=== Step 2/4: Minify JS (oxc-minify) ==="
# Single Node invocation amortises the ~150ms module load over all
# files. Limit argv length: macOS getconf ARG_MAX is ~256K — a few
# hundred path strings fit comfortably under that. If the editor ever
# emits 10k+ JS files we'd need to batch.
find "$DST" -type f -name '*.js' -print0 | \
    xargs -0 node "$MINIFY_RUNNER"
echo ""

# ── Step 3: Brotli --best ────────────────────────────────────────────
echo "=== Step 3/4: Brotli (--best, q=11) ==="
# Per-file logging plus running totals. Sequential (deterministic
# ordering, simpler logging) — the wasm/data files are CPU-bound
# single-thread anyway, so parallelism wouldn't help much.
#
# Files keep their ORIGINAL names — we compress to a temp, then swap
# the original in place. Step 4 uploads these with Content-Encoding: br
# so clients decompress transparently.

# stat byte size — macOS uses -f %z, GNU coreutils uses -c %s.
if stat -f %z / >/dev/null 2>&1; then
    statbytes() { stat -f %z "$1"; }
else
    statbytes() { stat -c %s "$1"; }
fi

human() {
    local n=$1
    if   (( n >= 1048576 )); then printf "%.1fM" "$(echo "$n 1048576" | awk '{print $1/$2}')"
    elif (( n >= 1024 ));    then printf "%.1fK" "$(echo "$n 1024"    | awk '{print $1/$2}')"
    else                          printf "%dB" "$n"
    fi
}

TOTAL_BEFORE=0
TOTAL_AFTER=0
BR_COUNT=0
while IFS= read -r -d '' src; do
    before=$(statbytes "$src")
    tmp="$src.br.tmp.$$"
    brotli -Z -f "$src" -o "$tmp"
    after=$(statbytes "$tmp")
    mv -f "$tmp" "$src"
    TOTAL_BEFORE=$((TOTAL_BEFORE + before))
    TOTAL_AFTER=$((TOTAL_AFTER + after))
    BR_COUNT=$((BR_COUNT + 1))
    rel="${src#$DST/}"
    pct=$(awk -v b="$before" -v a="$after" 'BEGIN { if (b > 0) printf "%.1f", (1 - a/b) * 100; else print "0.0" }')
    printf "  %-62s %7s → %7s (-%s%%)\n" "$rel" "$(human "$before")" "$(human "$after")" "$pct"
done < <(find "$DST" -type f -print0)

SUMMARY_PCT=$(awk -v b="$TOTAL_BEFORE" -v a="$TOTAL_AFTER" 'BEGIN { if (b > 0) printf "%.1f", (1 - a/b) * 100; else print "0.0" }')
echo ""
echo "  Brotli summary: $(human "$TOTAL_BEFORE") → $(human "$TOTAL_AFTER")  (-${SUMMARY_PCT}%)  across $BR_COUNT files"
echo ""

fi  # end --skip-build guard

# ── Step 4: Upload ───────────────────────────────────────────────────
if [[ -n "$SKIP_UPLOAD" ]]; then
    echo "=== Step 4/4: Upload SKIPPED (--skip-upload) ==="
    echo "Staging dir ready: $DST"
    exit 0
fi

echo "=== Step 4/4: Upload to Azure ==="

# MIME map mirrors deploy-front-door.sh:311-327 with one override
# requested by the user: *.metadata → application/json (the
# soffice.data.js.metadata file is JSON and Azure can't infer that
# from the extension).
mime_for() {
    case "$1" in
        *.html)        echo "text/html; charset=utf-8" ;;
        *.css)         echo "text/css; charset=utf-8" ;;
        *.js)          echo "application/javascript; charset=utf-8" ;;
        *.wasm)        echo "application/wasm" ;;
        *.json)        echo "application/json" ;;
        *.metadata)    echo "application/json" ;;
        *.data)        echo "application/octet-stream" ;;
        *.tar.gz|*.gz) echo "application/gzip" ;;
        *.svg)         echo "image/svg+xml" ;;
        *.png)         echo "image/png" ;;
        *.jpg|*.jpeg)  echo "image/jpeg" ;;
        *.gif)         echo "image/gif" ;;
        *.ico)         echo "image/x-icon" ;;
        *.woff)        echo "font/woff" ;;
        *.woff2)       echo "font/woff2" ;;
        *.ttf)         echo "font/ttf" ;;
        *.otf)         echo "font/otf" ;;
        *.txt)         echo "text/plain; charset=utf-8" ;;
        *.xml)         echo "application/xml" ;;
        *.odp)         echo "application/vnd.oasis.opendocument.presentation" ;;
        *.ods)         echo "application/vnd.oasis.opendocument.spreadsheet" ;;
        *.odt)         echo "application/vnd.oasis.opendocument.text" ;;
        *.odg)         echo "application/vnd.oasis.opendocument.graphics" ;;
        *)             echo "application/octet-stream" ;;
    esac
}

upload_one() {
    local src="$1"
    local rel="${src#$DST/}"
    local blob_name="$BLOB_PREFIX/$rel"
    local ct
    ct="$(mime_for "$rel")"
    az storage blob upload \
        --auth-mode login \
        --account-name "$STORAGE_ACCOUNT" \
        --container-name "$CONTAINER" \
        --name "$blob_name" \
        --file "$src" \
        --content-type "$ct" \
        --content-encoding "br" \
        --overwrite \
        --no-progress \
        --only-show-errors > /dev/null
}

export DST BLOB_PREFIX STORAGE_ACCOUNT CONTAINER
export -f mime_for upload_one

# Exclude orphaned `*.br.tmp.*` files left behind by interrupted brotli
# passes — they're stale, partially-written compressed bytes that must
# not be served.
BLOB_TOTAL=$(find "$DST" -type f ! -name '*.br.tmp.*' | wc -l | tr -d ' ')
echo "  Uploading $BLOB_TOTAL blobs in parallel (-P 8) with Content-Encoding: br..."
find "$DST" -type f ! -name '*.br.tmp.*' -print0 | \
    xargs -0 -n1 -P 8 -I{} bash -c 'upload_one "$@"' _ {}

echo ""
echo "Upload complete."
echo "  https://$STORAGE_ACCOUNT.blob.core.windows.net/$CONTAINER/$BLOB_PREFIX/cool.html"
