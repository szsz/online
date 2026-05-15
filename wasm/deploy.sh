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

# ── Per-deploy folder mode ────────────────────────────────────────
# When APP_BUILD_ID is set (CI), stage files under $PUB/$APP_BUILD_ID/
# so multiple deploys coexist on the same PUB and editor-static-server
# routes /<id>/browser/... into that subfolder. When unset (ad-hoc
# human-driven deploy on a workstation), fall through to legacy flat
# layout at $PUB/browser/. editor-static-server.js handles both via its
# per-deploy middleware plus DEFAULT_DEPLOY_ID env-var fallback.
if [ -n "${APP_BUILD_ID:-}" ]; then
    EFFECTIVE_PUB="$PUB/$APP_BUILD_ID"
    DEPLOY_MODE="per-deploy ($APP_BUILD_ID)"
else
    EFFECTIVE_PUB="$PUB"
    DEPLOY_MODE="flat (no APP_BUILD_ID)"
fi
BROWSER_DIR="$EFFECTIVE_PUB/browser"

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
echo "=== Deploying WASM editor (fingerprint=$FINGERPRINT, mode=$DEPLOY_MODE) ==="

# ── Copy build tree to live serving dir ──
# Atomic-ish: stage to a tmp dir alongside, then mv into place.
mkdir -p "$BROWSER_DIR" "$EFFECTIVE_PUB" "$PUB"
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

# ── Bridge SW — at editor PUB root (NOT per-deploy folder) ──
# Scope `/` lets it intercept /wasm/<id> + /api/blobs/ + /api/v2/file/
# + /api/files/ on the editor origin and route them to the viewer via
# postMessage. One copy across all deploys.
if [ -f "$SCRIPT_DIR/sw-bridge.js" ]; then
    cp "$SCRIPT_DIR/sw-bridge.js" "$PUB/sw-bridge.js"
    echo "  Deployed sw-bridge.js to $PUB/"
fi

