#!/usr/bin/env bash
# brotli-sidecar.sh — idempotent brotli .br generator.
#
# For each input file, ensures a `<file>.br` sidecar exists alongside.
# Skips files where the existing `.br` is newer than its source — so
# repeat invocations on an unchanged build are a no-op (~ms instead of
# the ~15 min an `online.wasm` recompression takes).
#
# Brotli is deterministic per (input bytes, quality) — using the same
# `.br` from the build for a later deploy produces identical wire bytes
# vs running brotli at deploy time.
#
# Usage:
#   bash wasm/tools/brotli-sidecar.sh path/to/online.wasm path/to/bundle.js …
#
# Env:
#   BROTLI_QUALITY   1-11, default 11 (max ratio)
#   BROTLI_FORCE     "1" to ignore cached .br and regenerate

set -euo pipefail
QUALITY="${BROTLI_QUALITY:-11}"
FORCE="${BROTLI_FORCE:-0}"

if ! command -v brotli >/dev/null 2>&1; then
    echo "ERROR: brotli not found on PATH" >&2
    exit 1
fi

N_DONE=0; N_CACHED=0; N_FAIL=0
for f in "$@"; do
    if [[ ! -f "$f" ]]; then
        echo "  skip (missing): $f"
        continue
    fi
    if [[ "$FORCE" != "1" && -f "$f.br" && "$f.br" -nt "$f" ]]; then
        N_CACHED=$((N_CACHED + 1))
        continue
    fi
    base="$(basename "$f")"
    if brotli -f -q "$QUALITY" "$f" -o "$f.br" 2>/dev/null; then
        size="$(du -h "$f.br" 2>/dev/null | cut -f1)"
        echo "  brotli $base -> ${size:-?}"
        N_DONE=$((N_DONE + 1))
    else
        echo "  ERROR: brotli failed for $f" >&2
        N_FAIL=$((N_FAIL + 1))
    fi
done
echo "brotli-sidecar: ${N_DONE} fresh, ${N_CACHED} cached, ${N_FAIL} failed"
[[ "$N_FAIL" -eq 0 ]]
