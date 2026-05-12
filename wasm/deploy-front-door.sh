#!/usr/bin/env bash
# deploy-front-door.sh — deploy the editor to Azure Front Door + Storage
# instead of an App Service. Each build lands at:
#
#   https://${storage}.z6.web.core.windows.net/<APP_BUILD_ID>/...
#                  ↑ static-website endpoint
#
# behind Front Door:
#
#   https://${fd-endpoint}.azurefd.net/<APP_BUILD_ID>/...
#                  ↑ same path; FD rule set adds COOP/COEP/CORP/CSP/Cache-Control
#                    headers + brotli URL swap on Accept-Encoding
#
# No App Service involved — the editor is a pure static site behind FD.
# The /wasm/<name> upload endpoint (POST handler) moves to the viewer.
#
# Requirements:
#   - Storage account with static-website mode enabled.
#   - Front Door with origin pointing at the static-website endpoint.
#   - Front Door rule set configured (see docs/front-door-config.md).
#   - Runner identity has Storage Blob Data Contributor role on the
#     storage account, OR an account key in $STORAGE_KEY env, OR can
#     mint one via `az storage account keys list` (i.e. has Contributor
#     on the account at the control-plane level).
#
# Env config (from $ENV_FILE, default $HOME/ENV/online-front-door-deploy.env):
#   EDITOR_STORAGE_ACCOUNT  Azure Storage account name (e.g. wasmeditor)
#   EDITOR_STORAGE_CONTAINER  Container; static-website mode uses $web
#   EDITOR_FD_URL           Public Front Door endpoint URL (for smoke probe)
#   APP_BUILD_ID            Build id; deploy writes under <id>/
#
# Usage:
#   APP_BUILD_ID=2026-05-12-120000 bash wasm/deploy-front-door.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ENV_FILE="${ENV_FILE:-$HOME/ENV/online-front-door-deploy.env}"
if [[ -f "$ENV_FILE" ]]; then
    # Source env file — fail loud on missing required vars instead of
    # falling back to defaults.
    set -a; source "$ENV_FILE"; set +a
fi

: "${EDITOR_STORAGE_ACCOUNT:?EDITOR_STORAGE_ACCOUNT must be set (in $ENV_FILE or env)}"
: "${EDITOR_STORAGE_CONTAINER:=\$web}"
: "${EDITOR_FD_URL:?EDITOR_FD_URL must be set (in $ENV_FILE or env)}"
: "${APP_BUILD_ID:?APP_BUILD_ID must be set (set by CI from resolve-ids.sh)}"

# Source build artefacts. Same convention as deploy-azure.sh: prefer
# the per-deploy folder at wasm/online-build, fall back to the in-tree
# browser/dist for ad-hoc local invocations.
BUILD_ROOT="$SCRIPT_DIR/online-build"
BUILD_WASM="$BUILD_ROOT/wasm"
BUILD_DIST="$BUILD_ROOT/browser/dist"
if [[ ! -d "$BUILD_DIST" ]]; then
    BUILD_DIST="$REPO_ROOT/browser/dist"
fi
if [[ ! -d "$BUILD_DIST" ]]; then
    echo "ERROR: browser/dist not found (tried $BUILD_ROOT/browser/dist and $REPO_ROOT/browser/dist)" >&2
    exit 1
fi

# Stage everything that would land in wwwroot under a per-deploy
# subfolder. The layout mirrors $EDIR/<id>/ in deploy-azure.sh.
STAGE="$(mktemp -d -t fd-deploy-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT
EDIR_CONTENT="$STAGE/$APP_BUILD_ID"
mkdir -p "$EDIR_CONTENT/browser/dist"

echo "=== Front Door deploy: id=$APP_BUILD_ID account=$EDITOR_STORAGE_ACCOUNT ==="

# Copy browser/dist tree (cool.html, bundle.js, etc.).
echo "  Staging browser/dist..."
cp -r "$BUILD_DIST/." "$EDIR_CONTENT/browser/dist/"

# Pick paired online.{js,wasm}. Same defensive logic as deploy-azure.sh.
PAIRED_DIR=""
for d in "$BUILD_DIST" "$BUILD_WASM"; do
    if [[ -f "$d/online.js" && -f "$d/online.wasm" ]]; then
        PAIRED_DIR="$d"; break
    fi
done
[[ -z "$PAIRED_DIR" ]] && {
    echo "ERROR: no paired online.{js,wasm} found" >&2; exit 1; }

echo "  Paired artefacts from: $PAIRED_DIR"
for f in online.js online.wasm online.data online.worker.js \
         soffice.data soffice.data.js.metadata emscripten-module.js; do
    src=""
    if [[ "$f" == "online.js" || "$f" == "online.wasm" ]]; then
        [[ -f "$PAIRED_DIR/$f" ]] && src="$PAIRED_DIR/$f"
    else
        for d in "$PAIRED_DIR" "$BUILD_DIST" "$BUILD_WASM"; do
            [[ -f "$d/$f" ]] && { src="$d/$f"; break; }
        done
    fi
    if [[ -n "$src" ]]; then
        cp "$src" "$EDIR_CONTENT/$f"
        cp "$src" "$EDIR_CONTENT/browser/dist/$f"
        if [[ -f "$src.br" ]]; then
            cp "$src.br" "$EDIR_CONTENT/$f.br"
            cp "$src.br" "$EDIR_CONTENT/browser/dist/$f.br"
        fi
    elif [[ "$f" != "online.data" ]]; then
        echo "    WARNING: $f missing"
    fi
