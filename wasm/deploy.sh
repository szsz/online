#!/bin/bash
# Deploy WASM editor artifacts to the static server.
# Copies all build outputs, regenerates Brotli compressed versions,
# applies the snapshot restore injection to online.js, rehashes JS files,
# and signals the server.
#
# Usage:
#   bash wasm/deploy.sh              # deploy from default build dir
#   bash wasm/deploy.sh --no-inject  # skip snapshot injection
#   bash wasm/deploy.sh --no-brotli  # skip .br regeneration (fast local iter)
#   bash wasm/deploy.sh --build      # build first, then deploy

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="${BUILD_DIR:-$REPO_DIR/wasm/online-build}"
PUB="${PUB:-/tmp/static-deploy/public}"
BROWSER_DIR="$PUB/browser"

# ── Deploy lock ──
# Prevents two deploys from racing on $BROWSER_DIR (which is what bit us
# when an ad-hoc brotli run overlapped the deploy's brotli step and a
# truncated online.wasm.br was served to live browsers).
LOCK_FILE="${LOCK_FILE:-/tmp/online-deploy.lock}"
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
    echo "ERROR: another deploy is running (lock at $LOCK_FILE). Wait for it, or pass LOCK_FILE=/dev/null to override." >&2
    exit 1
fi

DO_BUILD=false
DO_INJECT=true
DO_BROTLI=true
DO_SMOKE=true
for arg in "$@"; do
    case "$arg" in
        --build) DO_BUILD=true ;;
        --no-inject) DO_INJECT=false ;;
        --no-brotli) DO_BROTLI=false ;;
        --no-smoke) DO_SMOKE=false ;;
    esac
done

# ── Step 0: Build if requested ──
if [ "$DO_BUILD" = true ]; then
    echo "Building..."
    bash "$SCRIPT_DIR/build-wasm.sh"
fi

# ── Step 1: Verify build artifacts exist ──
# Prefer paths under $BUILD_DIR/wasm/ (where the Emscripten link step
# writes), but fall back to the parallel $BUILD_DIR/browser/dist/ copies —
# for some local builds the wasm/ directory is owned by root or contains
# a symlink to dist/, and the dist/ set is what the browser actually loads.
WASM_WORKER="$BUILD_DIR/wasm/online.worker.js"
EMSCRIPTEN_MODULE="$BUILD_DIR/wasm/emscripten-module.js"
BUNDLE="$BUILD_DIR/browser/dist/bundle.js"

# Paired online.{js,wasm}: these two must come from the SAME source dir.
# Mixing a fresh online.js with an older online.wasm (or vice-versa) will
# decode fine but fail to instantiate with
# 'CompileError: section extends past end of the module'. Pick the first
# directory that has both, and refuse to mix.
PAIRED_DIR=""
for d in "$BUILD_DIR/browser/dist" "$BUILD_DIR/wasm"; do
    if [ -f "$d/online.js" ] && [ -f "$d/online.wasm" ]; then
        PAIRED_DIR="$d"; break
    fi
done
if [ -z "$PAIRED_DIR" ]; then
    echo "ERROR: no directory contains BOTH online.js and online.wasm."
    echo "       Checked: $BUILD_DIR/browser/dist  $BUILD_DIR/wasm"
    echo "       Run 'bash wasm/build-wasm.sh' first."
    exit 1
fi
WASM_JS="$PAIRED_DIR/online.js"
WASM_BIN="$PAIRED_DIR/online.wasm"
# Loudly warn if the other copy diverges — a background rebuild could
# silently flip which tree is fresh.
OTHER_DIR="$BUILD_DIR/browser/dist"
[ "$PAIRED_DIR" = "$OTHER_DIR" ] && OTHER_DIR="$BUILD_DIR/wasm"
if [ -f "$OTHER_DIR/online.wasm" ] && \
   ! cmp -s "$WASM_BIN" "$OTHER_DIR/online.wasm"; then
    echo "  WARNING: $OTHER_DIR/online.wasm differs from the picked copy."
    echo "    picked:  $(md5sum "$WASM_BIN"             | cut -c1-16)  $WASM_BIN"
    echo "    discard: $(md5sum "$OTHER_DIR/online.wasm" | cut -c1-16)  $OTHER_DIR/online.wasm"
