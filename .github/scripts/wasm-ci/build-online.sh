#!/usr/bin/env bash
# Build Online (WASM) inside the lo-wasm-ci docker container.
#
# Inputs (env):
#   LO_BUILD_ID       — already-cached at $CI_STATE_DIR/lo-cache/<ID>/lo-core.tar.zst
#   APP_BUILD_ID      — for logging
#
# Strategy:
#   - Reuse the LO core artefacts from the cache (extract once into a per-ID
#     persistent volume so subsequent runs on the same LO_BUILD_ID skip extract).
#   - Bind-mount the runner's checkout (workspace) at /lo/online inside the container.
#   - Run the existing Online configure + emmake against the extracted core.
#   - Container name is lo-wasm-ci-build, image lo-wasm-ci:latest. Disjoint from
#     the dev containers (lo-wasm-server / lo-wasm-restore) on this host.
#   - flock guarantees only one CI build at a time on this host.
set -euo pipefail

# DEBUG: tee everything to a host-side log so post-mortem doesn't need GitHub
# auth for the run logs. Remove once stable.
exec > >(tee -a /tmp/build-online-debug.log) 2>&1
echo "===== build-online.sh @ $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
echo "  pwd=$(pwd)  whoami=$(whoami)  bash=$BASH_VERSION"
echo "  GITHUB_WORKSPACE=${GITHUB_WORKSPACE:-?}  CI_STATE_DIR=${CI_STATE_DIR:-?}"
echo "  LO_BUILD_ID=${LO_BUILD_ID:-?}  APP_BUILD_ID=${APP_BUILD_ID:-?}"
set -x

LO_BID="${LO_BUILD_ID:?}"
STATE_DIR="${CI_STATE_DIR:?}"
WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"

LO_CACHE="$STATE_DIR/lo-cache/$LO_BID"
LO_EXTRACTED="$STATE_DIR/lo-extracted/$LO_BID"
ONLINE_BUILD="$STATE_DIR/online-build"
EMSDK_CACHE="$STATE_DIR/emsdk-cache"
CCACHE_DIR="$STATE_DIR/ccache"

CI_IMAGE="lo-wasm-ci:latest"
CI_CONTAINER="lo-wasm-ci-build"
LOCK="$STATE_DIR/host.lock"

mkdir -p "$STATE_DIR" "$LO_EXTRACTED" "$ONLINE_BUILD" "$EMSDK_CACHE" "$CCACHE_DIR"

# ── Cleanup trap: container runs as root and writes into the bind-mounted
# workspace (autogen.sh / config.h.in / m4/ etc.), leaving root-owned files
# the next run's actions/checkout can't delete. Always chown back to UID
# 1000 on exit so the runner can recycle the workspace.
trap 'sudo chown -R 1000:1000 "$WORKSPACE" 2>/dev/null || true' EXIT

# ── Restore source-tree mtimes from git history ────────────────
# actions/checkout writes every file with `now` as the mtime, so `make`
# sees configure.ac as newer than aclocal.m4 and tries to regenerate via
# `./missing aclocal-1.16` — but `missing` is a generated script that was
# wiped by the same checkout. git-restore-mtime sets each file to its
# last commit time, keeping incremental builds honest.
if ! command -v git-restore-mtime >/dev/null 2>&1; then
    sudo apt-get install -y -qq git-restore-mtime 2>/dev/null || true
fi
if command -v git-restore-mtime >/dev/null 2>&1; then
    echo "--- Restoring workspace mtimes from git history ---"
    (cd "$WORKSPACE" && git-restore-mtime --skip-missing --quiet 2>&1 | tail -3) || true
fi

# ── Acquire host-wide lock ──────────────────────────────────────
exec 9>"$LOCK"
echo "Acquiring host build lock ($LOCK) …"
flock 9
echo "[OK] Lock acquired."

