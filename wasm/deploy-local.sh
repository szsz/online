#!/usr/bin/env bash
# deploy-local.sh — sync source-tracked code into the running on-host
# deployments at viewer.szebeni.hu:6934 / wasm.atgpartners.info:6932 /
# wasm.atgpartners.info:9091.
#
# Layout being synced TO:
#   /tmp/static-deploy/public/browser/   editor-static (HTTPS :6932)
#   /tmp/viewer-deploy/public/           viewer UI assets (HTTPS :6934)
#   /home/localadmin/online/wasm/        relay (already runs from source)
#
# Layout being synced FROM:
#   wasm/wasm-loader.js                  → /tmp/static-deploy/public/browser/
#   wasm/relay-adapter.js                → /tmp/static-deploy/public/browser/
#   wasm/viewer-public/index.html        → /tmp/viewer-deploy/public/
#   wasm/viewer-public/blank.docx        → /tmp/viewer-deploy/public/
#
# After syncing each .js the brotli precompressed variant
# (file.js.br) is regenerated — the editor-static server prefers .br
# when the client sends Accept-Encoding: br, so a stale .br silently
# overrides a fresh .js.
#
# This script DOES NOT touch the heavyweight WASM build artifacts
# (online.wasm / online.data / soffice.data / online.js). Those come
# from `wasm/build-wasm.sh` which is a multi-hour Docker build. The
# script reports their current mtime so you can decide whether to
# rebuild — and if you've changed any C++ source, you MUST rebuild for
# the change to land in the running editor.
#
# Usage:
#   bash wasm/deploy-local.sh                    # sync + report
#   bash wasm/deploy-local.sh --restart-relay    # also restart message-relay
#                                                # (only this one — it runs as
#                                                # the current user; viewer and
#                                                # editor-static run as root and
#                                                # need sudo to restart)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EDITOR_BROWSER_DIR=/tmp/static-deploy/public/browser
VIEWER_PUBLIC_DIR=/tmp/viewer-deploy/public

DO_RESTART_RELAY=false
for arg in "$@"; do
    case "$arg" in
        --restart-relay) DO_RESTART_RELAY=true ;;
        --help|-h)
            sed -n '2,30p' "$0"; exit 0 ;;
        *) echo "Unknown flag: $arg (try --help)"; exit 1 ;;
    esac
done

# Pretty-print
RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; CYAN=$'\e[36m'; BOLD=$'\e[1m'; RST=$'\e[0m'

echo "${BOLD}=== local deploy ===${RST}"

# ── Verify destinations exist ────────────────────────────────────────
for dir in "$EDITOR_BROWSER_DIR" "$VIEWER_PUBLIC_DIR"; do
    if [[ ! -d "$dir" ]]; then
        echo "${RED}ERROR:${RST} destination $dir does not exist."
        exit 1
    fi
done

# ── Helper: sync one file, regenerate brotli if applicable ──────────
sync_file() {
    local src=$1 dst=$2 regen_br=${3:-no}
    if [[ ! -f "$src" ]]; then
        echo "  ${YELLOW}skip${RST} $src (missing)"
        return
    fi
    local before=""
    [[ -f "$dst" ]] && before=$(stat -c '%Y' "$dst")
    cp "$src" "$dst"
    local after=$(stat -c '%Y' "$dst")
    local size=$(stat -c '%s' "$dst")
    if [[ "$regen_br" == "yes" ]]; then
        if command -v brotli >/dev/null 2>&1; then
            brotli -f -q 11 "$dst"
            local brsize=$(stat -c '%s' "$dst.br")
            echo "  ${GREEN}sync${RST} $(basename "$dst") (${size}B; brotli ${brsize}B)"
        else
            # If brotli isn't available, DELETE the stale .br so the
            # server can't serve it. Falling back to the uncompressed
            # .js is the safe choice when we can't regenerate.
            rm -f "$dst.br"
            echo "  ${YELLOW}sync${RST} $(basename "$dst") (${size}B; brotli unavailable — deleted stale .br)"
        fi
    else
        echo "  ${GREEN}sync${RST} $(basename "$dst") (${size}B)"
    fi
}

# ── 1. Editor-static JS files (need brotli regen) ──────────────────
echo ""
echo "${CYAN}→ editor-static  $EDITOR_BROWSER_DIR${RST}"
sync_file "$SCRIPT_DIR/wasm-loader.js"   "$EDITOR_BROWSER_DIR/wasm-loader.js"   yes
sync_file "$SCRIPT_DIR/relay-adapter.js" "$EDITOR_BROWSER_DIR/relay-adapter.js" yes

