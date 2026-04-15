#!/usr/bin/env bash
# launch-sni-router.sh — run wasm/sni-router.js with config from wasm/.env.
#
# Defaults route the three on-host services (viewer / editor / relay) to
# their current internal ports. Override via $ROUTES / $DEFAULT / $PORT.
#
# Binding :443 needs CAP_NET_BIND_SERVICE on the node binary or running
# as root. One-time capability grant:
#   sudo setcap 'cap_net_bind_service=+ep' $(readlink -f $(which node))
#
# Usage:
#   bash wasm/launch-sni-router.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"

# Load .env values as DEFAULTS; calling shell wins.
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

# The SNI router listens on SNI_PORT (default 443). We deliberately
# DON'T use $PORT here because wasm/.env reserves that for the viewer
# (and the viewer's launcher). Using SNI_PORT avoids clobbering.
: "${SNI_PORT:=443}"

# If ROUTES isn't set in env, use a sensible default for this host.
: "${ROUTES:=viewer.szebeni.hu=127.0.0.1:6934;wasm.atgpartners.info=127.0.0.1:6932;relay.atgpartners.info=127.0.0.1:9091}"

# Translate to PORT for sni-router.js, without leaking it to sub-processes
# via the loop above.
export PORT="$SNI_PORT"
export ROUTES
exec node "$SCRIPT_DIR/sni-router.js"