fi
echo "Paired online.{js,wasm} source: $PAIRED_DIR"

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
    # Silently skipping used to ship a viewer whose "warm" visit was
    # slower than the cold visit — the restore branch was simply not
    # in online.js. Refuse to finish so a broken deploy is caught
    # immediately.
    print(f'  ERROR: Expected 1 callMain target, found {count} — snapshot restore cannot be injected')
    print(f'         The target string `{target}` must appear exactly once.')
    sys.exit(1)
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
          // Tell C++ via the synchronous atomic — Desktop::Main reads this
          // from a worker thread later and a MAIN_THREAD_EM_ASM_INT proxy
          // would deadlock against the long-returned WASM main thread.
          try { Module.ccall('wasm_set_warm_restored', null, ['number'], [1]); } catch(e) {}
          // Plan C — clear the quiesce flag carried over from the snapshot.
          // The snapshot was captured with the kit thread holding quiesce=1
          // and the COOLWSD thread parked. On warm restore the COOLWSD
          // thread is freshly spawned (Web Workers don't survive); we want
          // it to enter its main loop normally without re-parking. Without
          // this clear the new COOLWSD thread would self-park and wait
          // forever for a resume signal that never comes.
          try { Module.ccall('wasm_set_quiesce', null, ['number'], [0]); } catch(e) {}
          // Reinitialize the mutex/CV pairs that were captured mid-park.
          // Without this the new threads dereference dangling waiter
          // pointers in the captured pthread structs and trap with
          // "RuntimeError: unreachable" during the first cond/mutex op.
          console.log('WARM_DBG: about to call wasm_warm_restore_reset');
          try { Module.ccall('wasm_warm_restore_reset', null, [], []);
              console.log('WARM_DBG: wasm_warm_restore_reset returned OK');
          } catch(e) {
              console.warn('wasm_warm_restore_reset failed:', e);
          }
          // SolarMutex was held by a captured-but-now-dead thread. Reset
          // ownership so a fresh thread can acquire/release without
          // hitting IsCurrentThread() abort in doRelease. (Defense-in-
          // depth — the cold-side firstDocPainted release-before-park
          // change should leave the SolarMutex unowned at capture, so
          // this should be a no-op going forward.)
          try { Module.ccall('wasm_warm_restore_solar_mutex_reset', null, [], []);
              console.log('WARM_DBG: SolarMutex reset OK');
          } catch(e) {
              console.warn('SolarMutex reset failed:', e);
          }
          // SvpSalYieldMutex (the actual VCL yield mutex used on every
          // lo_runLoop iteration) holds 7 internal mutex/CV/state members
          // whose pthread waiter lists in the captured snapshot reference
          // the dead cold thread. Plus SvpSalInstance::m_MainThread holds
          // the cold lokit_main thread id, so IsMainThread() returns false
          // on every warm thread. Placement-new the members and refresh
          // m_MainThread so the warm path is deterministic.
          try { Module.ccall('wasm_warm_restore_yield_mutex_reset', null, [], []);
              console.log('WARM_DBG: YieldMutex reset OK');
          } catch(e) {
              console.warn('YieldMutex reset failed:', e);
          }
          // FakeSocket's global theMutex/theCV are touched by every kit↔COOLWSD
          // message. Captured waiter list points at dead cold threads.
          try { Module.ccall('wasm_warm_restore_fakesocket_reset', null, [], []);
              console.log('WARM_DBG: FakeSocket reset OK');
          } catch(e) {
              console.warn('FakeSocket reset failed:', e);
          }
          // comphelper::ThreadPool static singleton's worker threads are
          // dead cold pthreads on warm. Calling getSharedOptimalPool()
          // would dispatch to dead workers (Calc multi-thread recalc, image
          // decode). Replace the singleton with a fresh pool — old pool is
          // intentionally leaked to avoid invoking ~ThreadPool() which would
          // try to join the dead pthreads.
          try { Module.ccall('wasm_warm_restore_threadpool_reset', null, [], []);
              console.log('WARM_DBG: ThreadPool reset OK');
          } catch(e) {
              console.warn('ThreadPool reset failed:', e);
          }
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
          // Patch PThread machinery so we can observe worker spawns on warm-restore
          try {
            if (typeof PThread !== 'undefined') {
              var _origAlloc = PThread.allocateUnusedWorker.bind(PThread);
              PThread.allocateUnusedWorker = function() {
                console.log('WARM_DBG: PThread.allocateUnusedWorker called');
                var _r = _origAlloc();
                var _w = PThread.unusedWorkers[PThread.unusedWorkers.length - 1];
                if (_w) {
                  _w.addEventListener('error', function(e) {
                    console.error('WARM_DBG: WORKER ERROR ' + (e.filename||'') + ':' + (e.lineno||'') + ' ' + (e.message||''));
                  });
                  _w.addEventListener('messageerror', function(e) {
                    console.error('WARM_DBG: WORKER MESSAGEERROR ' + e);
                  });
                }
                return _r;
              };
              var _origLoadMod = PThread.loadWasmModuleToWorker.bind(PThread);
              PThread.loadWasmModuleToWorker = function(w) {
                console.log('WARM_DBG: PThread.loadWasmModuleToWorker called workerID=' + (w && w.workerID));
                var _origOnMsg = w.onmessage;
                var _p = _origLoadMod(w);
                var _wrappedOnMsg = w.onmessage;
                w.onmessage = function(e) {
                  if (e && e.data && e.data.cmd) {
                    console.log('WARM_DBG: worker->main msg cmd=' + e.data.cmd + ' workerID=' + w.workerID);
                  }
                  return _wrappedOnMsg.call(w, e);
                };
                // postMessage wrapper REMOVED. Earlier iterations (9–13)
                // wrapped w.postMessage to log main->worker cmd; in V8/
                // Chromium passing `undefined` as the second arg of
                // `worker.postMessage(msg, undefined)` is not equivalent
                // to omitting it (it serializes a transferList with one
                // element of `undefined`, which can corrupt the run cmd
                // payload). Reverted to ungated dispatch — observed
                // calc/impress warm hangs to disappear.
                return _p;
              };
            }
          } catch(e) { console.warn('WARM_DBG: PThread instrumentation failed', e); }
          console.log('WARM_DBG: inject block done, about to fall through to callMain');
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

