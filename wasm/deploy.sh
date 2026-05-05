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
#   bash wasm/deploy.sh --no-restart # skip relay restart + editor SIGHUP
#                                    # (used by CI to stage a per-run copy
#                                    # without disturbing host processes)
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
DO_RESTART=true
# Default brotli quality is fast (q2) so inner-loop deploys finish in
# seconds. Override with BROTLI_QUALITY=11 for prod-grade wire bytes.
export BROTLI_QUALITY="${BROTLI_QUALITY:-2}"
for arg in "$@"; do
    case "$arg" in
        --build) DO_BUILD=true ;;
        --no-inject) DO_INJECT=false ;;
        --no-brotli) DO_BROTLI=false ;;
        --no-smoke) DO_SMOKE=false ;;
        --no-restart) DO_RESTART=false ;;
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
# bundle.css ships alongside bundle.js — it's where browser/css/*.css gets
# concatenated by the COOL JS build. Without staging it here, source CSS
# changes (e.g. notebookbar.css edits) never reach the live tree even
# though the build did rebuild bundle.css.
cp "$BUILD_DIR/browser/dist/bundle.css" "$STAGE/bundle.css"
cp "$SCRIPT_DIR/wasm-loader.js"    "$STAGE/wasm-loader.js"
cp "$SCRIPT_DIR/relay-adapter.js"  "$STAGE/relay-adapter.js"
# sw.js: heavy-asset Cache Storage backstop. CACHE_NAME embeds the build
# fingerprint so a new deploy lands in a fresh namespace and the activate
# handler evicts the previous build's 60+ MB of cached assets — without
# this, users would see Cache Storage stuck on the old build until they
# manually unregister the SW or clear site data.
cp "$SCRIPT_DIR/sw.js"             "$STAGE/sw.js"

echo "  Copied 9 artifacts to staging"

# ── Step 2b: Compute build fingerprint and inject into wasm-loader.js + sw.js ──
# The fingerprint ties the snapshot to this exact WASM binary. On restore,
# wasm-loader.js compares it with the stored snapshot's fingerprint and
# discards stale snapshots from older builds. sw.js uses it as the SW's
# CACHE_NAME so deploys auto-invalidate the previous build's cache.
FINGERPRINT=$(md5sum "$STAGE/online.wasm" | cut -c1-16)
sed -i "s|__WASM_BUILD_FINGERPRINT__|$FINGERPRINT|g" "$STAGE/wasm-loader.js" "$STAGE/sw.js"
echo "  Build fingerprint: $FINGERPRINT"

# ── Step 3: snapshot inject — now happens at build time ──
# wasm/tools/finalize-build.sh applies this; deploys are pure cp now.
# (This block used to be a 250-line python heredoc; see the
# wasm/PLAN-deploy-vs-build.md commit for the migration rationale.)


# ── Step 4: Generate Brotli compressed versions ──
# These MUST match the source files. Stale .br files cause silent
# binary mismatches that are extremely hard to debug — so when
# --no-brotli skips regeneration, we also drop any existing .br so
# the server falls back to plain content instead of serving a
# mismatched payload.
#
# Build-time brotli: if `<src>.br` exists alongside the source in the
# build tree (build-wasm.sh / build-online.sh now generate these),
# copy it to staging instead of compressing again. Brotli is
# deterministic per (input bytes, quality) so the bytes are identical.
# Saves ~15 min on `online.wasm` per redeploy of the same build.
BROTLI_FILES="online.js online.wasm bundle.js bundle.css"
# Map staged-file basename → source path under $BUILD_DIR. online.{js,wasm}
# came from $PAIRED_DIR (wasm/ or browser/dist/, picked at Step 1);
# bundle.{js,css} always come from browser/dist/.
declare -A BR_SRC_DIR=( \
    [online.js]="$PAIRED_DIR" \
    [online.wasm]="$PAIRED_DIR" \
    [bundle.js]="$BUILD_DIR/browser/dist" \
    [bundle.css]="$BUILD_DIR/browser/dist" \
)
if [ "$DO_BROTLI" = true ]; then
    for name in $BROTLI_FILES; do
        src="$STAGE/$name"
        [ -f "$src" ] || continue
        build_br="${BR_SRC_DIR[$name]:-}/$name.br"
        if [ -f "$build_br" ]; then
            cp "$build_br" "$STAGE/$name.br"
            echo "  Reused build-time $name.br ($(du -h "$STAGE/$name.br" | cut -f1))"
        else
            echo -n "  Compressing $name → $name.br (q$BROTLI_QUALITY)..."
            brotli -f -q "$BROTLI_QUALITY" "$src" -o "$STAGE/$name.br"
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
        brotli -f -q "$BROTLI_QUALITY" "$BROWSER_DIR/dict-loader.js"
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

# ── Strip global.js branding + emscripten-module locateFile + cache-bust ──
# All three are now done at build time by wasm/tools/finalize-build.sh.
# Deploys are pure cp + config + restart. See wasm/PLAN-deploy-vs-build.md.


if [ "$DO_RESTART" = true ]; then
# ── Step 6b: Heartbeat the server (no-op SIGHUP) ──
# The editor-static-server no longer hashes at runtime, so SIGHUP is
# no-op — kept for visibility that the running PID is reachable.
SERVER_PID=$(pgrep -f "editor-static-server" | head -1)
if [ -n "$SERVER_PID" ]; then
    if kill -HUP "$SERVER_PID" 2>/dev/null; then
        echo "  Signaled editor-static (PID $SERVER_PID); cool.html is no-cache so the next refresh picks up new hashes"
    else
        echo "  WARNING: kill -HUP $SERVER_PID failed (different user?) — editor-static may be stale"
    fi
else
    echo "  WARNING: editor-static-server not running"
fi

# ── Step 6c: Restart the message-relay ──
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
fi  # DO_RESTART

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
