#!/usr/bin/env bash
# finalize-build.sh — apply build-time content patches to online-build/.
#
# This is called as the LAST step of build-wasm.sh and the CI's
# build-online.sh. Everything in this script used to live in the
# deploy scripts (deploy.sh and deploy-azure.sh), where it drifted —
# the warm-restore reset block was added to deploy.sh one ccall at a
# time as bugs were diagnosed, and deploy-azure.sh was never kept in
# sync, which is why warm-restore hung on Azure but worked on local.
#
# After this script runs, online-build/ is "complete":
# subsequent deploys are pure cp + config + ship + smoke. No more
# `python3 -c` / `sed -i` on JS bytes inside deploy scripts.
#
# Order matters:
#   1. Snapshot inject  — modify online.js bytes
#   2. checkStackCookie/mailbox patches — modify online.js bytes
#   3. emscripten-module locateFile — modify emscripten-module.js bytes
#   4. global.js branding strip — modify global.js bytes
#   5. Fingerprint substitution — modify wasm-loader.js + sw.js bytes
#   6. Cache-bust rename — rename files, rewrite cool.html
#   7. Brotli sidecars — compress the (now cache-bust-renamed) files
#
# All steps are idempotent — running this on an already-finalized
# tree is a no-op (each step detects "already applied" and skips).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WASM_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="${1:-$WASM_DIR/online-build}"

if [ ! -d "$BUILD_DIR" ]; then
    echo "ERROR: build dir $BUILD_DIR not found" >&2
    exit 1
fi

ONLINE_JS_WASM="$BUILD_DIR/wasm/online.js"
ONLINE_JS_DIST="$BUILD_DIR/browser/dist/online.js"
EMSCRIPTEN_MODULE_WASM="$BUILD_DIR/wasm/emscripten-module.js"
EMSCRIPTEN_MODULE_DIST="$BUILD_DIR/browser/dist/emscripten-module.js"
GLOBAL_JS="$BUILD_DIR/browser/dist/global.js"
WASM_LOADER="$WASM_DIR/wasm-loader.js"   # source — modified in place by Online's deploy.sh today, will be staged by deploy
SW_JS="$WASM_DIR/sw.js"

echo "──────────────────────────────────────────────────────────────"
echo " finalize-build.sh on $BUILD_DIR"
echo "──────────────────────────────────────────────────────────────"

# ── Step 1: Snapshot inject into online.js ────────────────────────
# Spliced before `if (shouldRunNow) callMain(args);`. Idempotent:
# skipped when `__wasmSnapshotData` already present in the file.
INJECT_JS="$WASM_DIR/snapshot-inject.js"
[ -f "$INJECT_JS" ] || { echo "ERROR: $INJECT_JS missing" >&2; exit 1; }

apply_snapshot_inject() {
    local target="$1"
    [ -f "$target" ] || { echo "  skip (missing): $target"; return 0; }

    if grep -q '__wasmSnapshotData' "$target"; then
        echo "  skip (already injected): $target"
        return 0
    fi

    python3 - "$target" "$INJECT_JS" <<'PYEOF'
import sys
target_path, inject_path = sys.argv[1], sys.argv[2]
with open(target_path) as f:
    c = f.read()
with open(inject_path) as f:
    inject_body = f.read()

ANCHOR = '    if (shouldRunNow) callMain(args);'
if c.count(ANCHOR) != 1:
    print(f'ERROR: {target_path}: expected 1 callMain anchor, found {c.count(ANCHOR)}', file=sys.stderr)
    sys.exit(1)
c = c.replace(ANCHOR, inject_body + ANCHOR, 1)

# checkStackCookie: skip after snapshot restore
csc_anchor = 'function checkStackCookie() {'
if c.count(csc_anchor) == 1:
    c = c.replace(csc_anchor,
                  csc_anchor + ' if (Module.__snapRestoredBeforeMain) return; // skip after snapshot',
                  1)
elif c.count(csc_anchor) == 0:
    pass  # already patched
else:
    print(f'ERROR: {target_path}: expected ≤1 checkStackCookie anchor, found {c.count(csc_anchor)}', file=sys.stderr)
    sys.exit(1)

# Mailbox spam silencer (Atomics.waitAsync().then(checkMailbox) infinite chain)
for mb in ('assert(wait.async);\n        wait.value.then(checkMailbox);',
           'assert(wait.async);wait.value.then(checkMailbox);'):
    if mb in c:
        c = c.replace(mb, 'if(wait.async)wait.value.then(function _mb(){checkMailbox();});', 1)
        break

with open(target_path, 'w') as f:
    f.write(c)
print(f'  patched: {target_path}')
PYEOF
}

echo "  Step 1: snapshot inject (online.js)"
apply_snapshot_inject "$ONLINE_JS_WASM"
apply_snapshot_inject "$ONLINE_JS_DIST"

# ── Step 2: emscripten-module locateFile ──────────────────────────
# Re-injects locateFile into the Module returned by createEmscriptenModule
# so cache-busted online.<hash>.wasm resolves via window.__assetMap.
LOCATE_JS="$WASM_DIR/snapshot-inject-locate-file.js"
[ -f "$LOCATE_JS" ] || { echo "ERROR: $LOCATE_JS missing" >&2; exit 1; }

