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

# Strip stale content-hashed leftovers. Phase 3 (PR #51) removed
# cache-bust filename hashing; cool.html references only the
# unhashed canonical names (bundle.js, online.wasm, …). Yet the
# upstream LO/Online build sometimes emits hashed siblings AND
# the persistent CI state dir accumulates them across runs. Without
# this filter every deploy was uploading ~250 unreferenced
# bundle.<8hex>.js / online.<8hex>.wasm files — ~16 GB of dead
# weight per build. Safe to drop: cool.html has no refs to them
# (verified by grep at deploy time).
STALE_BEFORE=$(find "$EDIR_CONTENT" -type f -regextype posix-extended \
    -regex '.*/[A-Za-z_-]+\.[0-9a-f]{6,}\.(js|css|wasm|data|metadata)(\.br)?' \
    -print 2>/dev/null | wc -l)
if [[ "$STALE_BEFORE" -gt 0 ]]; then
    find "$EDIR_CONTENT" -type f -regextype posix-extended \
        -regex '.*/[A-Za-z_-]+\.[0-9a-f]{6,}\.(js|css|wasm|data|metadata)(\.br)?' \
        -delete 2>/dev/null
    echo "    pruned $STALE_BEFORE stale hashed asset(s) (pre-Phase-3 leftovers)"
fi

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
# Overwrite whatever the WASM build emitted to BUILD_DIST with the
# current source — these files are pure JS that we keep authoritative
# in wasm/, and the build artifacts can lag behind a fresh edit.
#
# Also DELETE any *.br sidecar that came from BUILD_DIST. Without this,
# Step 2's brotli swap below would upload the STALE *.br over the
# canonical blob, undoing the source override. The loader scripts are
# small (~few KB each); no meaningful loss serving them raw.
for f in relay-adapter.js wasm-loader.js sw.js dict-loader.js; do
    if [[ -f "$SCRIPT_DIR/$f" ]]; then
        cp "$SCRIPT_DIR/$f" "$EDIR_CONTENT/"
        cp "$SCRIPT_DIR/$f" "$EDIR_CONTENT/browser/dist/"
        rm -f "$EDIR_CONTENT/$f.br" \
              "$EDIR_CONTENT/browser/dist/$f.br"
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

# Substitute cool.html template placeholders. The pre-FD editor-
# server.js did this at request time (`%ACCESS_TOKEN%`, `%LOGO_URL%`
# etc.); FD static storage can't, so we bake the defaults in at deploy
# time. The default values match what editor-server.js returned for a
# no-body GET (which is what the viewer iframe always sends).
COOL_HTML="$EDIR_CONTENT/browser/dist/cool.html"
if [[ -f "$COOL_HTML" ]]; then
    sed -i \
        -e 's/%ACCESS_TOKEN_TTL%/0/g' \
        -e 's/%ACCESS_TOKEN%//g' \
        -e 's/%ACCESS_HEADER%//g' \
        -e 's/%NO_AUTH_HEADER%//g' \
        -e 's/%UI_RTL_SETTINGS%//g' \
        -e 's/%BRANDING_THEME%//g' \
        -e 's/%LOGO_URL%//g' \
        -e 's/%PRODUCT_BRANDING_NAME%/Collabora Online/g' \
        "$COOL_HTML"
    # Drop the brotli sidecar — its bytes are now stale.
    rm -f "$COOL_HTML.br"
    echo "  Substituted cool.html placeholders"
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

# build-info.json — the provenance record for this editor build. CI sets
# GIT_SHA / LO_BUILD_ID in env; manual invocations fall back to the working
# tree's HEAD and the pinned wasm/LO_BUILD_ID so the record is never empty
# (the CV test-run table reads these fields).
if [[ -z "${GIT_SHA:-}" ]]; then
    GIT_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
fi
if [[ -z "${LO_BUILD_ID:-}" && -f "$SCRIPT_DIR/LO_BUILD_ID" ]]; then
    LO_BUILD_ID="$(grep -v '^[[:space:]]*#' "$SCRIPT_DIR/LO_BUILD_ID" | grep -v '^[[:space:]]*$' | head -1 | tr -d '[:space:]')"
