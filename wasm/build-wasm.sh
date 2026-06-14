#!/bin/bash
# Build Collabora Online WASM binary.
#
# DEFAULT (production-style):
#   Fetch the published LibreOffice WASM core from coolwasmfiles
#   (matching wasm/LO_BUILD_ID), extract it locally, and build Online
#   against it. No local LO core build is performed — same recipe the
#   CI uses, so the resulting online.wasm matches what gets deployed.
#
# --local-lo (inner-loop debugging only):
#   Use the host's $LO_CORE_HOST_DIR checkout (default
#   $HOME/libreoffice-core-wasm) bind-mounted into the container,
#   building LO core in-container. The output is NOT publishable —
#   only the CI-built artefact (referenced by wasm/LO_BUILD_ID) gets
#   deployed. See wasm/CO-EDITING-ARCHITECTURE.md "Build & release
#   policy".
#
# Usage:
#   bash wasm/build-wasm.sh                       # build vs published LO (default)
#   bash wasm/build-wasm.sh --lo-build-id=<id>    # override the pinned LO build
#   bash wasm/build-wasm.sh --local-lo            # build vs $HOME/libreoffice-core-wasm
#   bash wasm/build-wasm.sh --setup               # setup only (pull image, no build)
#   bash wasm/build-wasm.sh --clean               # force full rebuild of Online
#   bash wasm/build-wasm.sh --rebuild-core        # --local-lo only: rebuild LO core
#   bash wasm/build-wasm.sh --container-name=NAME # override container name
#
# Subsequent runs: make detects changed source files and only recompiles what changed.

set -e

# Prevent MSYS/Git-Bash from mangling Unix paths passed to Docker (no-op on Linux)
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# Default container name varies by mode so the two paths don't fight over
# /lo mount layout. --container-name=NAME overrides for both.
CONTAINER=""
# Prefer the locally-patched image (lo-wasm-ci:latest) which carries the
# Poco patch online's wsd/COOLWSD.cpp needs (Application::clearInstancePointer).
# The upstream public image lacks it — building against it fails with
# "no member named 'clearInstancePointer' in Poco::Util::Application"
# (hit 2026-06-13 after a fresh container was created from the public
# image). Fall back to the public image only if the patched one is absent.
# Override with WASM_BUILD_IMAGE=<image>.
if [ -n "${WASM_BUILD_IMAGE:-}" ]; then
    IMAGE="$WASM_BUILD_IMAGE"
elif docker image inspect lo-wasm-ci:latest >/dev/null 2>&1; then
    IMAGE="lo-wasm-ci:latest"
else
    IMAGE="public.ecr.aws/allotropia/libo-builders/wasm"
fi
LO_CORE_BRANCH="wasm-coediting"
LO_CORE_REPO="https://github.com/szsz/libreoffice-core-wasm.git"
LO_CORE_HOST_DIR="${LO_CORE_HOST_DIR-$HOME/libreoffice-core-wasm}"  # default bind-mount

# Inside the container the repo is always at /lo/online and LO core at /lo/core
CONTAINER_REPO_DIR="/lo/online"
CONTAINER_CORE_DIR="/lo/core"
ONLINE_BUILD_DIR="$CONTAINER_REPO_DIR/wasm/online-build"

SETUP_ONLY=false
CLEAN=false
REBUILD_CORE=false
BUILD_CORE=false
USE_LOCAL_LO=false
LO_BUILD_ID_OVERRIDE=""
for arg in "$@"; do
    case "$arg" in
        --setup) SETUP_ONLY=true ;;
        --clean) CLEAN=true ;;
        --rebuild-core) REBUILD_CORE=true ;;
        --build-core) BUILD_CORE=true ;;
        --local-lo) USE_LOCAL_LO=true ;;
        --lo-build-id=*) LO_BUILD_ID_OVERRIDE="${arg#*=}" ;;
        --container-name=*) CONTAINER="${arg#*=}" ;;
    esac
done

# Per-mode default container name so a previous --local-lo container's /lo/core
# bind-mount doesn't conflict with a published-LO container's /lo bind-mount.
if [ -z "$CONTAINER" ]; then
    if [ "$USE_LOCAL_LO" = true ]; then
        CONTAINER="lo-wasm-server"
    else
        CONTAINER="lo-wasm-server-pub"
    fi
fi

echo "=== WASM Build ==="
echo ""

