#!/bin/bash
# Build split WASM binaries: online-writer.wasm, online-calc.wasm, online-impress.wasm
# Runs inside the Docker container. Uses the existing configured build.
#
# Usage (from host):
#   docker exec lo-wasm-server bash /lo/online/wasm/build-split.sh
#
# Each binary includes only COMMON + type-specific LO Core libraries.
# soffice.data is shared across all types.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="/lo/online/wasm/online-build/wasm"
CORE_BUILD="/lo/core-build"
LINKDEPS="$CORE_BUILD/instdir/program/soffice.js.linkdeps"
FILTER="$SCRIPT_DIR/filter-linkdeps.sh"

source /home/builder/emsdk/emsdk_env.sh 2>/dev/null

cd "$BUILD_DIR"

if [ ! -f "$LINKDEPS" ]; then
    echo "ERROR: $LINKDEPS not found. Build core first."
    exit 1
fi

# Read the existing Makefile to extract link flags
# We need: object files, LDFLAGS, LDADD (POCO + zstd + core linkdeps + unoembind)
POCO_LIBS="/usr/local/lib/libPocoEncodings.a /usr/local/lib/libPocoNet.a /usr/local/lib/libPocoUtil.a /usr/local/lib/libPocoXML.a /usr/local/lib/libPocoJSON.a /usr/local/lib/libPocoFoundation.a"
ZSTD_LIB="/usr/local/lib/libzstd.a"
UNOEMBIND="$CORE_BUILD/workdir/LinkTarget/StaticLibrary/libunoembind.a"
EXPORTS="$BUILD_DIR/exports"

# Collect all .o files from the build (they're in subdirectories)
OBJ_FILES=$(find "/lo/online/wasm/online-build" -name '*.o' -type f | sort | tr '\n' ' ')

if [ -z "$OBJ_FILES" ]; then
    echo "ERROR: No .o files found in $BUILD_DIR. Run the normal build first."
    exit 1
fi

# Common LDFLAGS (from Makefile.am)
LDFLAGS="-pthread -s MODULARIZE -s EXPORT_NAME=createOnlineModule -s USE_PTHREADS=1 -s TOTAL_MEMORY=1GB -s PTHREAD_POOL_SIZE_STRICT=0 --bind -s FORCE_FILESYSTEM=1 -s WASM_BIGINT=1 -s ERROR_ON_UNDEFINED_SYMBOLS=1 -s FETCH=1 -s ASSERTIONS=1 -s EXIT_RUNTIME=0"
LDFLAGS="$LDFLAGS -s EXPORTED_RUNTIME_METHODS=[\"UTF16ToString\",\"stringToUTF16\",\"UTF8ToString\",\"stringToNewUTF8\",\"ccall\",\"cwrap\",\"FS\",\"registerType\",\"ClassHandle\",\"HEAPU16\",\"HEAPU32\"]"
LDFLAGS="$LDFLAGS -pthread -s USE_PTHREADS=1 -fwasm-exceptions -s EXPORTED_FUNCTIONS=@$EXPORTS"
# Generate stubs for excluded component factory symbols.
# libcomponentslo.a registers ALL UNO components but we only link a subset.
# Stubs return NULL so the component manager skips missing types gracefully.
# Per-type stubs will be generated inside the build loop below

# Pre/post JS files
PREJS="--pre-js /lo/core/static/emscripten/environment.js --pre-js $CORE_BUILD/workdir/CustomTarget/static/emscripten_fs_image/soffice.data.js.link"
POSTJS="--post-js $CORE_BUILD/workdir/CustomTarget/static/unoembind/bindings_uno.js --post-js /lo/core/static/emscripten/uno.js"

NPROC=$(nproc)

for TYPE in writer calc impress; do
    echo ""
    echo "=========================================="
    echo "  Building online-${TYPE}"
    echo "=========================================="

    # Filter linkdeps for this type
    FILTERED_DEPS=$(cat "$LINKDEPS" | bash "$FILTER" "$TYPE")

    OUTPUT="online-${TYPE}"

    # Generate type-specific stubs for missing component factories
    STUB_FILE="/tmp/stubs_${TYPE}.c"
    STUB_OBJ="/tmp/stubs_${TYPE}.o"
    UNDEF_FILE="/tmp/undef_${TYPE}.txt"
    if [ -s "$UNDEF_FILE" ]; then
        echo "// Stubs for ${TYPE} - excluded component factories" > "$STUB_FILE"
        while read sym; do
            echo "void* ${sym}(void* a, void* b) { return (void*)0; }" >> "$STUB_FILE"
        done < "$UNDEF_FILE"
        emcc -c -fwasm-exceptions -pthread -s USE_PTHREADS=1 "$STUB_FILE" -o "$STUB_OBJ" 2>/dev/null
        echo "  $(wc -l < "$UNDEF_FILE") stubs for ${TYPE}"
    else
        STUB_OBJ=""
        echo "  No stubs needed for ${TYPE}"
    fi

    echo "Linking ${OUTPUT}.js ..."
    em++ \
        $OBJ_FILES \
        $STUB_OBJ \
        $POCO_LIBS \
        $ZSTD_LIB \
        -L$CORE_BUILD/instdir/program \
        $FILTERED_DEPS \
        $UNOEMBIND \
        $LDFLAGS \
        $PREJS \
        $POSTJS \
        -o "${OUTPUT}.js" \
        2>&1

    if [ -f "${OUTPUT}.js" ] && [ -f "${OUTPUT}.wasm" ]; then
        JS_SIZE=$(stat -c%s "${OUTPUT}.js")
        WASM_SIZE=$(stat -c%s "${OUTPUT}.wasm")
        echo "[OK] ${OUTPUT}.js  ($(echo "$JS_SIZE/1048576" | bc)M)"
        echo "[OK] ${OUTPUT}.wasm ($(echo "$WASM_SIZE/1048576" | bc)M)"
    else
        echo "[FAIL] ${OUTPUT} link failed"
    fi
done

echo ""
echo "=========================================="
echo "  Build Summary"
echo "=========================================="
for TYPE in writer calc impress; do
    if [ -f "online-${TYPE}.wasm" ]; then
        sz=$(stat -c%s "online-${TYPE}.wasm")
        echo "  online-${TYPE}.wasm: $(echo "$sz/1048576" | bc)M"
    else
        echo "  online-${TYPE}.wasm: MISSING"
    fi
done
echo "  soffice.data: $(stat -c%s soffice.data 2>/dev/null | awk '{printf "%.0fM\n", $1/1048576}') (shared)"
echo ""
echo "Done."
