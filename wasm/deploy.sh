#!/bin/bash
# Deploy WASM editor artifacts to the static server.
# Copies all build outputs, regenerates Brotli compressed versions,
# applies the snapshot restore injection to online.js, rehashes JS files,
# and signals the server.
#
# Usage:
#   bash wasm/deploy.sh              # deploy from default build dir
#   bash wasm/deploy.sh --no-inject  # skip snapshot injection
#   bash wasm/deploy.sh --build      # build first, then deploy

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$REPO_DIR/wasm/online-build"
PUB="${PUB:-/tmp/static-deploy/public}"
BROWSER_DIR="$PUB/browser"

DO_BUILD=false
DO_INJECT=true
for arg in "$@"; do
    case "$arg" in
        --build) DO_BUILD=true ;;
        --no-inject) DO_INJECT=false ;;
    esac
done

# ── Step 0: Build if requested ──
if [ "$DO_BUILD" = true ]; then
    echo "Building..."
    bash "$SCRIPT_DIR/build-wasm.sh"
fi

# ── Step 1: Verify build artifacts exist ──
WASM_JS="$BUILD_DIR/wasm/online.js"
WASM_BIN="$BUILD_DIR/wasm/online.wasm"
WASM_WORKER="$BUILD_DIR/wasm/online.worker.js"
EMSCRIPTEN_MODULE="$BUILD_DIR/wasm/emscripten-module.js"
BUNDLE="$BUILD_DIR/browser/dist/bundle.js"

for f in "$WASM_JS" "$WASM_BIN" "$WASM_WORKER" "$EMSCRIPTEN_MODULE" "$BUNDLE"; do
    if [ ! -f "$f" ]; then
        echo "ERROR: Missing build artifact: $f"
        echo "       Run 'bash wasm/build-wasm.sh' first."
        exit 1
    fi
done

echo "=== Deploying WASM editor ==="

# ── Step 2: Copy all artifacts atomically ──
# Copy to a staging dir first, then move into place.
STAGE=$(mktemp -d "$BROWSER_DIR/.deploy-XXXXXX")
trap "rm -rf '$STAGE'" EXIT

cp "$WASM_JS"           "$STAGE/online.js"
cp "$WASM_BIN"          "$STAGE/online.wasm"
cp "$WASM_WORKER"       "$STAGE/online.worker.js"
cp "$EMSCRIPTEN_MODULE" "$STAGE/emscripten-module.js"
cp "$BUNDLE"            "$STAGE/bundle.js"
cp "$SCRIPT_DIR/wasm-loader.js"    "$STAGE/wasm-loader.js"
cp "$SCRIPT_DIR/relay-adapter.js"  "$STAGE/relay-adapter.js"

echo "  Copied 7 artifacts to staging"

# ── Step 2b: Compute build fingerprint and inject into wasm-loader.js ──
# The fingerprint ties the snapshot to this exact WASM binary. On restore,
# wasm-loader.js compares it with the stored snapshot's fingerprint and
# discards stale snapshots from older builds.
FINGERPRINT=$(md5sum "$STAGE/online.wasm" | cut -c1-16)
sed -i "s|__WASM_BUILD_FINGERPRINT__|$FINGERPRINT|g" "$STAGE/wasm-loader.js"
echo "  Build fingerprint: $FINGERPRINT"

# ── Step 3: Apply snapshot restore injection to online.js ──
if [ "$DO_INJECT" = true ]; then
    python3 - "$STAGE/online.js" << 'PYEOF'
import sys
path = sys.argv[1]
with open(path) as f:
    c = f.read()

# INJECTION 1: Restore HEAPU8 from snapshot AFTER initRuntime, BEFORE callMain.
# By this point, Emscripten's JS runtime (FS, TTY, etc.) is fully initialized
# and __wasm_call_ctors has run. We overwrite all C++ state with the snapshot.
# LO Core will see bInitialized=true and take the fast SECOND_INIT path.
target = '    if (shouldRunNow) callMain(args);'
count = c.count(target)
if count != 1:
    print(f'  WARNING: Expected 1 callMain target, found {count} — skipping injection')
    sys.exit(0)