# INJECTION 3: Suppress checkMailbox/mailbox_await console spam.
# Emscripten's Atomics.waitAsync().then(checkMailbox) creates an infinite
# Promise chain. Chrome shows "checkMailbox @ online.js:9725" and
# "__emscripten_thread_mailbox_await @ online.js:9708" in the console
# as resolved Promise async stack frames. Fix: remove the assert (which
# can log) and silence the recursive .then chain via a no-name wrapper.
target7 = 'assert(wait.async);\n        wait.value.then(checkMailbox);'
count7 = c.count(target7)
if count7 >= 1:
    c = c.replace(target7, 'if(wait.async)wait.value.then(function _mb(){checkMailbox();});', 1)
    print('  Patched mailbox: removed assert + silenced .then chain')
else:
    # Try without the newline (minified builds)
    target7b = 'assert(wait.async);wait.value.then(checkMailbox);'
    if c.count(target7b) >= 1:
        c = c.replace(target7b, 'if(wait.async)wait.value.then(function _mb(){checkMailbox();});', 1)
        print('  Patched mailbox: removed assert + silenced .then chain (compact)')
    else:
        print('  NOTE: checkMailbox patch target not found — skipping')

with open(path, 'w') as f:
    f.write(c.replace(target, inject + target, 1))
patches = 2
print(f'  Injected snapshot restore into online.js ({patches} patches)')
PYEOF
fi

# ── Step 4: Generate Brotli compressed versions ──
# These MUST match the source files. Stale .br files cause silent
# binary mismatches that are extremely hard to debug — so when
# --no-brotli skips regeneration, we also drop any existing .br so
# the server falls back to plain content instead of serving a
# mismatched payload.
BROTLI_FILES="online.js online.wasm bundle.js"
if [ "$DO_BROTLI" = true ]; then
    for name in $BROTLI_FILES; do
        src="$STAGE/$name"
        if [ -f "$src" ]; then
            echo -n "  Compressing $name → $name.br..."
            brotli -f "$src" -o "$STAGE/$name.br"
            echo " $(du -h "$STAGE/$name.br" | cut -f1)"
        fi
    done
