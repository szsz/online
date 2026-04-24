#!/usr/bin/env bash
# launch-relay.sh — run wasm/message-relay.js with config from wasm/.env.
#
# Behind the SNI router, the relay serves relay.atgpartners.info. The
# relay has its own TLS cert (different hostname from the viewer and
# editor), so .env carries dedicated RELAY_PORT / RELAY_SSL_CERT /
# RELAY_SSL_KEY entries — reusing the viewer's SSL_CERT/PORT would
# serve the wrong SAN on wss://relay.atgpartners.info and silently
# break co-editing for real browsers (test browsers suppress the
# error via --ignore-certificate-errors).
#
# Same pattern as launch-editor-static.sh: load namespaced vars from
# .env, then map them onto the generic SSL_CERT/SSL_KEY/PORT that
# message-relay.js reads.
#
# Usage:
#   sudo bash wasm/launch-relay.sh
#
# Required env (set in wasm/.env or in the calling shell):
#   RELAY_PORT           listen port (default 9091)
#   RELAY_SSL_CERT       PEM path for relay.atgpartners.info fullchain
#   RELAY_SSL_KEY        PEM path for relay.atgpartners.info privkey
# Optional env:
#   RELAY_HOSTNAME       hostname the relay advertises (default
#                        relay.atgpartners.info). Used by the startup
#                        cert sanity check in message-relay.js.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"

# Load .env values as DEFAULTS — the calling shell's environment wins,
# so e.g. `RELAY_PORT=9092 bash launch-relay.sh` overrides .env's value.
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

# Require the relay-specific vars — refuse to start with misconfig
# rather than fall back to the viewer's cert (which would silently
# serve the wrong SAN and break browser wss handshakes).
for var in RELAY_PORT RELAY_SSL_CERT RELAY_SSL_KEY; do
    if [[ -z "${!var:-}" ]]; then
        echo "ERROR: $var is unset. Set it in $ENV_FILE or the calling shell." >&2
        exit 1
    fi
done

if [[ ! -r "$RELAY_SSL_CERT" ]]; then
    echo "ERROR: RELAY_SSL_CERT not readable: $RELAY_SSL_CERT" >&2
    exit 1
fi

# message-relay.js reads generic PORT / SSL_CERT / SSL_KEY — map the
# namespaced RELAY_* values onto them right before exec.
export PORT="$RELAY_PORT"
export SSL_CERT="$RELAY_SSL_CERT"
export SSL_KEY="$RELAY_SSL_KEY"

exec node "$SCRIPT_DIR/message-relay.js"
