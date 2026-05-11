#!/usr/bin/env bash
# promote-editor.sh — atomically flip the viewer's editor pointer to a
# specific deploy id. Run by the operator (or a wrapper) after the
# editor's CI deploy at ${EDITOR_URL}/<id>/ has finished and been
# spot-checked.
#
# Usage:
#   bash wasm/promote-editor.sh <YYYY-MM-DD-HHMMSS>
#   bash wasm/promote-editor.sh --flat               # back to legacy (no prefix)
#   bash wasm/promote-editor.sh --show               # print current pointer
#   bash wasm/promote-editor.sh --force <id>          # skip the HEAD sanity check
#
# What it does:
#   1. Sanity-check the id format (YYYY-MM-DD-HHMMSS).
#   2. HEAD ${EDITOR_URL}/<id>/browser/cool.html — refuse if non-2xx
#      (so a typo'd id doesn't break the viewer). Skipped with --force.
#   3. Atomically replace $VIEWER_CONFIG_FILE (mktemp + mv) so viewer-
#      server.js never reads a half-written file.
#   4. Print the before/after id pair.
#
# viewer-server.js fs.watchFiles $VIEWER_CONFIG_FILE and rebuilds its
# /config.js payload + ETag when the file changes, so the new pointer
# reaches new viewer tabs within ~2 seconds. In-flight tabs already
# loaded with the previous id keep using that until they reload.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$HOME/ENV/online.env}"

# Load .env so VIEWER_CONFIG_FILE and EDITOR_URL are available (caller
# can override via direct env vars).
if [[ -f "$ENV_FILE" ]]; then
    while IFS='=' read -r key value; do
        [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
        value="${value%\"}"; value="${value#\"}"
        value="${value%\'}"; value="${value#\'}"
        if [[ -z "${!key+x}" ]]; then export "$key=$value"; fi
    done < "$ENV_FILE"
fi

: "${VIEWER_CONFIG_FILE:=$HOME/ENV/viewer-config.json}"
case "$VIEWER_CONFIG_FILE" in
    '~/'*) VIEWER_CONFIG_FILE="$HOME/${VIEWER_CONFIG_FILE#~/}" ;;
    '~')   VIEWER_CONFIG_FILE="$HOME" ;;
esac

FORCE=false
SHOW=false
FLAT=false
NEW_ID=""
for arg in "$@"; do
    case "$arg" in
        --force) FORCE=true ;;
        --show)  SHOW=true ;;
        --flat)  FLAT=true ;;
        --help|-h)
            sed -n '2,28p' "$0"; exit 0 ;;
        --*) echo "Unknown flag: $arg" >&2; exit 2 ;;
        *)   NEW_ID="$arg" ;;
    esac
done

read_current_id() {
    [[ -f "$VIEWER_CONFIG_FILE" ]] || { echo ""; return; }
    python3 -c "import json,sys; print(json.load(open('$VIEWER_CONFIG_FILE')).get('editor_deploy_id',''))" 2>/dev/null || echo ""
}

if $SHOW; then
    cur="$(read_current_id)"
    echo "VIEWER_CONFIG_FILE=$VIEWER_CONFIG_FILE"
    echo "editor_deploy_id=${cur:-(flat / unset)}"
    exit 0
fi

if $FLAT && [[ -n "$NEW_ID" ]]; then
    echo "ERROR: --flat and a positional id are mutually exclusive" >&2
    exit 2
fi

if ! $FLAT && [[ -z "$NEW_ID" ]]; then
    echo "Usage: bash $0 <YYYY-MM-DD-HHMMSS> | --flat | --show" >&2
    exit 2
fi

if [[ -n "$NEW_ID" ]] && ! [[ "$NEW_ID" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}$ ]]; then
    echo "ERROR: id format must be YYYY-MM-DD-HHMMSS, got: $NEW_ID" >&2
    exit 2
fi

# Sanity check: HEAD ${EDITOR_URL}/<id>/browser/cool.html must return 2xx.
# Catches typos before they propagate to the live viewer. --force skips
# (useful when the editor static site is reachable from CI but not from
# the operator's terminal, e.g. private network).
if ! $FORCE && [[ -n "$NEW_ID" ]]; then
    if [[ -z "${EDITOR_URL:-}" ]]; then
        echo "WARN: EDITOR_URL not set — skipping HEAD sanity check." >&2
    else
        probe="$EDITOR_URL/$NEW_ID/browser/cool.html"
        echo "Probing $probe …"
        http="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 15 -I "$probe" || echo 000)"
        if ! [[ "$http" =~ ^[23] ]]; then
            echo "ERROR: $probe returned HTTP $http (expected 2xx/3xx)." >&2
            echo "       Either the deploy isn't finished, the id is wrong," >&2
            echo "       or the editor static doesn't yet serve /<id>/ paths." >&2
            echo "       Re-run with --force to bypass." >&2
            exit 3
        fi
        echo "  OK ($http)"
    fi
fi

# Atomic write: mktemp + mv in the same directory (mv on same filesystem
# is atomic). viewer-server.js's fs.watchFile picks up the new mtime
# without ever seeing a half-written file.
mkdir -p "$(dirname "$VIEWER_CONFIG_FILE")"
prev="$(read_current_id)"
new_id_value="${NEW_ID:-}"   # empty string for --flat
tmp="$(mktemp "$VIEWER_CONFIG_FILE.XXXXXX")"
printf '{ "editor_deploy_id": "%s" }\n' "$new_id_value" > "$tmp"
mv "$tmp" "$VIEWER_CONFIG_FILE"

echo "Pointer updated:"
echo "  file:      $VIEWER_CONFIG_FILE"
echo "  previous:  ${prev:-(flat / unset)}"
echo "  current:   ${new_id_value:-(flat / unset)}"
echo "viewer-server.js's fs.watchFile picks this up within ~2s; in-flight"
echo "tabs already showing the previous id keep using it until they reload."
