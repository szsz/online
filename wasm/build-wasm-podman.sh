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
#   bash wasm/build-wasm.sh --no-finalize         # skip the fork's post-build JS patches
#                                                 # (snapshot inject, cache-bust, brotli,
#                                                 # sw.js/wasm-loader.js fingerprinting).
#                                                 # Produces a vanilla upstream-style
#                                                 # online.wasm + online.js + online.worker.js
#                                                 # in wasm/online-build/wasm/. The fork's
#                                                 # C++ coediting code is still compiled in
#                                                 # but won't be invoked unless something
#                                                 # calls those exports.
#
# Subsequent runs: make detects changed source files and only recompiles what changed.

set -e

# Prevent MSYS/Git-Bash from mangling Unix paths passed to the container runtime (no-op on Linux/macOS)
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# Default container name varies by mode so the two paths don't fight over
# /lo mount layout. --container-name=NAME overrides for both.
CONTAINER=""
IMAGE="public.ecr.aws/allotropia/libo-builders/wasm"
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
NO_FINALIZE=false
LO_BUILD_ID_OVERRIDE=""
for arg in "$@"; do
    case "$arg" in
        --setup) SETUP_ONLY=true ;;
        --clean) CLEAN=true ;;
        --rebuild-core) REBUILD_CORE=true ;;
        --build-core) BUILD_CORE=true ;;
        --local-lo) USE_LOCAL_LO=true ;;
        --no-finalize) NO_FINALIZE=true ;;
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

# ---------- Podman ----------
if ! command -v podman &>/dev/null; then
    echo "ERROR: podman is required."
    echo "       macOS:  brew install podman && podman machine init && podman machine start"
    echo "       Linux:  see https://podman.io/docs/installation"
    exit 1
fi
# On macOS podman runs inside a Linux VM that must be started before any
# podman command will talk to a daemon. `podman machine list` has no
# matching entries on Linux (native podman), in which case skip the start.
if podman machine list --format '{{.Name}}' 2>/dev/null | grep -q .; then
    if ! podman machine list --format '{{.Running}}' 2>/dev/null | grep -q true; then
        echo "--- Starting podman machine ---"
        podman machine start
    fi
fi
echo "[OK] Podman $(podman --version | awk '{print $3}')"

# ---------- Pull builder image ----------
if ! podman image inspect "$IMAGE" &>/dev/null; then
    echo "--- Pulling WASM builder image ---"
    podman pull "$IMAGE"
fi
echo "[OK] Image"

# ---------- Create / start container ----------
# Helper: verify an existing container's bind mount matches this repo
check_container_mount() {
    local mount_src
    mount_src="$(podman inspect "$CONTAINER" \
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

if podman ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER}$"; then
    check_container_mount
    echo "[OK] Container '$CONTAINER'"
elif podman ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER}$"; then
    check_container_mount
    podman start "$CONTAINER"
    echo "[OK] Container '$CONTAINER' started"
else
    podman run -d \
        --name "$CONTAINER" \
        --memory=24g \
        -v "$REPO_DIR":"$CONTAINER_REPO_DIR" \
        "${LO_CORE_MOUNT_ARGS[@]}" \
        "$IMAGE" \
        sleep infinity
    echo "[OK] Container '$CONTAINER' created"
fi

# ---------- Container environment fixes ----------
podman exec "$CONTAINER" bash -c "
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

# ---------- Rebuild POCO (if needed) ----------
# Two reasons to rebuild:
#   1. Old POCO built without -fwasm-exceptions (has emscripten_longjmp symbol).
#   2. POCO is missing the fork's clearInstancePointer patch (in libPocoUtil.a).
#      wsd/COOLWSD.cpp calls Poco::Util::Application::clearInstancePointer()
#      after a snapshot restore (warm-visit path) to reset the Application
#      singleton — this symbol only exists via wasm/poco-1.12.4-emscripten.patch.
if podman exec "$CONTAINER" bash -c '
    source /home/builder/emsdk/emsdk_env.sh 2>/dev/null
    NM=$EMSDK/llvm/git/build_main_64/bin/llvm-nm
    # Reason 1: old non-wasm-exceptions POCO
    $NM /usr/local/lib/libPocoFoundation.a 2>/dev/null | grep -q emscripten_longjmp && exit 0
    # Reason 2: fork patch missing
    $NM /usr/local/lib/libPocoUtil.a 2>/dev/null | grep -q clearInstancePointer || exit 0
    exit 1
