#!/usr/bin/env bash
# launch-viewer.sh — run wasm/viewer-server.js with config from wasm/.env
#
# All deployments now run from the SAME source code (wasm/viewer-server.js
# + wasm/viewer-public/) — only the env-var configuration differs:
#
#   - Local dev/host: this script. Loads wasm/.env and adds the
#     SSL_CERT / SSL_KEY / LOCAL_STORAGE_DIR / PORT values needed for
#     the on-host HTTPS deployment.
#   - Azure App Services: wasm/deploy-azure.sh. App Settings (set via
#     `az webapp config appsettings set`) carry the same env vars
#     except SSL_* (Azure terminates TLS at the platform).
#
# Usage:
#   bash wasm/launch-viewer.sh
#
# Required env (set in wasm/.env or in the calling shell):
#   FILE_STORAGE_URL    public URL the viewer is reachable at
#   EDITOR_URL          public URL of the editor app
#   RELAY_URL           wss:// URL of the relay
#   STORAGE_BACKEND     local | azure
# Optional env:
#   PORT                listen port (default 6934)
#   LOCAL_STORAGE_DIR   when STORAGE_BACKEND=local
#   SSL_CERT, SSL_KEY   PEM paths; if both set, listen with HTTPS
#   ALLOWED_ORIGINS     CORS allow-list, comma-separated, or "*"
#   DOC_STORAGE_*       when STORAGE_BACKEND=azure (account/key/container)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"

# Load .env values as DEFAULTS — the calling shell's environment wins,
# so e.g. `PORT=8080 bash launch-viewer.sh` overrides .env's PORT.
if [[ -f "$ENV_FILE" ]]; then
    while IFS='=' read -r key value; do
        # Skip comments and blanks
        [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
        # Strip surrounding quotes from value
        value="${value%\"}"; value="${value#\"}"
        value="${value%\'}"; value="${value#\'}"
        # Only export if NOT already set in the calling environment
        if [[ -z "${!key+x}" ]]; then
            export "$key=$value"
        fi
    done < "$ENV_FILE"
fi

# Hard defaults if neither shell nor .env set them.
: "${PORT:=6934}"
: "${STORAGE_BACKEND:=local}"

# Friendlier failure than the server's own error if the URL trio is
# missing (which would render the viewer unusable from the browser).
for var in FILE_STORAGE_URL EDITOR_URL RELAY_URL; do
    if [[ -z "${!var:-}" ]]; then
        echo "ERROR: $var is unset. Set it in $ENV_FILE or the calling shell." >&2
        exit 1
    fi
done

export PORT STORAGE_BACKEND
exec node "$SCRIPT_DIR/viewer-server.js"