# ── Ensure CI image exists, build if missing ───────────────────
ensure_ci_image() {
    if docker image inspect "$CI_IMAGE" >/dev/null 2>&1; then
        echo "[OK] CI image $CI_IMAGE present."
        return 0
    fi
    echo "--- Building $CI_IMAGE (one-time / image was deleted) ---"
    # Dockerfile lives in the libreoffice-core-wasm repo. We don't have it
    # checked out here; fetch it on the fly from the dev branch of that repo.
    # (Pinning is OK — the Dockerfile is small and rarely changes.)
    local DOCKER_CTX
    DOCKER_CTX="$(mktemp -d)"
    trap "rm -rf '$DOCKER_CTX'" RETURN
    curl -fsSL https://raw.githubusercontent.com/szsz/libreoffice-core-wasm/dev/.github/docker/Dockerfile \
        -o "$DOCKER_CTX/Dockerfile"
    docker build -t "$CI_IMAGE" "$DOCKER_CTX"
    echo "[OK] Built $CI_IMAGE"
}
ensure_ci_image

# ── Extract LO core artefacts (idempotent) ─────────────────────
if [[ ! -f "$LO_EXTRACTED/.complete" ]]; then
    echo "--- Extracting LO core artefacts for $LO_BID ---"
    rm -rf "$LO_EXTRACTED"
    mkdir -p "$LO_EXTRACTED"
    tar -I 'zstd -d -T0' -xf "$LO_CACHE/lo-core.tar.zst" -C "$LO_EXTRACTED"
    touch "$LO_EXTRACTED/.complete"
    echo "[OK] Extracted to $LO_EXTRACTED ($(du -sh "$LO_EXTRACTED" | cut -f1))"
else
    echo "[OK] LO core artefacts already extracted at $LO_EXTRACTED"
fi

# ── Recreate the build container fresh each run (cheap; persistent state ──
# ── is in the bind mounts, so this is just the writable layer) ───────────
docker rm -f "$CI_CONTAINER" >/dev/null 2>&1 || true

docker run -d \
    --name "$CI_CONTAINER" \
    --memory=16g \
    --memory-swap=28g \
    -v "$WORKSPACE":/lo/online \
    -v "$LO_EXTRACTED":/lo \
    -v "$ONLINE_BUILD":/lo/online/wasm/online-build \
    -v "$EMSDK_CACHE":/home/builder/emsdk-cache \
    -v "$CCACHE_DIR":/root/.ccache \
    -e CCACHE_DIR=/root/.ccache \
    -e CCACHE_MAXSIZE=20G \
    "$CI_IMAGE" \
    sleep infinity

# Note on the bind mount above: the LO tarball expanded to $LO_EXTRACTED has a
# top-level `core/` and `core-build/` (matching /lo/core and /lo/core-build).
# So mounting $LO_EXTRACTED at /lo gives us both, plus our /lo/online overlay
# from the workspace mount above (Docker resolves these as separate mounts).

