#!/bin/bash
# Deploy WASM editor artifacts to the static server.
#
# After the build finalize step (wasm/tools/finalize-build.sh) the
# build tree is "complete": cool.html references hashed assets, .br
# sidecars are in place, snapshot inject is applied. This script is
# pure cp + dict copy + viewer index + restart relay + smoke test.
#
# Usage:
#   bash wasm/deploy.sh              # deploy from default build dir
#   bash wasm/deploy.sh --build      # build first, then deploy
#   bash wasm/deploy.sh --no-restart # skip relay restart + editor SIGHUP
#   bash wasm/deploy.sh --no-smoke   # skip the post-deploy puppeteer smoke

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="${BUILD_DIR:-$REPO_DIR/wasm/online-build}"
PUB="${PUB:-/tmp/static-deploy/public}"
BROWSER_DIR="$PUB/browser"

# ── Deploy lock ──
LOCK_FILE="${LOCK_FILE:-/tmp/online-deploy.lock}"
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
    echo "ERROR: another deploy is running (lock at $LOCK_FILE). Wait for it, or pass LOCK_FILE=/dev/null to override." >&2
    exit 1
fi

DO_BUILD=false
DO_SMOKE=true
DO_RESTART=true
for arg in "$@"; do
    case "$arg" in
        --build) DO_BUILD=true ;;
        --no-smoke) DO_SMOKE=false ;;
        --no-restart) DO_RESTART=false ;;
        --no-inject|--no-brotli)
            echo "NOTE: $arg is a no-op now — these patches moved to build time (wasm/tools/finalize-build.sh)" ;;
    esac
done

if [ "$DO_BUILD" = true ]; then
    echo "Building..."
    bash "$SCRIPT_DIR/build-wasm.sh"
fi

# ── Verify the build tree is finalized ──
# A finalized tree has cache-busted asset names (online.<hash>.wasm)
# and cool.html references them via window.__assetMap.
if [ ! -f "$BUILD_DIR/browser/dist/cool.html" ]; then
    echo "ERROR: $BUILD_DIR/browser/dist/cool.html missing — run 'bash wasm/build-wasm.sh' first" >&2
    exit 1
fi
if ! grep -q '__assetMap' "$BUILD_DIR/browser/dist/cool.html"; then
    echo "ERROR: $BUILD_DIR/browser/dist/cool.html does not contain __assetMap." >&2
    echo "       Build tree is not finalized — run 'bash wasm/tools/finalize-build.sh $BUILD_DIR'." >&2
    exit 1
fi

FINGERPRINT="$(md5sum "$BUILD_DIR/wasm/online.wasm" | cut -c1-16)"
echo "=== Deploying WASM editor (fingerprint=$FINGERPRINT) ==="

# ── Copy build tree to live serving dir ──
# Atomic-ish: stage to a tmp dir alongside, then mv into place.
mkdir -p "$BROWSER_DIR" "$PUB"
STAGE="$(mktemp -d "$BROWSER_DIR/.deploy-XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

cp -a "$BUILD_DIR/browser/dist/." "$STAGE/"
echo "  Staged $(find "$STAGE" -type f | wc -l) files from $BUILD_DIR/browser/dist"

