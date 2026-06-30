#!/bin/bash
# Post-build: inject WASM memory snapshot restore into online.js
# Inserts code right before callMain() in the Emscripten run() function.
# At this point: stackCheckInit done, initRuntime done, preMain done.
# No user threads exist yet. Safe to overwrite HEAPU8.

ONLINE_JS="$1"
if [ ! -f "$ONLINE_JS" ]; then
    echo "Usage: $0 <path-to-online.js>"
    exit 1
fi

# The injection point: "if (shouldRunNow) callMain(args);"
# We insert snapshot restore BEFORE this line.
INJECT='
    // ── WASM Memory Snapshot Restore ──
    // Injected by patch-snapshot.sh. Runs AFTER initRuntime (stack/FS/ctors)
    // but BEFORE callMain. No threads exist yet — safe to overwrite HEAPU8.
    if (typeof globalThis !== "undefined" && globalThis.__wasmSnapshotData && HEAPU8) {
      var _snapSrc = new Uint8Array(globalThis.__wasmSnapshotData);
      if (_snapSrc.length <= HEAPU8.length) {
        HEAPU8.set(_snapSrc);
        globalThis.__wasmSnapshotRestored = true;
      }
      globalThis.__wasmSnapshotData = null; // free memory
    }
'

# Use sed to inject BEFORE the callMain line
sed -i "/if (shouldRunNow) callMain(args);/i\\${INJECT}" "$ONLINE_JS"

echo "Patched $ONLINE_JS with snapshot restore"
