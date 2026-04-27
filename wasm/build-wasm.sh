#!/bin/bash
# Build Collabora Online WASM binary.
# First run: sets up Docker environment, gets LO Core (build or download), configures and builds Online.
# Subsequent runs: make detects changed source files and only recompiles what changed.
#
# Usage:
#   bash wasm/build-wasm.sh              # build (incremental if already built)
#   bash wasm/build-wasm.sh --setup      # setup only (pull image, create container, no build)
#   bash wasm/build-wasm.sh --clean      # force full rebuild of Online (not core)
#   bash wasm/build-wasm.sh --rebuild-core  # force full rebuild of LO Core
#   bash wasm/build-wasm.sh --container-name=my-test  # override container name
#
# LO Core source: by default the host's $HOME/libreoffice-core-wasm checkout
# is bind-mounted into the container at /lo/core, so edits on the host are
# immediately visible to the build. Push to the GitHub fork via
# wasm/publish-fork.sh when you want to share with other machines/CI.
#
# To force clone-from-GitHub instead (e.g., on a fresh CI machine), set
# LO_CORE_HOST_DIR= (empty). The container will then `git clone` from
# $LO_CORE_REPO and `git fetch + reset --hard` on subsequent builds.

set -e

# Prevent MSYS/Git-Bash from mangling Unix paths passed to Docker (no-op on Linux)
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTAINER="lo-wasm-server"
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
for arg in "$@"; do
    case "$arg" in
        --setup) SETUP_ONLY=true ;;
        --clean) CLEAN=true ;;
        --rebuild-core) REBUILD_CORE=true ;;
        --build-core) BUILD_CORE=true ;;
        --container-name=*) CONTAINER="${arg#*=}" ;;
    esac
done

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

# Decide whether to bind-mount the host's LO core checkout (opt-in)
LO_CORE_MOUNT_ARGS=()
if [ -n "$LO_CORE_HOST_DIR" ]; then
    if [ -d "$LO_CORE_HOST_DIR/.git" ]; then
        LO_CORE_MOUNT_ARGS=(-v "$LO_CORE_HOST_DIR":"$CONTAINER_CORE_DIR")
        echo "[OK] LO Core bind-mount: $LO_CORE_HOST_DIR → $CONTAINER_CORE_DIR"
    else
        echo "[!] LO_CORE_HOST_DIR=$LO_CORE_HOST_DIR has no .git; falling back to clone-from-fork"
    fi
else
    echo "[OK] LO Core: clone-from-fork ($LO_CORE_REPO @ $LO_CORE_BRANCH)"
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

# ---------- Configure Online (first time or --clean) ----------
if ! docker exec "$CONTAINER" test -f "$ONLINE_BUILD_DIR/wasm/Makefile" 2>/dev/null || [ "$CLEAN" = true ]; then
    echo "--- Configuring Online ---"
    docker exec "$CONTAINER" bash -c "
        mkdir -p '$ONLINE_BUILD_DIR'
        EXPORTS_DIR=/lo/core-build/workdir/CustomTarget/desktop/soffice_bin-emscripten-exports
        if [ ! -f \$EXPORTS_DIR/exports ]; then
            mkdir -p \$EXPORTS_DIR
            printf '_main\n_libreofficekit_hook\n_libreofficekit_hook_2\n_lok_preinit\n_lok_preinit_2\n_doc_postUnoCommand\n' > \$EXPORTS_DIR/exports
        fi
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
echo ""
echo "  Artifacts:"
ls -lh "$REPO_DIR/wasm/online-build/wasm"/online.* 2>/dev/null | awk '{print "    " $NF " (" $5 ")"}'

# ---------- Stop container ----------
echo ""
echo "--- Stopping container '$CONTAINER' ---"
docker stop "$CONTAINER" >/dev/null 2>&1
echo "[OK] Container stopped"