else
    # Skip brotli. For each file: if the existing live .br is still
    # in sync with the new source (same bytes), keep it so the server
    # can keep serving compressed. If bytes differ, drop the .br so
    # the server falls back to plain rather than shipping a stale
    # mismatched payload. "Same bytes" is approximated by comparing
    # md5 of the STAGE source to md5 of the current live source —
    # cheap and correct for this use case.
    echo "  [--no-brotli] Skipping .br regeneration"
    for name in $BROTLI_FILES; do
        stage="$STAGE/$name"
        live="$BROWSER_DIR/$name"
        live_br="$BROWSER_DIR/$name.br"
        if [ ! -f "$live_br" ] || [ ! -f "$live" ]; then
            continue
        fi
        if cmp -s "$stage" "$live" 2>/dev/null; then
            cp -f "$live_br" "$STAGE/$name.br"
            echo "  [--no-brotli] $name unchanged → kept existing .br"
        else
            rm -f "$live_br"
            echo "  [--no-brotli] $name CHANGED → dropping stale .br"
        fi
    done
fi

# ── Step 4b: Integrity check on the .br files in staging ──
# Catches the truncated-Brotli class of bugs (concurrent writes to the
# live .br file, brotli process killed mid-stream, etc.) BEFORE we
# move the staging dir to live. Any mismatch fails the deploy with
# the staged dir intact for inspection.
for name in $BROTLI_FILES; do
    src="$STAGE/$name"
    br="$STAGE/$name.br"
    if [ -f "$br" ] && [ -f "$src" ]; then
        # Decompress to /dev/null and compare byte counts. Faster than
        # round-tripping to disk; still catches truncation.
        src_bytes=$(stat -c %s "$src")
        decomp_bytes=$(brotli -d -c "$br" 2>/dev/null | wc -c)
        if [ "$src_bytes" != "$decomp_bytes" ]; then
            echo "ERROR: $name.br decompressed to $decomp_bytes bytes; expected $src_bytes (staging at $STAGE)" >&2
            exit 1
        fi
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

# ── Also deploy dict-loader.js + /dicts/ for lazy spellcheck dicts ──
# dict-loader.js is served alongside wasm-loader and hashed via SIGHUP
# on the editor-static. /dicts/<lang>.tar.gz + /dicts/manifest.json are
# generated by wasm/build-dicts.sh; we copy them into $PUB/dicts/ so
# that the editor-static (PUB-rooted) serves them at /dicts/.
if [ -f "$SCRIPT_DIR/dict-loader.js" ]; then
    cp "$SCRIPT_DIR/dict-loader.js" "$BROWSER_DIR/dict-loader.js"
    if [ "$DO_BROTLI" = true ] && command -v brotli >/dev/null 2>&1; then
        brotli -f -q 11 "$BROWSER_DIR/dict-loader.js"
    else
        rm -f "$BROWSER_DIR/dict-loader.js.br"
    fi
    echo "  Deployed dict-loader.js"
