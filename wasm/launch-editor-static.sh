#!/usr/bin/env bash
# launch-editor-static.sh — run wasm/editor-static-server.js with config
# from wasm/.env (and a few editor-static-specific defaults).
#
# Behind the SNI router, this serves wasm.atgpartners.info.
# HTTPS needs root (cert files are root-only); HTTP fine as any user.
#
# Usage:
#   sudo bash wasm/launch-editor-static.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"

# Load .env values as defaults (calling shell wins).
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

# editor-static-specific defaults. We deliberately use distinct env var
# names from the viewer launcher (which uses SSL_CERT / SSL_KEY for its
# own viewer.szebeni.hu cert via .env). EDITOR_SSL_* keeps the two
# launchers from clobbering each other when both source the same .env.
: "${HTTP_PORT:=6931}"
: "${HTTPS_PORT:=6932}"
: "${EDITOR_SSL_CERT:=/etc/letsencrypt/live/wasm.atgpartners.info/fullchain.pem}"
: "${EDITOR_SSL_KEY:=/etc/letsencrypt/live/wasm.atgpartners.info/privkey.pem}"

# .env's FILE_STORAGE_URL is the viewer's public URL — exactly what the
# editor-static needs for the CSP frame-ancestors header.
if [[ -z "${FILE_STORAGE_URL:-}" ]]; then
    echo "ERROR: FILE_STORAGE_URL is unset. Set it in $ENV_FILE." >&2
    exit 1
fi

# editor-static-server.js reads SSL_CERT/SSL_KEY (the canonical names),
# so map our editor-specific vars onto those right before exec.
export HTTP_PORT HTTPS_PORT FILE_STORAGE_URL
export SSL_CERT="$EDITOR_SSL_CERT"
export SSL_KEY="$EDITOR_SSL_KEY"
exec node "$SCRIPT_DIR/editor-static-server.js"