# ── 2. Viewer UI assets (no brotli needed; viewer-server doesn't precompress) ──
echo ""
echo "${CYAN}→ viewer UI      $VIEWER_PUBLIC_DIR${RST}"
sync_file "$SCRIPT_DIR/viewer-public/index.html" "$VIEWER_PUBLIC_DIR/index.html" no
sync_file "$SCRIPT_DIR/viewer-public/blank.docx" "$VIEWER_PUBLIC_DIR/blank.docx" no

# ── 3. WASM binaries — REPORT only ─────────────────────────────────
echo ""
echo "${CYAN}→ WASM build artifacts (NOT auto-deployed)${RST}"
print_artifact() {
    local p=$1
    if [[ -f "$p" ]]; then
        local size=$(numfmt --to=iec --suffix=B "$(stat -c '%s' "$p")" 2>/dev/null || stat -c '%s' "$p")
        local mtime=$(date -d "@$(stat -c '%Y' "$p")" '+%Y-%m-%d %H:%M')
        echo "  $(basename "$p"): $size, last built $mtime"
    else
        echo "  ${RED}MISSING${RST} $p"
    fi
}
print_artifact "$EDITOR_BROWSER_DIR/online.wasm"
print_artifact "$EDITOR_BROWSER_DIR/online.js"
print_artifact "$EDITOR_BROWSER_DIR/online.data"
print_artifact "$EDITOR_BROWSER_DIR/soffice.data"
echo ""
echo "  These come from wasm/build-wasm.sh (multi-hour Docker build)."
echo "  If you changed C++ code under core/, kit/, common/ etc. you MUST"
echo "  re-run build-wasm.sh for those changes to land in the editor."

# ── 4. Restarts ────────────────────────────────────────────────────
echo ""
echo "${CYAN}→ services${RST}"

# Identify owners of each service so the script knows what it can/can't restart.
RELAY_PID=$(pgrep -f "node.*wasm/message-relay.js" | head -1 || true)
VIEWER_PID=$(pgrep -f "node.*viewer-deploy/viewer-server.js" | head -1 || true)
EDITOR_PID=$(pgrep -f "node.*static-deploy/server.js" | head -1 || true)

show_pid() {
    local label=$1 pid=$2
    if [[ -z "$pid" ]]; then
        echo "  ${YELLOW}${label}${RST}: not running"
        return
    fi
    local user=$(ps -p "$pid" -o user= | tr -d ' ')
    local etime=$(ps -p "$pid" -o etime= | tr -d ' ')
    echo "  ${label}: pid=$pid user=$user uptime=$etime"
}
show_pid "relay         " "$RELAY_PID"
show_pid "viewer        " "$VIEWER_PID"
show_pid "editor-static " "$EDITOR_PID"

echo ""
echo "  Restart guidance:"
echo "    - relay (message-relay.js): runs from source — restart to pick up"
echo "      changes. Use: ${BOLD}bash $0 --restart-relay${RST}"
echo "    - viewer (viewer-server.js): currently runs from /tmp/viewer-deploy/"
echo "      (legacy). To migrate to source, replace that file with a wrapper"
echo "      that exec's bash $SCRIPT_DIR/launch-viewer.sh, then restart with"
echo "      sudo. The viewer's HTML/CSS/JS were just synced above and are"
echo "      live without a restart (they're served as static files)."
echo "    - editor-static (server.js): serves static files; the JS+brotli"
echo "      sync above is live without a restart. Restart only needed if"
echo "      server.js itself changed (it didn't — it's not source-tracked"
echo "      either; lives at /tmp/static-deploy/server.js)."

# ── 5. Optional restarts ───────────────────────────────────────────
if $DO_RESTART_RELAY; then
    echo ""
    echo "${CYAN}→ restarting relay${RST}"
    if [[ -z "$RELAY_PID" ]]; then
        echo "  no relay process to restart"
    else
        local_user=$(whoami)
        relay_user=$(ps -p "$RELAY_PID" -o user= | tr -d ' ')
        if [[ "$relay_user" != "$local_user" ]]; then
            echo "  ${RED}cannot restart${RST}: relay runs as $relay_user (you are $local_user). Use sudo."
            exit 1
        fi
        # Stash current SSL_CERT/SSL_KEY env from the running process so the
        # restart keeps the same TLS config (the relay uses them via env).
        # If that's not preserved you'd lose HTTPS on next boot.
        kill "$RELAY_PID"
        sleep 1
        nohup node "$SCRIPT_DIR/message-relay.js" > /tmp/message-relay.log 2>&1 &
        sleep 1
        NEW_PID=$(pgrep -f "node.*wasm/message-relay.js" | head -1 || true)
        if [[ -n "$NEW_PID" ]]; then
            echo "  ${GREEN}restarted${RST}: pid=$NEW_PID (log: /tmp/message-relay.log)"
        else
            echo "  ${RED}restart failed${RST}: see /tmp/message-relay.log"
            exit 1
        fi
    fi
fi

echo ""
echo "${BOLD}done.${RST}"