# ── Integrity check on the .br sidecars ──
# Catches truncated brotli before we move staged → live.
for src in "$STAGE"/*; do
    [[ "$src" == *.br ]] && continue
    [ -f "$src" ] || continue
    br="$src.br"
    [ -f "$br" ] || continue
    src_bytes=$(stat -c %s "$src")
    decomp_bytes=$(brotli -d -c "$br" 2>/dev/null | wc -c)
    if [ "$src_bytes" != "$decomp_bytes" ]; then
        echo "ERROR: $(basename "$br") decompressed to $decomp_bytes bytes; expected $src_bytes" >&2
        exit 1
    fi
done

# ── Move staged → live ──
# Top level: replace each file individually so concurrent reads see
# either the old or the new bytes (never half-old + half-new).
for src in "$STAGE"/*; do
    name="$(basename "$src")"
    if [ -d "$src" ]; then
        # subdir (e.g. images/, admin/) — replace wholesale via mv
        rm -rf "$BROWSER_DIR/$name"
        mv "$src" "$BROWSER_DIR/$name"
    else
        mv -f "$src" "$BROWSER_DIR/$name"
    fi
done
rmdir "$STAGE" 2>/dev/null || true
trap - EXIT

# ── Viewer index.html (served at PUB/index.html, not /browser/) ──
if [ -f "$SCRIPT_DIR/viewer-public/index.html" ]; then
    cp "$SCRIPT_DIR/viewer-public/index.html" "$PUB/index.html"
    echo "  Deployed viewer index.html"
fi

# ── Spellcheck dicts (built separately by wasm/build-dicts.sh) ──
DICTS_SRC="$BUILD_DIR/dicts"
if [ -d "$DICTS_SRC" ] && ls "$DICTS_SRC"/*.tar.gz >/dev/null 2>&1; then
    mkdir -p "$PUB/dicts"
    cp -f "$DICTS_SRC"/*.tar.gz "$PUB/dicts/" 2>/dev/null || true
    cp -f "$DICTS_SRC/manifest.json" "$PUB/dicts/manifest.json"
    chmod -R a+r "$PUB/dicts"
    DICT_COUNT=$(ls "$PUB/dicts"/*.tar.gz 2>/dev/null | wc -l)
    DICT_SIZE=$(du -sh "$PUB/dicts" 2>/dev/null | cut -f1)
    echo "  Deployed $DICT_COUNT language dict bundles ($DICT_SIZE)"
else
    echo "  No dict bundles — run 'bash wasm/build-dicts.sh' to produce them"
fi

# ── Kit-side files served at /wasm/<name> (uploaded user docs) ──
# editor-static-server reads online.wasm, soffice.data, etc. from
# $BROWSER_DIR via /browser/<name>. The user-doc storage at /wasm/
# is a different filesystem location maintained by the editor server.
# Nothing to do here — the build outputs at $BUILD_DIR/wasm/* are
# only needed if someone uses BUILD_DIR as a sandbox.

if [ "$DO_RESTART" = true ]; then
    # ── SIGHUP editor-static (no-op now; kept for visibility) ──
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

    # ── Restart message-relay so every client reconnects against new code ──
    RELAY_PID=$(pgrep -f "node.*message-relay" | head -1)
    if [ -n "$RELAY_PID" ]; then
        kill "$RELAY_PID" 2>/dev/null || true
        for _i in 1 2 3 4 5; do
            pgrep -f "node.*message-relay" >/dev/null 2>&1 || break
            sleep 1
        done
        nohup bash "$SCRIPT_DIR/launch-relay.sh" > /tmp/relay.log 2>&1 &
        sleep 2
        NEW_RELAY_PID=$(pgrep -f "node.*message-relay" | head -1)
        if [ -n "$NEW_RELAY_PID" ]; then
            echo "  Restarted message-relay: $RELAY_PID → $NEW_RELAY_PID"
        else
            echo "  WARNING: relay failed to restart — check /tmp/relay.log"
        fi
    else
        echo "  NOTE: message-relay not running — starting fresh"
        nohup bash "$SCRIPT_DIR/launch-relay.sh" > /tmp/relay.log 2>&1 &
        sleep 2
    fi
fi

# ── Build-fingerprint metadata file (observability) ──
echo "$FINGERPRINT $(date -Iseconds)" > "$BROWSER_DIR/.build-fingerprint"
echo ""
echo "=== Deploy complete: fingerprint=$FINGERPRINT ==="

# ── Smoke test ──
if [ "$DO_SMOKE" = true ] && [ -f "$SCRIPT_DIR/test-deploy-smoke.js" ]; then
    echo ""
    echo "── Smoke test ──"
    if (cd "$SCRIPT_DIR" && node test-deploy-smoke.js); then
        :
    else
        echo "  WARNING: smoke test FAILED — deploy artefacts are live but may not work"
        echo "  See /tmp/smoke-fail.png for the failing render"
    fi
fi