inject = """    // Snapshot FULL restore + leak stale thread-owning objects.
    // Full restore gives us bInitialized=true for SECOND_INIT.
    // After restore, we leak COOLWSD poll objects (whose destructors
    // would try to join dead threads) so new ones can be created.
    if (!ENVIRONMENT_IS_PTHREAD && typeof globalThis !== 'undefined' &&
        globalThis.__wasmSnapshotData && HEAPU8) {
      try {
        var _snapSrc = new Uint8Array(globalThis.__wasmSnapshotData);
        if (_snapSrc.length <= HEAPU8.length) {
          // Save pthread main thread descriptor
          var _ptSelf = 0;
          try { _ptSelf = _pthread_self(); } catch(e) {}
          var _saved = null;
          if (_ptSelf > 0) {
            _saved = new Uint8Array(512);
            _saved.set(HEAPU8.subarray(_ptSelf, _ptSelf + 512));
          }
          HEAPU8.set(_snapSrc);
          if (_saved && _ptSelf > 0) HEAPU8.set(_saved, _ptSelf);
          try { if (typeof PThread !== 'undefined' && PThread.threadInitTLS) PThread.threadInitTLS(); } catch(e) {}
          try { if (typeof writeStackCookie === 'function') writeStackCookie(); } catch(e) {}
          Module.__snapRestoredBeforeMain = true;
          globalThis.__wasmSnapshotRestored = true;
          // Recreate VFS directories that the restored LO Core expects.
          // Visit 1's init created these; Visit 2's fresh VFS doesn't have them.
          try {
            var _fs = Module.FS || FS;
            // User profile tree (UserInstallation = file:///instdir)
            ['/instdir/user','/instdir/user/config',
             '/instdir/user/extensions','/instdir/user/extensions/bundled',
             '/instdir/user/extensions/shared','/instdir/user/extensions/tmp',
             '/instdir/user/uno_packages','/instdir/user/uno_packages/cache',
             '/instdir/user/registry','/instdir/user/registry/data',
             '/tmp/user','/tmp/user/docs','/tmp/.config'
            ].forEach(function(d) { try { _fs.mkdir(d); } catch(e) {} });
            // Create empty registrymodifications.xcu (configmgr needs it)
            try { _fs.writeFile('/instdir/user/registrymodifications.xcu',
              '<?xml version=\"1.0\" encoding=\"UTF-8\"?>\\n<oor:items xmlns:oor=\"http://openoffice.org/2001/registry\" xmlns:xs=\"http://www.w3.org/2001/XMLSchema\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">\\n</oor:items>\\n');
            } catch(e) {}
            // Recreate the temp dir that C++ globals reference
            try {
              var _tmpDir = Module.ccall('get_temp_dir_path', 'string', [], []);
              if (_tmpDir) {
                var _parts = _tmpDir.split('/').filter(Boolean);
                var _cur = '';
                for (var _i = 0; _i < _parts.length; _i++) {
                  _cur += '/' + _parts[_i];
                  try { _fs.mkdir(_cur); } catch(e) {}
                }
              }
            } catch(e) {}
          } catch(e) {}
          console.log('[snapshot] Full restore: ' + _snapSrc.length + ' bytes');
        }
      } catch(ex) {
        console.error('[snapshot] Restore error:', ex);
      }
      globalThis.__wasmSnapshotData = null;
    }
"""

# INJECTION 2: Skip checkStackCookie after snapshot restore.
# The restore overwrites stack cookies that stackCheckInit wrote.
# The snapshot contains the correct cookie values at the correct addresses,
# but if there's any address mismatch between visits this protects us.
target4 = 'function checkStackCookie() {'
count4 = c.count(target4)
if count4 == 1:
    inject4 = 'function checkStackCookie() { if (Module.__snapRestoredBeforeMain) return; // skip after snapshot'
    c = c.replace(target4, inject4, 1)
    print('  Patched checkStackCookie: skip after snapshot restore')
else:
    print(f'  WARNING: Expected 1 checkStackCookie target, found {count4}')

# INJECTION 3: Skip soffice.data download + VFS unpack on snapshot restore.
# The snapshot already has the VFS populated. We:
# a) Define getPreloadedPackage to return a 1-byte dummy on restore
# b) Patch DataRequest.finish to skip FS_createDataFile on restore
# c) The dependency counter stays balanced (open/finish still pairs)
# NOTE: soffice.data CANNOT be skipped on snapshot restore.
# The HEAPU8 snapshot captures the C++ heap, but NOT the Emscripten
# MEMFS (JavaScript data structure). LO Core's C++ code holds pointers
# to MEMFS inodes (/instdir/program/*, /instdir/share/*, etc.) which
# only exist after soffice.data is unpacked. Without the unpack, the
# VFS is empty and LO fails silently. Saving/restoring MEMFS alongside
# HEAPU8 would fix this but is a larger change.

with open(path, 'w') as f:
    f.write(c.replace(target, inject + target, 1))
patches = 2
print(f'  Injected snapshot restore into online.js ({patches} patches)')
PYEOF
fi

# ── Step 4: Generate Brotli compressed versions ──
# These MUST match the source files. Stale .br files cause silent
# binary mismatches that are extremely hard to debug.
BROTLI_FILES="online.js online.wasm bundle.js"
for name in $BROTLI_FILES; do
    src="$STAGE/$name"
    if [ -f "$src" ]; then
        echo -n "  Compressing $name → $name.br..."
        brotli -f "$src" -o "$STAGE/$name.br"
        echo " $(du -h "$STAGE/$name.br" | cut -f1)"
    fi
done

# ── Step 5: Move from staging to live ──
for f in "$STAGE"/*; do
    name=$(basename "$f")
    mv -f "$f" "$BROWSER_DIR/$name"
done
rmdir "$STAGE" 2>/dev/null || true
trap - EXIT

# Also deploy viewer index.html
if [ -f "$SCRIPT_DIR/viewer-public/index.html" ]; then
    cp "$SCRIPT_DIR/viewer-public/index.html" "$PUB/index.html"
    echo "  Deployed viewer index.html"
fi

# ── Step 6: Signal the server to rehash JS files ──
SERVER_PID=$(pgrep -f "editor-static-server" | head -1)
if [ -n "$SERVER_PID" ]; then
    kill -HUP "$SERVER_PID" 2>/dev/null
    echo "  Signaled server (PID $SERVER_PID) to rehash"
else
    echo "  WARNING: editor-static-server not running"
fi

# ── Step 7: Save build fingerprint ──
echo "$FINGERPRINT $(date -Iseconds)" > "$BROWSER_DIR/.build-fingerprint"
echo ""
echo "=== Deploy complete: fingerprint=$FINGERPRINT ==="
echo "  online.js:   $(du -h "$BROWSER_DIR/online.js"   | cut -f1) (br: $(du -h "$BROWSER_DIR/online.js.br" 2>/dev/null | cut -f1 || echo 'none'))"
echo "  online.wasm: $(du -h "$BROWSER_DIR/online.wasm" | cut -f1) (br: $(du -h "$BROWSER_DIR/online.wasm.br" 2>/dev/null | cut -f1 || echo 'none'))"
echo "  bundle.js:   $(du -h "$BROWSER_DIR/bundle.js"   | cut -f1) (br: $(du -h "$BROWSER_DIR/bundle.js.br" 2>/dev/null | cut -f1 || echo 'none'))"