apply_locate_file_inject() {
    local target="$1"
    [ -f "$target" ] || { echo "  skip (missing): $target"; return 0; }

    if grep -q '__assetMap' "$target"; then
        echo "  skip (already patched): $target"
        return 0
    fi

    python3 - "$target" "$LOCATE_JS" <<'PYEOF'
import sys
target_path, inject_path = sys.argv[1], sys.argv[2]
with open(target_path) as f:
    c = f.read()
with open(inject_path) as f:
    inject_body = f.read()

ANCHOR = 'uno_scripts: [],'
if c.count(ANCHOR) != 1:
    print(f'ERROR: {target_path}: expected 1 "{ANCHOR}" anchor, found {c.count(ANCHOR)}', file=sys.stderr)
    sys.exit(1)
# Inject the locateFile field right after the uno_scripts line.
c = c.replace(ANCHOR, ANCHOR + '\n' + inject_body, 1)
with open(target_path, 'w') as f:
    f.write(c)
print(f'  patched: {target_path}')
PYEOF
}

echo "  Step 2: emscripten-module locateFile patch"
apply_locate_file_inject "$EMSCRIPTEN_MODULE_WASM"
apply_locate_file_inject "$EMSCRIPTEN_MODULE_DIST"

# ── Step 3: global.js branding strip ──────────────────────────────
# Stock global.js appends a <link rel="stylesheet" href="branding-<form>.css">
# at runtime. We don't ship integrator themes, so that 404s.
if [ -f "$GLOBAL_JS" ] && grep -q 'insertAdjacentElement("afterend",brandingLink)' "$GLOBAL_JS"; then
    sed -i 's|\.insertAdjacentElement("afterend",link)\.insertAdjacentElement("afterend",brandingLink)|.insertAdjacentElement("afterend",link)|g' "$GLOBAL_JS"
    echo "  Step 3: global.js branding link stripped"
else
    echo "  Step 3: global.js branding (skip — already stripped or anchor missing)"
fi

# ── Step 4: Fingerprint substitution ──────────────────────────────
# wasm-loader.js + sw.js have __WASM_BUILD_FINGERPRINT__ tokens so
# snapshots saved by an old build are discarded on restore (mismatch
# detection) and the SW's CACHE_NAME embeds the fingerprint so a
# fresh deploy lands in a new Cache Storage namespace.
FINGERPRINT="$(md5sum "$BUILD_DIR/wasm/online.wasm" | cut -c1-16)"
echo "  Step 4: build fingerprint = $FINGERPRINT"

apply_fingerprint() {
    local target="$1"
    [ -f "$target" ] || return 0
    if grep -q '__WASM_BUILD_FINGERPRINT__' "$target"; then
        sed -i "s|__WASM_BUILD_FINGERPRINT__|$FINGERPRINT|g" "$target"
        echo "    sub: $target"
    fi
}
# Sources live in $WASM_DIR — copy them into the build dir so the build
# tree is self-contained for downstream cp-only deploys. wasm-loader.js
# and sw.js have a fingerprint placeholder; the others are pristine.
SOURCE_JS=(
    wasm-loader.js
    sw.js
    relay-adapter.js
    dict-loader.js
)
for base in "${SOURCE_JS[@]}"; do
    src="$WASM_DIR/$base"
    [ -f "$src" ] || continue
    cp -f "$src" "$BUILD_DIR/wasm/$base"
    cp -f "$src" "$BUILD_DIR/browser/dist/$base"
    apply_fingerprint "$BUILD_DIR/wasm/$base"
    apply_fingerprint "$BUILD_DIR/browser/dist/$base"
done

# ── Step 5: Cache-bust rename + cool.html rewrite ─────────────────
# Renames each long-cacheable asset to <base>.<hash>.<ext>, moves
# .br sidecars in lockstep, rewrites cool.html (asset refs +
# Module.locateFile shim ahead of online.js).
echo "  Step 5: cache-bust rename"
node "$WASM_DIR/tools/cache-bust-build.js" --dir "$BUILD_DIR/browser/dist"

# ── Step 6: Brotli sidecars ───────────────────────────────────────
# Operates on the now-renamed files. Sidecars produced here are
# byte-identical to what deploy.sh / deploy-azure.sh would have
# produced, so deploys can copy them as-is.
echo "  Step 6: brotli sidecars (q${BROTLI_QUALITY:-2})"
if command -v brotli >/dev/null 2>&1; then
    bash "$WASM_DIR/tools/brotli-sidecar.sh" \
        "$BUILD_DIR/wasm/online.js" \
        "$BUILD_DIR/wasm/online.wasm" \
        "$BUILD_DIR/wasm/online.worker.js" \
        "$BUILD_DIR/wasm/soffice.data" \
        "$BUILD_DIR/browser/dist"/*.js \
        "$BUILD_DIR/browser/dist"/*.css \
        "$BUILD_DIR/browser/dist"/*.wasm \
        "$BUILD_DIR/browser/dist"/*.data \
        "$BUILD_DIR/browser/dist"/*.metadata 2>/dev/null || \
        echo "  WARNING: brotli-sidecar reported failures"
else
    echo "  WARNING: brotli not on PATH — deploys will fall back to deploy-time brotli"
fi

echo "──────────────────────────────────────────────────────────────"
echo " finalize-build.sh: complete"
echo "──────────────────────────────────────────────────────────────"