# ---------- Docker ----------
if ! command -v docker &>/dev/null; then
    echo "--- Installing Docker ---"
    if command -v apt-get &>/dev/null; then
        curl -fsSL https://get.docker.com | sudo sh
        sudo usermod -aG docker "$USER"
        echo "[OK] Docker installed (you may need to log out/in for group membership)"
    else
        echo "ERROR: Install Docker manually: https://docs.docker.com/engine/install/"
        exit 1
    fi
fi
echo "[OK] Docker $(docker --version | awk '{print $3}')"

# ---------- Pull builder image ----------
if ! docker image inspect "$IMAGE" &>/dev/null; then
    echo "--- Pulling WASM builder image ---"
    docker pull "$IMAGE"
fi
echo "[OK] Image"

# ---------- Create / start container ----------
# Helper: verify an existing container's bind mount matches this repo
check_container_mount() {
    local mount_src
    mount_src="$(docker inspect "$CONTAINER" \
        --format '{{range .Mounts}}{{if eq .Destination "'"$CONTAINER_REPO_DIR"'"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)"
    if [ -n "$mount_src" ] && [ "$mount_src" != "$REPO_DIR" ]; then
        echo ""
        echo "  WARNING: Container '$CONTAINER' is bound to a different repo:"
        echo "    mounted: $mount_src"
        echo "    current: $REPO_DIR"
        echo ""
        echo "  Another script may be using this container."
        echo "  You can use --container-name=<name> to run a separate container."
        echo ""
        read -p "  Continue anyway? [y/N]: " -n 1 -r
        echo ""
        if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
            echo "Exiting."
            exit 1
        fi
    fi
}

# LO Core source: published artefact (default) or local checkout (--local-lo).
LO_CORE_MOUNT_ARGS=()
LO_PUBLISHED_DIR=""
if [ "$USE_LOCAL_LO" = true ]; then
    if [ -n "$LO_CORE_HOST_DIR" ] && [ -d "$LO_CORE_HOST_DIR/.git" ]; then
        LO_CORE_MOUNT_ARGS=(-v "$LO_CORE_HOST_DIR":"$CONTAINER_CORE_DIR")
        echo "[OK] LO Core bind-mount (--local-lo): $LO_CORE_HOST_DIR → $CONTAINER_CORE_DIR"
    elif [ -z "$LO_CORE_HOST_DIR" ]; then
        echo "[OK] LO Core: clone-from-fork ($LO_CORE_REPO @ $LO_CORE_BRANCH)"
    else
        echo "ERROR: --local-lo set but $LO_CORE_HOST_DIR has no .git checkout" >&2
        exit 1
    fi
else
    # Default: fetch the published LO build pinned in wasm/LO_BUILD_ID.
    # The extracted dir contains core/ and core-build/ at its root, so
    # mounting it at /lo gives the container both /lo/core and /lo/core-build.
    echo "--- Fetching published LO build (pin: ${LO_BUILD_ID_OVERRIDE:-wasm/LO_BUILD_ID}) ---"
    if [ -n "$LO_BUILD_ID_OVERRIDE" ]; then
        LO_PUBLISHED_DIR="$(bash "$SCRIPT_DIR/fetch-lo-build.sh" "$LO_BUILD_ID_OVERRIDE")"
    else
        LO_PUBLISHED_DIR="$(bash "$SCRIPT_DIR/fetch-lo-build.sh")"
    fi
    if [ -z "$LO_PUBLISHED_DIR" ] || [ ! -d "$LO_PUBLISHED_DIR/core" ] || [ ! -d "$LO_PUBLISHED_DIR/core-build" ]; then
        echo "ERROR: published LO artefact missing core/ or core-build/ at $LO_PUBLISHED_DIR" >&2
        exit 1
    fi
    # NOT read-only — Online's configure may need to write the exports stub
    # under /lo/core-build/workdir/CustomTarget/desktop/.../exports if absent.
    LO_CORE_MOUNT_ARGS=(-v "$LO_PUBLISHED_DIR":/lo)
    echo "[OK] LO Core (published): $LO_PUBLISHED_DIR → /lo"
fi