fi
cat > "$EDIR_CONTENT/build-info.json" <<EOF
{
  "id": "$APP_BUILD_ID",
  "git_sha": "${GIT_SHA:-}",
  "lo_build_id": "${LO_BUILD_ID:-}",
  "fingerprint": "${FINGERPRINT:-}",
  "deployed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# ── Tresorit-standard flat CDN layout ──────────────────────────────
# Alongside the per-deploy <APP_BUILD_ID>/browser/dist/ tree (which the
# co-editing viewer pins via EDITOR_DEPLOY_ID), also publish a FLAT
# collabora-<version>/ folder: cool.html + every asset directly under
# it, no browser/dist/ nesting. This is the layout the Tresorit
# content-preview app (and its collabora-sw.js) expects from a standard
# Collabora CDN, so content-preview needs no build-specific path
# rewriting — it just points VITE_COLLABORA_CDN_URL at this origin and
# requests /collabora-<version>/<asset>.
#
# The folder is a copy of the fully-finalized browser/dist/ tree
# (cool.html already placeholder-substituted, fingerprints baked, loader
# scripts overwritten, heavy assets + .br sidecars present), so the flat
# editor is byte-identical to the nested one. It lands in $STAGE before
# the azcopy upload and the Pattern β brotli swap below, so both pick it
# up automatically (the swap's `find $STAGE -name '*.br'` covers it).
#
# `version` is a per-build UTC timestamp in the extended-ISO form the
# content-preview build REQUIRES: YYYY-MM-DDTHH-MM-SSZ (its vite config
# validates this exact shape and refuses anything else — so APP_BUILD_ID's
# YYYY-MM-DD-<n> form can't be reused here). This matches the Tresorit CDN
# convention (a timestamp that changes itself per build). Overridable via
# CV_VERSION for reproducible/pinned deploys.
# latest-collabora.txt is the bare pointer the content-preview build reads
# to learn which version to pin (VITE_COLLABORA_WASM_VERSION), mirroring
# the Tresorit CDN's latest pointer.
CV_VERSION="${CV_VERSION:-$(date -u +%Y-%m-%dT%H-%M-%SZ)}"
CV_DIR="$STAGE/collabora-$CV_VERSION"
mkdir -p "$CV_DIR"
cp -r "$EDIR_CONTENT/browser/dist/." "$CV_DIR/"
# Spell dictionaries live a level up from browser/dist in the nested
# layout; put them under the flat folder too so dict-loader.js resolves
# collabora-<version>/dicts/<lang>.tar.gz.
if [[ -d "$EDIR_CONTENT/dicts" ]]; then
    cp -r "$EDIR_CONTENT/dicts" "$CV_DIR/dicts"
fi
# Provenance for the flat build too (id, git_sha, lo_build_id, fingerprint)
# — the CV test-run table fetches /collabora-<ver>/build-info.json.
cp "$EDIR_CONTENT/build-info.json" "$CV_DIR/build-info.json"
printf '%s' "$CV_VERSION" > "$STAGE/latest-collabora.txt"
echo "  Staged flat CDN layout: collabora-$CV_VERSION/ (+ latest-collabora.txt)"

# ── Upload ─────────────────────────────────────────────────────────
# Use account key (faster, less role plumbing). Mint it via control-
# plane RBAC if not provided in env.
#
# Once minted we export it as AZURE_STORAGE_KEY so the az CLI picks
# it up implicitly — meaning we DON'T have to pass `--account-key
# "$KEY"` on each command line. That's not just terser, it's a
# security improvement: `--account-key` is visible in `ps -ef` for
# the duration of the call, leaking the secret to any other UID
# that can read /proc/<pid>/cmdline. Passing it via env keeps it
# out of process listings.
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
export AZURE_STORAGE_KEY="$STORAGE_KEY"
export AZURE_STORAGE_ACCOUNT="$EDITOR_STORAGE_ACCOUNT"

echo "  Uploading to $EDITOR_STORAGE_ACCOUNT/$EDITOR_STORAGE_CONTAINER/$APP_BUILD_ID/..."

# Step 1: Bulk upload everything (raw + .br sidecars) via azcopy.
# `az storage blob upload-batch` runs effectively single-threaded
# (~0.3-1 file/sec — sequential HTTP per blob). For ~3000-file
# editor builds that's 30+ min per deploy. azcopy uses native
# parallelism (~100 concurrent transfers by default) and gets the
# same upload to ~30s.
#
# Auth: short-lived account-scoped SAS minted from the account key
# we already have. azcopy will SAS the destination URL directly,
# avoiding any login-cache state on the runner.
SAS_EXPIRY="$(date -u -d '+30 min' +%Y-%m-%dT%H:%MZ)"
# AZURE_STORAGE_ACCOUNT + AZURE_STORAGE_KEY (exported above) feed the
# CLI implicitly — no --account-key on the cmdline, so the secret
# doesn't show up in ps.
SAS_TOKEN="$(az storage account generate-sas \
    --permissions cwdl \
    --services b \
    --resource-types co \
    --expiry "$SAS_EXPIRY" \
    -o tsv 2>/dev/null)"
if [[ -z "$SAS_TOKEN" ]]; then
    echo "ERROR: failed to mint SAS token for upload" >&2
    exit 1
fi

# azcopy needs a destination URL. The container is `$web` (literal,
# dollar-sign included) — must be URL-encoded as %24web.
DEST_URL="https://${EDITOR_STORAGE_ACCOUNT}.blob.core.windows.net/%24web?${SAS_TOKEN}"

if ! command -v azcopy >/dev/null 2>&1; then
    echo "ERROR: azcopy not on PATH. Install with:" >&2
    echo "  curl -sL https://aka.ms/downloadazcopy-v10-linux | tar xz -C /tmp" >&2
    echo "  sudo cp /tmp/azcopy_linux_amd64_*/azcopy /usr/local/bin/" >&2
    exit 1
fi

# `--from-to LocalBlob --recursive` mirrors the local $STAGE tree
# into the container. Files at $STAGE/$APP_BUILD_ID/... land at
# $web/$APP_BUILD_ID/... and $STAGE/sw-bridge.js (which the script
# stages at the root) lands at $web/sw-bridge.js.
AZCOPY_JOB_PLAN_LOCATION=/tmp/azcopy-plans \
AZCOPY_LOG_LOCATION=/tmp/azcopy-logs \
    azcopy copy "$STAGE/*" "$DEST_URL" \
        --recursive --overwrite=true --output-level=essential \
        --log-level=ERROR > /tmp/fd-upload.log 2>&1 || {
            echo "ERROR: azcopy upload failed" >&2
            tail -30 /tmp/fd-upload.log >&2
            exit 1
        }
echo "    upload done ($(grep -oE 'Number of File Transfers: [0-9]+' /tmp/fd-upload.log | head -1 || echo '?') files)"

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
# AZURE_STORAGE_ACCOUNT / AZURE_STORAGE_KEY already exported above —
# inherited into the xargs child shells; no --account-key needed.
export EDITOR_STORAGE_CONTAINER STAGE

upload_one_br() {
    local br_src="$1"
    local rel="${br_src#$STAGE/}"
    local blob_name="${rel%.br}"   # canonical (no .br)
    local ct
    ct="$(mime_for "$blob_name")"
    az storage blob upload \
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
            "/$APP_BUILD_ID/browser/dist/cool.html" \
            "/collabora-$CV_VERSION/cool.html" \
            "/latest-collabora.txt"; do
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
echo "  Flat CDN layout: $EDITOR_FD_URL/collabora-$CV_VERSION/ (content-preview)"
echo "  content-preview build: VITE_COLLABORA_WASM_VERSION=$CV_VERSION  VITE_COLLABORA_CDN_URL=$EDITOR_FD_URL"