# ── Spellcheck dicts (built separately by wasm/build-dicts.sh) ──
# In per-deploy mode the dicts live inside the <id>/ folder; in flat mode
# they stay at $PUB/dicts/. dict-loader.js resolves /dicts/ relative to
# its own script URL, so the path resolves correctly in both layouts.
DICTS_SRC="$BUILD_DIR/dicts"
DICTS_DST="$EFFECTIVE_PUB/dicts"
if [ -d "$DICTS_SRC" ] && ls "$DICTS_SRC"/*.tar.gz >/dev/null 2>&1; then
    mkdir -p "$DICTS_DST"
    cp -f "$DICTS_SRC"/*.tar.gz "$DICTS_DST/" 2>/dev/null || true
    cp -f "$DICTS_SRC/manifest.json" "$DICTS_DST/manifest.json"
    chmod -R a+r "$DICTS_DST"
    DICT_COUNT=$(ls "$DICTS_DST"/*.tar.gz 2>/dev/null | wc -l)
    DICT_SIZE=$(du -sh "$DICTS_DST" 2>/dev/null | cut -f1)
    echo "  Deployed $DICT_COUNT language dict bundles to $DICTS_DST ($DICT_SIZE)"
else
    echo "  No dict bundles — run 'bash wasm/build-dicts.sh' to produce them"
fi

# ── Per-deploy build-info.json ────────────────────────────────────
# Written for both flat and per-deploy modes (in flat it lands at $PUB/
# build-info.json which is harmless). The new regression test for
# per-deploy folders probes /<id>/build-info.json and asserts its id
# field matches EDITOR_DEPLOY_ID.
cat > "$EFFECTIVE_PUB/build-info.json" <<EOF
{
  "id": "${APP_BUILD_ID:-flat}",
  "git_sha": "${GIT_SHA:-}",
  "lo_build_id": "${LO_BUILD_ID:-}",
  "fingerprint": "$FINGERPRINT",
  "deployed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# ── Per-deploy pointer file ───────────────────────────────────────
# editor-static-server.js reads $PUB/current-deploy.txt to know which
# /<id>/ folder to route unprefixed URLs into. Writing this file is
# what activates the new deploy for legacy flat-URL clients (the
# explicit-prefix path via window.__CONFIG.EDITOR_DEPLOY_ID kicks in
# separately when the operator runs wasm/promote-editor.sh).
#
# Atomic write (mktemp + mv on same filesystem) so the server's
# mtime-cached read never sees a half-written id.
if [ -n "${APP_BUILD_ID:-}" ]; then
    POINTER_TMP="$(mktemp "$PUB/current-deploy.txt.XXXXXX")"
    printf '%s\n' "$APP_BUILD_ID" > "$POINTER_TMP"
    mv "$POINTER_TMP" "$PUB/current-deploy.txt"
    echo "  Wrote $PUB/current-deploy.txt = $APP_BUILD_ID"
fi

# ── Kit-side files served at /wasm/<name> (uploaded user docs) ──
# editor-static-server reads online.wasm, soffice.data, etc. from
# $BROWSER_DIR via /browser/<name>. The user-doc storage at /wasm/
# is a different filesystem location maintained by the editor server.
# Nothing to do here — the build outputs at $BUILD_DIR/wasm/* are
# only needed if someone uses BUILD_DIR as a sandbox.

if [ "$DO_RESTART" = true ]; then
    # ── Restart editor-static-server so code changes take effect ──
    # editor-static-server.js handles SIGHUP as a no-op (the runtime
    # rehashing it used to do is now build-time), so signaling alone
    # leaves the running process on STALE code. When deploy.sh ships
    # a code change (e.g. PR #78's /browser/dist/<x> → /browser/<x>
    # rewrite), the process must actually be killed and relaunched.
    # Before this fix the running server was 10+ days stale on the
    # dev box → every viewer cold-open got 404 on cool.html → kit
    # never started → ~40 tests failed with "frame got detached".
    #
    # The process typically runs as root (HTTPS cert files at
    # /etc/letsencrypt/live/<host>/ are root-only). The runner has
    # NOPASSWD sudo configured. Multiple instances may run on the
    # box (ad-hoc vs ci-* tier); restart EACH detected process and
    # relaunch via its launcher script with the same env it was
    # started with (parsed from /proc/<pid>/environ).
    EDITOR_PIDS=$(pgrep -f "node .*editor-static-server\.js" || true)
    if [ -n "$EDITOR_PIDS" ]; then
        for PID in $EDITOR_PIDS; do
            # Extract the env this process was started with so we can
            # relaunch it identically. ENV_FILE / HTTP_PORT / HTTPS_PORT
            # / EDITOR_SSL_CERT / EDITOR_SSL_KEY / PUB / DOCS are the
            # ones launch-editor-static.sh reads.
            ENVS=$(sudo -n cat "/proc/$PID/environ" 2>/dev/null | tr '\0' '\n' | grep -E '^(ENV_FILE|HTTP_PORT|HTTPS_PORT|EDITOR_SSL_CERT|EDITOR_SSL_KEY|PUB|DOCS|FILE_STORAGE_URL)=' | sort -u | tr '\n' ' ')
            echo "  Restarting editor-static PID $PID with env: $ENVS"
            sudo -n kill "$PID" 2>/dev/null || true
            # Also kill the sudo parent if present (launch-editor-static
            # wraps the node process in `sudo -b nohup bash launch-...`).
            PARENT=$(ps -o ppid= -p "$PID" 2>/dev/null | tr -d ' ')
            if [ -n "$PARENT" ] && [ "$PARENT" != "1" ]; then
                sudo -n kill "$PARENT" 2>/dev/null || true
            fi
            for _i in 1 2 3 4 5; do
                if ! kill -0 "$PID" 2>/dev/null; then break; fi
                sleep 1
            done
            # Relaunch with the same env. sudo -b runs in background;
            # nohup keeps it alive past the shell exit.
            sudo -b -n env $ENVS nohup bash "$SCRIPT_DIR/launch-editor-static.sh" \
                > "/tmp/editor-static-restart-$PID.log" 2>&1 &
        done
        sleep 3
        NEW_PIDS=$(pgrep -f "node .*editor-static-server\.js" | tr '\n' ' ')
        echo "  editor-static-server restarted (new PIDs: $NEW_PIDS)"
    else
        echo "  NOTE: editor-static-server not running — fresh start not handled by deploy.sh, run launch-editor-static.sh manually"
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