' 2>/dev/null; then
    echo "--- Rebuilding POCO with -fwasm-exceptions + fork patches ---"
    podman exec "$CONTAINER" bash -c "
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
        podman exec "$CONTAINER" bash -c "rm -rf /lo/core-build" 2>/dev/null
    fi

    # Sync /lo/core from the fork tip on every build, unless the host
    # checkout is bind-mounted (in which case the host is canonical and
    # git operations from the container would clobber local edits).
    if [ -z "$LO_CORE_HOST_DIR" ]; then
        if podman exec "$CONTAINER" test -d /lo/core/.git 2>/dev/null; then
            echo "--- Syncing /lo/core to $LO_CORE_BRANCH tip ---"
            podman exec "$CONTAINER" bash -c "
                cd /lo/core
                git fetch origin '$LO_CORE_BRANCH' --depth 1 --quiet
                git reset --hard FETCH_HEAD --quiet
                echo \"  HEAD: \$(git log --oneline -1)\"
            "
        else
            echo "--- Cloning LO core fork ($LO_CORE_BRANCH) ---"
            podman exec "$CONTAINER" bash -c "
                mkdir -p /lo
                git clone --depth 1 --branch '$LO_CORE_BRANCH' '$LO_CORE_REPO' /lo/core
            "
        fi
    fi

    if ! podman exec "$CONTAINER" test -f /lo/core-build/instdir/program/soffice.js 2>/dev/null; then
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
        podman exec "$CONTAINER" bash -c "
            # Ensure gcc-12 is default (required by latest LO Core)
            update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-12 100 2>/dev/null
            update-alternatives --install /usr/bin/g++ g++ /usr/bin/g++-12 100 2>/dev/null
            source /home/builder/emsdk/emsdk_env.sh
            mkdir -p /lo/core-build && cd /lo/core-build
            /lo/core/autogen.sh --with-distro=LibreOfficeWASM32 --with-wasm-module='writer calc impress'
        "
        echo "--- Building LibreOffice Core ---"
        podman exec "$CONTAINER" bash -c "
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
    if ! podman exec "$CONTAINER" test -f /lo/core-build/instdir/program/soffice.js 2>/dev/null; then
        echo "ERROR: published LO artefact at $LO_PUBLISHED_DIR is missing core-build/instdir/program/soffice.js." >&2
        echo "       Re-fetch with: rm -rf $LO_PUBLISHED_DIR && bash wasm/build-wasm.sh" >&2
        exit 1
    fi
    echo "[OK] LibreOffice Core (published artefact)"
fi

# ---------- Configure Online (first time or --clean) ----------
if ! podman exec "$CONTAINER" test -f "$ONLINE_BUILD_DIR/wasm/Makefile" 2>/dev/null || [ "$CLEAN" = true ]; then
    echo "--- Configuring Online ---"
    podman exec "$CONTAINER" bash -c "
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
                _poll_remote_client_ready _handle_remote_message _close_remote_client \
                _wasm_set_user_name
        } | sort -u > \$EXPORTS_DIR/exports.new
        mv \$EXPORTS_DIR/exports.new \$EXPORTS_DIR/exports
    "
    podman exec "$CONTAINER" bash -c "
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
    podman exec "$CONTAINER" bash -c "
        cd '$ONLINE_BUILD_DIR/wasm'
        rm -f online.js online.wasm online.worker.js *.o ../**/*.o
    "
fi
podman exec "$CONTAINER" bash -c "
    source /home/builder/emsdk/emsdk_env.sh 2>/dev/null
    cd '$ONLINE_BUILD_DIR'
    emmake make -j\$(nproc) 2>&1
"

echo ""
echo "=== Build complete ==="
echo ""
echo "  Artifacts:"
ls -lh "$REPO_DIR/wasm/online-build/wasm"/online.* 2>/dev/null | awk '{print "    " $NF " (" $5 ")"}'

# ---------- Chown build outputs back to host user ----------
# emcc runs as root inside the container; chown back so finalize-build.sh
# (which runs on the host below) can edit the outputs without sudo.
podman exec "$CONTAINER" chown -R "$(id -u):$(id -g)" "$ONLINE_BUILD_DIR" 2>/dev/null || true

# ---------- Stop container ----------
echo ""
echo "--- Stopping container '$CONTAINER' ---"
podman stop "$CONTAINER" >/dev/null 2>&1

# ---------- Finalize build (snapshot inject + cache-bust + brotli) ----------
# Runs on the HOST (not in the container) so it has access to brotli, node, and
# the tracked source files (wasm/snapshot-inject*.js). All build-time
# content patches go here so deploys can be pure cp + config + ship.
# See wasm/PLAN-deploy-vs-build.md for the rationale.
#
# Skipped with --no-finalize: leaves online.wasm/.js/.worker.js as emcc
# produced them, with no snapshot inject, no cache-bust rename, no brotli,
# and no sw.js/wasm-loader.js fingerprinting. Use this for a vanilla
# Collabora WASM build that can be served by upstream-style cool.html
# directly without the fork's JS-layer plumbing.
if [ "$NO_FINALIZE" = true ]; then
    echo ""
    echo "--- Skipping finalize-build.sh (--no-finalize) ---"
    echo "  Raw emcc outputs in: $REPO_DIR/wasm/online-build/wasm/"
    echo "  No snapshot inject / cache-bust / brotli / sw.js / wasm-loader.js applied."
else
    BROTLI_QUALITY="${BROTLI_QUALITY:-2}"
    echo ""
    echo "--- Finalizing build on host (q${BROTLI_QUALITY}) ---"
    BROTLI_QUALITY="$BROTLI_QUALITY" \
        bash "$SCRIPT_DIR/tools/finalize-build.sh" "$REPO_DIR/wasm/online-build" \
        || echo "  WARNING: finalize-build.sh reported failures"
fi
echo "[OK] Container stopped"