# Detect a STALE /lo mount on an existing container. The /lo bind-mount
# is fixed at container-creation time; if a prior build created the
# container against an older LO extraction, reusing it links online
# against the OLD LO libs — e.g. `wasm-ld: undefined symbol: <new LO
# symbol>` when this build's LO_BUILD_ID added a symbol the stale /lo
# lacks (cost a full build cycle 2026-06-13). In published mode, if the
# container's /lo source != the LO_PUBLISHED_DIR we just fetched, force a
# fresh container so the correct LO mount takes effect.
lo_mount_is_stale() {
    [ -z "$LO_PUBLISHED_DIR" ] && return 1   # only meaningful in published mode
    local cur
    cur="$(docker inspect "$CONTAINER" \
        --format '{{range .Mounts}}{{if eq .Destination "/lo"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)"
    [ -n "$cur" ] && [ "$cur" != "$LO_PUBLISHED_DIR" ]
}

if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER}$" && lo_mount_is_stale; then
    echo "  NOTE: container '$CONTAINER' has a STALE /lo mount; recreating against $LO_PUBLISHED_DIR"
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
fi

if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER}$"; then
    check_container_mount
    echo "[OK] Container '$CONTAINER'"
elif docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER}$"; then
    check_container_mount
    docker start "$CONTAINER"
    echo "[OK] Container '$CONTAINER' started"
else
    docker run -d \
        --name "$CONTAINER" \
        --memory=14g \
        -v "$REPO_DIR":"$CONTAINER_REPO_DIR" \
        "${LO_CORE_MOUNT_ARGS[@]}" \
        "$IMAGE" \
        sleep infinity
    echo "[OK] Container '$CONTAINER' created"
fi