fi
DICTS_SRC="$SCRIPT_DIR/online-build/dicts"
if [ -d "$DICTS_SRC" ] && ls "$DICTS_SRC"/*.tar.gz >/dev/null 2>&1; then
    mkdir -p "$PUB/dicts"
    cp -f "$DICTS_SRC"/*.tar.gz "$PUB/dicts/" 2>/dev/null || true
    cp -f "$DICTS_SRC/manifest.json" "$PUB/dicts/manifest.json"
    chmod -R a+r "$PUB/dicts"
    DICT_COUNT=$(ls "$PUB/dicts"/*.tar.gz 2>/dev/null | wc -l)
    DICT_SIZE=$(du -sh "$PUB/dicts" 2>/dev/null | cut -f1)
    echo "  Deployed $DICT_COUNT language dict bundles ($DICT_SIZE) → $PUB/dicts/"
else
    echo "  No dict bundles — run 'bash wasm/build-dicts.sh' to produce them"
fi

# ── Strip the branding-{desktop,mobile,tablet}.css load from global.js ──
# The stock global.js appends a <link rel="stylesheet" href="branding-desktop.css">
# whose target file doesn't exist in our deploy (we don't ship integrator
# themes). Removing the insertion silences the 404 in the browser console
# without needing the empty-file fallback. cool.html's <link> and <script>
# branding references are stripped at request time by editor-static-server.js.
GLOBAL_JS="$BROWSER_DIR/global.js"
if [ -f "$GLOBAL_JS" ] && grep -q 'insertAdjacentElement("afterend",brandingLink)' "$GLOBAL_JS"; then
    sed -i 's|\.insertAdjacentElement("afterend",link)\.insertAdjacentElement("afterend",brandingLink)|.insertAdjacentElement("afterend",link)|g' "$GLOBAL_JS"
    if [ "$DO_BROTLI" = true ] && command -v brotli >/dev/null 2>&1; then
        brotli -f -q 11 "$GLOBAL_JS"
    else
        rm -f "$GLOBAL_JS.br"
    fi
    echo "  Patched global.js: stripped branding-<form>.css load"
fi

# ── Step 6: Signal the server to rehash JS files ──
SERVER_PID=$(pgrep -f "editor-static-server" | head -1)
if [ -n "$SERVER_PID" ]; then
    kill -HUP "$SERVER_PID" 2>/dev/null
    echo "  Signaled editor-static (PID $SERVER_PID) to rehash"
else
    echo "  WARNING: editor-static-server not running"
fi

# ── Step 6b: Restart the message-relay ──
# After shipping new JS, any client still on the old WebSocket is
# running mismatched code — could interpret a frame wrong, register a
# bad checkpoint, or deadlock late-joiners. Cleanest fix: kill the
# relay so every peer reconnects against the new build. launch-relay.sh
# sources .env and picks the right TLS cert.
RELAY_PID=$(pgrep -f "node.*message-relay" | head -1)
if [ -n "$RELAY_PID" ]; then
    kill "$RELAY_PID" 2>/dev/null || true
    # Wait for the old process to release port 9091.
    for _i in 1 2 3 4 5; do
        pgrep -f "node.*message-relay" >/dev/null 2>&1 || break
        sleep 1
    done
    nohup bash "$SCRIPT_DIR/launch-relay.sh" > /tmp/relay.log 2>&1 &
    sleep 2
    NEW_RELAY_PID=$(pgrep -f "node.*message-relay" | head -1)
    if [ -n "$NEW_RELAY_PID" ]; then
        echo "  Restarted message-relay: $RELAY_PID → $NEW_RELAY_PID (every client will reconnect against the new build)"
    else
        echo "  WARNING: relay failed to restart — check /tmp/relay.log"
    fi
else
    echo "  NOTE: message-relay not running — starting fresh"
    nohup bash "$SCRIPT_DIR/launch-relay.sh" > /tmp/relay.log 2>&1 &
    sleep 2
fi

# ── Step 7: Save build fingerprint ──
echo "$FINGERPRINT $(date -Iseconds)" > "$BROWSER_DIR/.build-fingerprint"
echo ""
echo "=== Deploy complete: fingerprint=$FINGERPRINT ==="
echo "  online.js:   $(du -h "$BROWSER_DIR/online.js"   | cut -f1) (br: $(du -h "$BROWSER_DIR/online.js.br" 2>/dev/null | cut -f1 || echo 'none'))"
echo "  online.wasm: $(du -h "$BROWSER_DIR/online.wasm" | cut -f1) (br: $(du -h "$BROWSER_DIR/online.wasm.br" 2>/dev/null | cut -f1 || echo 'none'))"
echo "  bundle.js:   $(du -h "$BROWSER_DIR/bundle.js"   | cut -f1) (br: $(du -h "$BROWSER_DIR/bundle.js.br" 2>/dev/null | cut -f1 || echo 'none'))"

# ── Step 8: Smoke test ──
# 60-90s headless puppeteer: opens a known fixture URL, waits for the
# editor's iframe to render a real-sized canvas. Catches truncated
# brotli, broken snapshot injection, and broken WASM init that the
# file-level integrity check above can't see. Skip with --no-smoke.
if [ "$DO_SMOKE" = true ] && [ -f "$SCRIPT_DIR/test-deploy-smoke.js" ]; then
    echo ""
    echo "── Smoke test ──"
    if (cd "$SCRIPT_DIR" && node test-deploy-smoke.js); then
        :
    else
        echo "  WARNING: smoke test FAILED — deploy artifacts are live but may not work"
        echo "  See /tmp/smoke-fail.png for the failing render"
        # Don't exit non-zero: the user may want to investigate against
        # the live deploy. The loud warning is the gate.
    fi
fi
