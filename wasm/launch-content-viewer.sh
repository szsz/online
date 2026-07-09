#!/usr/bin/env bash
# launch-content-viewer.sh — serve the Tresorit content-preview build
# (wasm/content-viewer-server.js) in place of the legacy viewer.
#
# Same env-loading convention as launch-viewer.sh: values in $ENV_FILE are
# DEFAULTS; the calling shell's environment wins. Reuses the viewer host's
# SSL_CERT / SSL_KEY / PORT so it drops into the same SNI-router slot.
#
# Required env (in $ENV_FILE or the calling shell):
#   CONTENT_VIEWER_DIST   path to the built content-preview dist/
# Optional env:
#   PORT                  listen port (default 6934)
#   SSL_CERT, SSL_KEY     PEM paths; if both set → HTTPS
#   CSP                   Content-Security-Policy header value

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$HOME/ENV/online.env}"

if [[ -f "$ENV_FILE" ]]; then
    while IFS='=' read -r key value; do
        [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
        value="${value%\"}"; value="${value#\"}"
        value="${value%\'}"; value="${value#\'}"
        if [[ -z "${!key+x}" ]]; then
            export "$key=$value"
        fi
    done < "$ENV_FILE"
fi

: "${PORT:=6934}"
: "${CONTENT_VIEWER_DIST:=$HOME/content-preview/dist}"

# Expand a leading ~ so the existence check + Node see an absolute path.
case "$CONTENT_VIEWER_DIST" in
    '~/'*) CONTENT_VIEWER_DIST="$HOME/${CONTENT_VIEWER_DIST#~/}" ;;
    '~')   CONTENT_VIEWER_DIST="$HOME" ;;
esac

if [[ ! -f "$CONTENT_VIEWER_DIST/index.html" ]]; then
    echo "ERROR: CONTENT_VIEWER_DIST=$CONTENT_VIEWER_DIST has no index.html." >&2
    echo "       Build content-preview (pnpm build) or set CONTENT_VIEWER_DIST." >&2
    exit 1
fi

export PORT CONTENT_VIEWER_DIST
exec node "$SCRIPT_DIR/content-viewer-server.js"