# ---------- Container environment fixes ----------
docker exec "$CONTAINER" bash -c "
    git config --global --add safe.directory '*' 2>/dev/null
    # GCC 12+
    if ! gcc --version 2>/dev/null | grep -qE '1[2-9]\.|[2-9][0-9]\.'; then
        apt-get update -qq && apt-get install -y -qq gcc-12 g++-12 >/dev/null 2>&1
        update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-12 100 >/dev/null 2>&1
        update-alternatives --install /usr/bin/g++ g++ /usr/bin/g++-12 100 >/dev/null 2>&1
    fi
    # Node 20+
    NODE_VER=\$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
    if [ \"\$NODE_VER\" -lt 20 ] 2>/dev/null; then
        apt-get remove -y -qq libnode-dev >/dev/null 2>&1 || true
        if command -v curl &>/dev/null; then
            curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null 2>&1
        else
            wget -qO- https://deb.nodesource.com/setup_24.x | bash - >/dev/null 2>&1
        fi
        apt-get install -y -qq nodejs >/dev/null 2>&1
    fi
    # emsdk layout fix
    if [ ! -d /home/builder/emsdk/upstream ]; then
        mkdir -p /home/builder/emsdk/upstream
        ln -sfn /home/builder/emsdk/emscripten/main /home/builder/emsdk/upstream/emscripten
    fi
" 2>/dev/null

# ---------- Rebuild POCO with -fwasm-exceptions (if needed) ----------
if docker exec "$CONTAINER" bash -c "
    source /home/builder/emsdk/emsdk_env.sh 2>/dev/null
    \$EMSDK/llvm/git/build_main_64/bin/llvm-nm /usr/local/lib/libPocoFoundation.a 2>/dev/null | grep -q emscripten_longjmp
" 2>/dev/null; then
    echo "--- Rebuilding POCO with -fwasm-exceptions ---"
    docker exec "$CONTAINER" bash -c "
        source /home/builder/emsdk/emsdk_env.sh 2>/dev/null
        cd /tmp
        POCO_VER=1.12.4
        if [ ! -d poco-\${POCO_VER}-all ]; then
            wget -q https://pocoproject.org/releases/poco-\${POCO_VER}/poco-\${POCO_VER}-all.tar.bz2
            tar -xjf poco-\${POCO_VER}-all.tar.bz2
        fi
        cd poco-\${POCO_VER}-all
        patch -p1 -N < '$CONTAINER_REPO_DIR/wasm/poco-1.12.4-emscripten.patch' 2>/dev/null || true
        [ -f XML/src/xmlparse.cpp ] && mv XML/src/xmlparse.cpp XML/src/xmlparse.c 2>/dev/null || true
        patch -p0 -N < '$CONTAINER_REPO_DIR/wasm/poco-no-special-expat-sauce.diff' 2>/dev/null || true
        emconfigure ./configure --static --no-samples --no-tests \
            --omit=Crypto,NetSSL_OpenSSL,JWT,Data,Data/SQLite,Data/ODBC,Data/MySQL,Data/PostgreSQL,Zip,PageCompiler,PageCompiler/File2Page,MongoDB,Redis,ActiveRecord,ActiveRecord/Compiler,Prometheus
        emmake make -j\$(nproc) \
            CC=\$EMSDK/upstream/emscripten/emcc \
            CXX=\$EMSDK/upstream/emscripten/em++ \
            LD=\$EMSDK/upstream/emscripten/em++ \
            CXXFLAGS='-DPOCO_NO_LINUX_IF_PACKET_H -DPOCO_NO_INOTIFY -pthread -s USE_PTHREADS=1 -fwasm-exceptions'
        make -j\$(nproc) install INSTALLDIR=/tmp/poco-\${POCO_VER}-all/install
        cp -f install/lib/libPoco*.a /usr/local/lib/
        cp -rf install/include/* /usr/local/include/
    "
    echo "[OK] POCO rebuilt"
else
    echo "[OK] POCO"
fi

if [ "$SETUP_ONLY" = true ]; then
    echo ""
    echo "=== Setup complete. Run: bash wasm/build-wasm.sh ==="
    exit 0
fi

# ---------- LibreOffice Core ----------
# In published-LO mode (default), the artefact downloaded by
# fetch-lo-build.sh already contains a complete /lo/core + /lo/core-build,
# so we skip the LO sync/configure/build steps entirely.
if [ "$USE_LOCAL_LO" = true ]; then
    if [ "$REBUILD_CORE" = true ]; then
        docker exec "$CONTAINER" bash -c "rm -rf /lo/core-build" 2>/dev/null
    fi

    # Sync /lo/core from the fork tip on every build, unless the host
    # checkout is bind-mounted (in which case the host is canonical and
    # git operations from the container would clobber local edits).
    if [ -z "$LO_CORE_HOST_DIR" ]; then
        if docker exec "$CONTAINER" test -d /lo/core/.git 2>/dev/null; then
            echo "--- Syncing /lo/core to $LO_CORE_BRANCH tip ---"
            docker exec "$CONTAINER" bash -c "
                cd /lo/core
                git fetch origin '$LO_CORE_BRANCH' --depth 1 --quiet
                git reset --hard FETCH_HEAD --quiet
                echo \"  HEAD: \$(git log --oneline -1)\"
            "
        else
            echo "--- Cloning LO core fork ($LO_CORE_BRANCH) ---"
            docker exec "$CONTAINER" bash -c "
                mkdir -p /lo
                git clone --depth 1 --branch '$LO_CORE_BRANCH' '$LO_CORE_REPO' /lo/core
            "
        fi
    fi

    if ! docker exec "$CONTAINER" test -f /lo/core-build/instdir/program/soffice.js 2>/dev/null; then
        if [ "$BUILD_CORE" != true ]; then
            echo ""
            echo "  LibreOffice Core not found. Build from source?"
            echo "  (1-3 hours, ~12 GB RAM)"
            echo ""
            read -p "  Proceed? [y/N]: " -n 1 -r
            echo ""
            [[ ! "$REPLY" =~ ^[Yy]$ ]] && exit 0
        fi

        echo "--- Configuring LibreOffice Core ---"
        docker exec "$CONTAINER" bash -c "
            # Ensure gcc-12 is default (required by latest LO Core)
            update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-12 100 2>/dev/null
            update-alternatives --install /usr/bin/g++ g++ /usr/bin/g++-12 100 2>/dev/null
            source /home/builder/emsdk/emsdk_env.sh
            mkdir -p /lo/core-build && cd /lo/core-build
            /lo/core/autogen.sh --with-distro=LibreOfficeWASM32 --with-wasm-module='writer calc impress'
        "
        echo "--- Building LibreOffice Core ---"
        docker exec "$CONTAINER" bash -c "
            source /home/builder/emsdk/emsdk_env.sh
            cd /lo/core-build && make -rj\$(nproc) 2>&1
        "
        echo "[OK] Core build complete"
    else
        echo "[OK] LibreOffice Core"
    fi
else
    # Published LO mode: artefact must contain core/ and core-build/ — verified above.
    if [ "$REBUILD_CORE" = true ]; then
        echo "WARNING: --rebuild-core has no effect in published-LO mode (use --local-lo)" >&2
    fi
    if ! docker exec "$CONTAINER" test -f /lo/core-build/instdir/program/soffice.js 2>/dev/null; then
        echo "ERROR: published LO artefact at $LO_PUBLISHED_DIR is missing core-build/instdir/program/soffice.js." >&2
        echo "       Re-fetch with: rm -rf $LO_PUBLISHED_DIR && bash wasm/build-wasm.sh" >&2
        exit 1
    fi
    echo "[OK] LibreOffice Core (published artefact)"
fi

# ---------- Configure Online (first time or --clean) ----------
if ! docker exec "$CONTAINER" test -f "$ONLINE_BUILD_DIR/wasm/Makefile" 2>/dev/null || [ "$CLEAN" = true ]; then
    echo "--- Configuring Online ---"
    docker exec "$CONTAINER" bash -c "
        mkdir -p '$ONLINE_BUILD_DIR'
        EXPORTS_DIR=/lo/core-build/workdir/CustomTarget/desktop/soffice_bin-emscripten-exports
        if [ ! -f \$EXPORTS_DIR/exports ]; then
            mkdir -p \$EXPORTS_DIR
            printf '_main\n_libreofficekit_hook\n_libreofficekit_hook_2\n_lok_preinit\n_lok_preinit_2\n' > \$EXPORTS_DIR/exports
        fi
        # Online-side KEEPALIVE functions (wasm/wasmapp.cpp) must be in
        # EXPORTED_FUNCTIONS — Makefile.am uses '-s EXPORTED_FUNCTIONS=@exports'
        # which is an allowlist; KEEPALIVE alone is ignored. Strip any
        # known-stale entries from prior patches, then append the live list.
        {
            grep -vE '^(_doc_postUnoCommand)\$' \$EXPORTS_DIR/exports
            printf '%s\n' _signal_js_ready _get_heap_base _get_temp_dir_path \
                _is_preinit_done _wasm_clear_server_freshly_ready \
                _notify_coolwsd_server_socket_ready _create_remote_client \
                _poll_remote_client_ready _handle_remote_message _close_remote_client
        } | sort -u > \$EXPORTS_DIR/exports.new
        mv \$EXPORTS_DIR/exports.new \$EXPORTS_DIR/exports
    "
    docker exec "$CONTAINER" bash -c "
        source /home/builder/emsdk/emsdk_env.sh
        cd '$ONLINE_BUILD_DIR'
        '$CONTAINER_REPO_DIR/autogen.sh'
        emconfigure '$CONTAINER_REPO_DIR/configure' \
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
    "
    echo "[OK] Online configured"
else
    echo "[OK] Online configured"
fi

# ---------- Build ----------
echo "--- Building Online WASM ---"
if [ "$CLEAN" = true ]; then
    docker exec "$CONTAINER" bash -c "
        cd '$ONLINE_BUILD_DIR/wasm'
        rm -f online.js online.wasm online.worker.js *.o ../**/*.o
    "
fi
docker exec "$CONTAINER" bash -c "
    source /home/builder/emsdk/emsdk_env.sh 2>/dev/null
    cd '$ONLINE_BUILD_DIR'
    emmake make -j\$(nproc) 2>&1
"

echo ""
echo "=== Build complete ==="

# ---------- Locate the real link output ----------
# Depending on how the in-container configure resolved its build tree,
# make's output lands either in the bind-mounted $ONLINE_BUILD_DIR/wasm
# or in a container-internal /wasm (observed 2026-06-12: the configured
# tree was rooted at '/' and three successive local builds silently
# left STALE artifacts on the host while the fresh growth/limited-opt
# binaries sat inside the container). Detect the freshest online.wasm
# of the two and, if it's container-internal, copy it out.
HOST_WASM="$REPO_DIR/wasm/online-build/wasm"
CONTAINER_INTERNAL_NEWER=$(docker exec "$CONTAINER" bash -c "
    [ -f /wasm/online.wasm ] || exit 1
    [ ! -f '$ONLINE_BUILD_DIR/wasm/online.wasm' ] && exit 0
    [ /wasm/online.wasm -nt '$ONLINE_BUILD_DIR/wasm/online.wasm' ] && exit 0 || exit 1
" && echo yes || echo no)
if [ "$CONTAINER_INTERNAL_NEWER" = "yes" ]; then
    echo "  NOTE: link output found at container-internal /wasm — extracting"
fi

# ---------- Strip the name section (in-container, wasm-opt) ----------
# Only relevant for DIAGNOSTIC builds where --profiling-funcs was added
# to online_LDFLAGS in wasm/Makefile.am (symbolized stacks; +99 MB raw).
# Strip the names back out before any deploy (277 MB → 178 MB) unless
# WASM_KEEP_NAMES=1 explicitly keeps them for local stack debugging.
# Stripping is metadata-only — code stays byte-identical (verified:
# strip output is invariant under feature-flag sets, and a stripped vs
# named pair behave the same modulo the probabilistic SECOND_INIT race
# documented in ai/proposals/proposed/second-init-wild-pointer-oob.md).
# The default `-Oz -g0` link emits no name section, so skip the
# multi-minute wasm-opt round-trip entirely in that case.
if ! grep -q -- '--profiling-funcs' "$REPO_DIR/wasm/Makefile.am"; then
    : # default link has no name section — nothing to strip
elif [ "${WASM_KEEP_NAMES:-0}" = "1" ]; then
    echo "  WASM_KEEP_NAMES=1 — skipping name-section strip (diagnostic build)"
else
echo "  Stripping wasm name section (post-link, code unchanged)…"
docker exec "$CONTAINER" bash -c "
    set -e
    SRC='$ONLINE_BUILD_DIR/wasm/online.wasm'
    [ '$CONTAINER_INTERNAL_NEWER' = 'yes' ] && SRC=/wasm/online.wasm
    WOPT=\$(find /home/builder/emsdk -name wasm-opt -type f 2>/dev/null | head -1)
    \$WOPT --strip-debug --strip-producers \"\$SRC\" -o /tmp/online.stripped.wasm \
        --enable-threads --enable-bulk-memory --enable-exception-handling \
        --enable-sign-ext --enable-mutable-globals --enable-nontrapping-float-to-int
    mv /tmp/online.stripped.wasm \"\$SRC\"
    ls -la \"\$SRC\"
" || echo "  WARNING: name-strip failed — shipping with name section"
fi

# ---------- Extract artifacts if the build tree was container-internal ──
if [ "$CONTAINER_INTERNAL_NEWER" = "yes" ]; then
    mkdir -p "$HOST_WASM" "$REPO_DIR/wasm/online-build/browser/dist"
    # Browser assets FIRST (cool.html, bundle.js, …) — this tree contains
    # an UNSTRIPPED copy of online.wasm made during make, so the stripped
    # /wasm/* copies below must come AFTER to win. Shipping the browser
    # tree's unstripped wasm next to /wasm's fresh online.js produced a
    # mismatched glue/wasm pair on the first pipeline validation — the
    # pair MUST come from the same post-strip /wasm state.
    docker cp "$CONTAINER:/browser/dist/." "$REPO_DIR/wasm/online-build/browser/dist/" 2>/dev/null || true
    for f in online.js online.wasm online.worker.js; do
        docker cp "$CONTAINER:/wasm/$f" "$HOST_WASM/$f" 2>/dev/null || true
        docker cp "$CONTAINER:/wasm/$f" "$REPO_DIR/wasm/online-build/browser/dist/$f" 2>/dev/null || true
    done
fi

echo ""
echo "  Artifacts:"
ls -lh "$REPO_DIR/wasm/online-build/wasm"/online.* 2>/dev/null | awk '{print "    " $NF " (" $5 ")"}'

# ---------- Chown build outputs back to host user ----------
# emcc runs as root inside the container; chown back so finalize-build.sh
# (which runs on the host below) can edit the outputs without sudo.
docker exec "$CONTAINER" chown -R "$(id -u):$(id -g)" "$ONLINE_BUILD_DIR" 2>/dev/null || true
chown -R "$(id -u):$(id -g)" "$REPO_DIR/wasm/online-build" 2>/dev/null || \
    sudo chown -R "$(id -u):$(id -g)" "$REPO_DIR/wasm/online-build" 2>/dev/null || true

# ---------- Stop container ----------
echo ""
echo "--- Stopping container '$CONTAINER' ---"
docker stop "$CONTAINER" >/dev/null 2>&1

# ---------- Finalize build (snapshot inject + cache-bust + brotli) ----------
# Runs on the HOST (not in docker) so it has access to brotli, node, and
# the tracked source files (wasm/snapshot-inject*.js). All build-time
# content patches go here so deploys can be pure cp + config + ship.
# See wasm/PLAN-deploy-vs-build.md for the rationale.
BROTLI_QUALITY="${BROTLI_QUALITY:-2}"
echo ""
echo "--- Finalizing build on host (q${BROTLI_QUALITY}) ---"
BROTLI_QUALITY="$BROTLI_QUALITY" \
    bash "$SCRIPT_DIR/tools/finalize-build.sh" "$REPO_DIR/wasm/online-build" \
    || echo "  WARNING: finalize-build.sh reported failures"
echo "[OK] Container stopped"