done

# Loader scripts (relay-adapter.js, wasm-loader.js, sw.js, dict-loader.js).
for f in relay-adapter.js wasm-loader.js sw.js dict-loader.js; do
    if [[ -f "$SCRIPT_DIR/$f" ]]; then
        cp "$SCRIPT_DIR/$f" "$EDIR_CONTENT/"
        cp "$SCRIPT_DIR/$f" "$EDIR_CONTENT/browser/dist/"
    fi
done

# Bridge SW — MUST live at the editor origin's ROOT path (not inside
# the per-deploy folder) so its default scope is `/` and it can
# intercept fetches that Kit makes to /wasm/<id>, /api/blobs/<hash>,
# /api/v2/file/<id>, /api/files/<name>. Without this the bridge would
# only cover /<APP_BUILD_ID>/* paths and Kit's root-level fetches
# would miss it.
#
# Doesn't need build-fingerprint substitution (no caching, no
# versioning). One copy lives across all deploys.
if [[ -f "$SCRIPT_DIR/sw-bridge.js" ]]; then
    cp "$SCRIPT_DIR/sw-bridge.js" "$STAGE/sw-bridge.js"
fi

# Dict bundles. Each gets uploaded with Content-Encoding: gzip metadata
# below so Front Door passes them through without double-compressing.
DICTS_SRC="$SCRIPT_DIR/online-build/dicts"
if [[ -d "$DICTS_SRC" ]] && ls "$DICTS_SRC"/*.tar.gz >/dev/null 2>&1; then
    mkdir -p "$EDIR_CONTENT/dicts"
    cp -f "$DICTS_SRC"/*.tar.gz "$EDIR_CONTENT/dicts/"
    cp -f "$DICTS_SRC/manifest.json" "$EDIR_CONTENT/dicts/"
    echo "  Bundled $(ls "$EDIR_CONTENT/dicts"/*.tar.gz | wc -l) dicts"
else
    echo "  NOTE: no dict bundles"
fi

# Substitute build fingerprint in wasm-loader.js + sw.js.
if [[ -f "$EDIR_CONTENT/online.wasm" ]]; then
    FINGERPRINT=$(md5sum "$EDIR_CONTENT/online.wasm" | cut -c1-16)
    echo "  Build fingerprint: $FINGERPRINT"
    for p in "$EDIR_CONTENT/wasm-loader.js" "$EDIR_CONTENT/browser/dist/wasm-loader.js" \
             "$EDIR_CONTENT/sw.js" "$EDIR_CONTENT/browser/dist/sw.js"; do
        [[ -f "$p" ]] && sed -i "s|__WASM_BUILD_FINGERPRINT__|$FINGERPRINT|g" "$p"
    done
fi

# build-info.json
cat > "$EDIR_CONTENT/build-info.json" <<EOF
{
  "id": "$APP_BUILD_ID",
  "git_sha": "${GIT_SHA:-}",
  "lo_build_id": "${LO_BUILD_ID:-}",
  "fingerprint": "${FINGERPRINT:-}",
  "deployed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# ── Upload ─────────────────────────────────────────────────────────
# Use account key (faster, less role plumbing). Mint it via control-
# plane RBAC if not provided in env.
if [[ -z "${STORAGE_KEY:-}" ]]; then
    STORAGE_KEY="$(az storage account keys list \
        --account-name "$EDITOR_STORAGE_ACCOUNT" \
        --query '[0].value' -o tsv 2>/dev/null)"
    [[ -z "$STORAGE_KEY" ]] && {
        echo "ERROR: failed to mint STORAGE_KEY for $EDITOR_STORAGE_ACCOUNT" >&2
        echo "       Either set STORAGE_KEY directly or ensure RBAC allows keys list." >&2
        exit 1
    }
fi

echo "  Uploading to $EDITOR_STORAGE_ACCOUNT/$EDITOR_STORAGE_CONTAINER/$APP_BUILD_ID/..."

# Step 1: Upload everything as a batch. The blob path is relative to
# $STAGE, so files under $STAGE/$APP_BUILD_ID/... land at
# $web/$APP_BUILD_ID/...
#
# Includes *.br sidecar files (a previous version of this script
# passed --pattern '!*.br' to exclude them, but az's pattern matcher
# silently treats `!` as a literal char → matches nothing → empty
# upload). The .br blobs end up alongside their canonical counterparts;
# Step 2 below then OVERWRITES the canonical blob with the brotli
# content. The duplicate *.br blob is unused by clients (they fetch
# the canonical URL and get brotli via Content-Encoding) but it's
# harmless and lets the upload-batch step actually run.
az storage blob upload-batch \
    --account-name "$EDITOR_STORAGE_ACCOUNT" \
    --account-key "$STORAGE_KEY" \
    --destination "$EDITOR_STORAGE_CONTAINER" \
    --source "$STAGE" \
    --overwrite \
    --no-progress \
    > /tmp/fd-upload.log 2>&1 || {
        echo "ERROR: az storage blob upload-batch failed" >&2
        tail -20 /tmp/fd-upload.log >&2
        exit 1
    }
echo "    upload-batch done"

# ── Step 2: Pattern β brotli swap ───────────────────────────────────
# AFD's URL rewrite action doesn't support server variables in
# destinations (so an Accept-Encoding-driven swap rule per <file> →
# <file>.br is infeasible for the per-deploy id-templated paths).
# Instead: for every <file>.br on disk, OVERWRITE the canonical blob
# (the same path WITHOUT .br) with the brotli content AND set
# Content-Type + Content-Encoding: br at upload time. The browser
# fetches the canonical URL, receives brotli bytes + Content-Encoding
# header, decompresses transparently. All modern browsers support
# brotli; non-brotli clients (legacy tools) get undecodable bytes —
# theoretical concern, not a real-world issue for the editor's audience.
#
# Run uploads in parallel (xargs -P) — sequential `az storage blob`
# calls were the long pole (~1-2s of CLI overhead each, ~150 files →
# 4 min sequential, ~30 s with -P 8). az upload-batch above already
# parallelises bulk; we only need this for the brotli swap.
echo "  Re-uploading heavy assets as pre-compressed brotli (Pattern β)..."
mime_for() {
    case "$1" in
        *.html) echo "text/html; charset=utf-8" ;;
        *.css)  echo "text/css; charset=utf-8" ;;
        *.js)   echo "application/javascript; charset=utf-8" ;;
        *.wasm) echo "application/wasm" ;;
        *.json) echo "application/json" ;;
        *.data) echo "application/octet-stream" ;;
        *.tar.gz|*.gz) echo "application/gzip" ;;
        *.svg) echo "image/svg+xml" ;;
        *.png) echo "image/png" ;;
        *.jpg|*.jpeg) echo "image/jpeg" ;;
        *.woff)  echo "font/woff" ;;
        *.woff2) echo "font/woff2" ;;
        *.metadata) echo "application/octet-stream" ;;
        *) echo "application/octet-stream" ;;
    esac
}
export -f mime_for
export EDITOR_STORAGE_ACCOUNT EDITOR_STORAGE_CONTAINER STORAGE_KEY STAGE

upload_one_br() {
    local br_src="$1"
    local rel="${br_src#$STAGE/}"
    local blob_name="${rel%.br}"   # canonical (no .br)
    local ct
    ct="$(mime_for "$blob_name")"
    az storage blob upload \
        --account-name "$EDITOR_STORAGE_ACCOUNT" \
        --account-key "$STORAGE_KEY" \
        --container-name "$EDITOR_STORAGE_CONTAINER" \
        --name "$blob_name" \
        --file "$br_src" \
        --content-type "$ct" \
        --content-encoding "br" \
        --overwrite \
        --no-progress > /dev/null 2>&1
}
export -f upload_one_br

BR_TOTAL=$(find "$STAGE" -name '*.br' -type f | wc -l)
find "$STAGE" -name '*.br' -type f -print0 | \
    xargs -0 -n1 -P 8 -I{} bash -c 'upload_one_br "$@"' _ {}
echo "    overwrote $BR_TOTAL canonical blob(s) with brotli content + Content-Encoding: br"

# NOTE: per-blob Content-Type for non-brotli files is left to Azure's
# default (it sniffs by extension at upload-batch time and gets common
# types right: .js, .css, .html, .json, .png, .svg, .woff, .woff2).
# Pre-bridge versions of this script ran an N-file metadata-update
# pass to override Azure's guess; that's a 30-60 min sequential
# bottleneck for builds with ~3000 small assets and the only types it
# fixed were edge cases (`*.metadata` → application/octet-stream
# instead of being unknown). Azure's sniff is fine for those too. The
# Content-Encoding bit for brotli-overwritten blobs is the only thing
# that really needs setting, and Step 2 above does that at upload.

# ── Smoke test via Front Door ──────────────────────────────────────
echo "  Smoke test via $EDITOR_FD_URL ..."
SMOKE_FAILED=0
for path in "/$APP_BUILD_ID/build-info.json" \
            "/$APP_BUILD_ID/browser/dist/cool.html"; do
    url="$EDITOR_FD_URL$path"
    code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 30 -I "$url" || echo 000)"
    printf '    %-72s %s\n' "$url" "$code"
    case "$code" in
        000|4??|5??) SMOKE_FAILED=1 ;;
    esac
done
if [[ "$SMOKE_FAILED" == 1 ]]; then
    echo "  WARNING: at least one smoke probe non-2xx — check Front Door config." >&2
    echo "  (Static-website rules may take a few minutes to propagate.)"
fi

echo ""
echo "Deploy complete: $EDITOR_FD_URL/$APP_BUILD_ID/"