echo "--- Running Online configure + build ---"
docker exec "$CI_CONTAINER" bash -lc '
    set -euo pipefail
    git config --global --add safe.directory "*" 2>/dev/null || true
    source /home/builder/emsdk/emsdk_env.sh

    EXPORTS_DIR=/lo/core-build/workdir/CustomTarget/desktop/soffice_bin-emscripten-exports
    if [[ ! -f "$EXPORTS_DIR/exports" ]]; then
        mkdir -p "$EXPORTS_DIR"
        printf "_main\n_libreofficekit_hook\n_libreofficekit_hook_2\n_lok_preinit\n_lok_preinit_2\n" \
            > "$EXPORTS_DIR/exports"
    fi

    # Online-side KEEPALIVE functions (declared in wasm/wasmapp.cpp) need to
    # be in EXPORTED_FUNCTIONS — Makefile.am uses `-s EXPORTED_FUNCTIONS=@exports`
    # which is an allowlist; KEEPALIVE alone is ignored under that mode.
    # The published LO exports file lists only LO core symbols so we append
    # the Online ones unconditionally (idempotent: sort -u below).
    # The CI runner caches $LO_EXTRACTED across runs; if a previous run
    # mutated the exports file (e.g. an earlier patch wrote
    # _doc_postUnoCommand, which is only a static fn in
    # kit/DummyLibreOfficeKit.cpp and not actually exportable), strip
    # those known-stale entries on each run so we end up with a
    # deterministic (LO core exports ∪ Online KEEPALIVE list).
    {
        grep -vE "^(_doc_postUnoCommand)\$" "$EXPORTS_DIR/exports"
        printf "%s\n" \
            _signal_js_ready \
            _get_heap_base \
            _get_temp_dir_path \
            _is_preinit_done \
            _wasm_clear_server_freshly_ready \
            _notify_coolwsd_server_socket_ready \
            _create_remote_client \
            _poll_remote_client_ready \
            _handle_remote_message \
            _close_remote_client
    } | sort -u > "$EXPORTS_DIR/exports.new"
    mv "$EXPORTS_DIR/exports.new" "$EXPORTS_DIR/exports"
    echo "[OK] EXPORTED_FUNCTIONS includes $(wc -l <"$EXPORTS_DIR/exports") symbols"

    # autogen.sh ALWAYS — actions/checkout deletes the generated `missing`
    # script (autotools wrapper). Makefile references it; if absent, an
    # otherwise-incremental build dies at "/lo/online/missing: not found"
    # the moment Make decides aclocal needs to re-run.
    cd /lo/online && ./autogen.sh

    cd /lo/online/wasm/online-build
    if [[ ! -f wasm/Makefile ]]; then
        emconfigure /lo/online/configure \
            --disable-werror \
            --with-lokit-path=/lo/core/include \
            --with-lo-path=/lo/core-build/instdir \
            --with-lo-builddir=/lo/core-build \
            --with-lo-sourcedir=/lo/core \
            --with-zstd-includes=/usr/local/include \
            --with-zstd-libs=/usr/local/lib \
            --with-poco-includes=/usr/local/include \
            --with-poco-libs=/usr/local/lib \
            --host=wasm32-local-emscripten
    fi
    emmake make -j"$(nproc)"
'

echo "--- Build complete; key artefacts: ---"
ls -lh "$ONLINE_BUILD"/wasm/online.* 2>/dev/null | awk '{print "  "$NF" ("$5")"}' || true

# Chown build outputs back to the runner user BEFORE finalize so the
# host (which runs finalize) can edit them. The container's emcc ran
# as root, so the bind-mounted output dir has root-owned files.
#
# The chown must hit the BIND-MOUNT TARGET inside the container
# (/lo/online/wasm/online-build) — $ONLINE_BUILD is a host path that
# doesn't exist inside the container. Belt-and-braces with a host-side
# sudo chown so we recover even if the container chown fails.
docker exec "$CI_CONTAINER" chown -R 1000:1000 /lo/online/wasm/online-build 2>/dev/null || true
sudo chown -R "$(id -u):$(id -g)" "$ONLINE_BUILD" 2>/dev/null || true

# Finalize build — runs on the HOST (the runner) so it has access to
# brotli, node, and the tracked source files (wasm/snapshot-inject*.js).
# Snapshot inject + emscripten-module locateFile + global.js branding
# strip + fingerprint substitution + cache-bust + brotli sidecars.
# After this the tree is "complete" — deploys are pure cp + config +
# ship + smoke. See wasm/PLAN-deploy-vs-build.md.
#
# Use `set -e` here: if finalize fails, the deploy step's __assetMap
# check will trip anyway, but failing the build step makes the
# diagnostic visible directly in the workflow's "Build Online" log
# instead of one step later.
BROTLI_QUALITY="${BROTLI_QUALITY:-2}"
echo "--- Finalizing build on host (q$BROTLI_QUALITY) ---"
BROTLI_QUALITY="$BROTLI_QUALITY" \
    bash "$WORKSPACE/wasm/tools/finalize-build.sh" "$ONLINE_BUILD"

# Stop the container; persistent state survives in the bind mounts.
docker stop "$CI_CONTAINER" >/dev/null 2>&1 || true
echo "[OK] APP_BUILD_ID=$APP_BUILD_ID built against LO_BUILD_ID=$LO_BID"
