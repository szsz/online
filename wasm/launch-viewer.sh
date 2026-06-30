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
ENV_FILE="${ENV_FILE:-$HOME/ENV/online.env}"

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

# The viewer iframes into ${EDITOR_URL}/<editor_deploy_id>/cool.html. The
# id comes from VIEWER_CONFIG_FILE (a small JSON on this host, NOT in
# git). An operator updates it via wasm/promote-editor.sh when ready to
# flip the viewer to a freshly-deployed editor. Refuse to start without
# the file — running with a missing pointer would silently fall through
# to legacy flat URLs and confuse the rollout.
#
# Exception: if VIEWER_CONFIG_FILE is explicitly unset/empty in the
# calling environment AND .env, we tolerate that as "I'm in local dev,
# editor is flat, no pointer needed". Production callers MUST set it in
# .env so this check fires.
if [[ -n "${VIEWER_CONFIG_FILE:-}" ]]; then
    # Expand ~ to $HOME (Node's expandHome handles this too, but the
    # existence check below needs the absolute path).
    case "$VIEWER_CONFIG_FILE" in
        '~/'*) VIEWER_CONFIG_FILE="$HOME/${VIEWER_CONFIG_FILE#~/}" ;;
        '~')   VIEWER_CONFIG_FILE="$HOME" ;;
    esac
    if [[ ! -f "$VIEWER_CONFIG_FILE" ]]; then
        echo "ERROR: VIEWER_CONFIG_FILE=$VIEWER_CONFIG_FILE does not exist." >&2
        echo "       Create it with the current editor deploy id, e.g.:" >&2
        echo "         echo '{\"editor_deploy_id\":\"\"}' > $VIEWER_CONFIG_FILE" >&2
        echo "       Then update it with the real id via:" >&2
        echo "         bash wasm/promote-editor.sh <YYYY-MM-DD-HHMMSS>" >&2
        exit 1
    fi
    # Sanity-parse the JSON so we fail-fast on a typo'd file rather than
    # letting the viewer serve broken config until the operator notices.
    if ! python3 -c "import json,sys; json.load(open('$VIEWER_CONFIG_FILE'))" 2>/dev/null; then
        echo "ERROR: VIEWER_CONFIG_FILE=$VIEWER_CONFIG_FILE is not valid JSON." >&2
        exit 1
    fi
    export VIEWER_CONFIG_FILE
fi

# Bridge the dev-box MI gap: this VM's Managed Identity has Contributor
# on coolwasmfiles (control-plane → can list account keys) but NOT
# Storage Blob Data Contributor (data-plane → blob writes 401). So
# DefaultAzureCredential auths but every PUT /api/v2/file/<id> 500s
# with empty error.
#
# When STORAGE_BACKEND=azure and the operator hasn't pre-supplied
# DOC_STORAGE_KEY or DOC_STORAGE_SAS_URL, mint an account key at startup
# from the MI's Contributor role. This is identical to the trick the
# CI scripts use (.github/scripts/wasm-ci/_lib.sh::ensure_storage_key).
# The key is held only in this process's env; nothing persists to disk.
#
# The Azure App Service deploy doesn't go through this script, so its
# viewer keeps using DefaultAzureCredential straight (its MI has the
# data-plane role).
if [[ "$STORAGE_BACKEND" == "azure" \
   && -n "${DOC_STORAGE_ACCOUNT:-}" \
   && -z "${DOC_STORAGE_KEY:-}" \
   && -z "${DOC_STORAGE_SAS_URL:-}" ]]; then
    if command -v az >/dev/null 2>&1; then
        echo "Minting DOC_STORAGE_KEY for $DOC_STORAGE_ACCOUNT via MI control-plane…"
        if KEY="$(az storage account keys list \
                    --account-name "$DOC_STORAGE_ACCOUNT" \
                    --query '[0].value' -o tsv 2>/dev/null)" \
           && [[ -n "$KEY" ]]; then
            export DOC_STORAGE_KEY="$KEY"
            echo "  OK — viewer will use shared-key auth (data-plane bridge)."
        else
            echo "  WARNING: could not list keys (no MI? insufficient role?). Falling back to DefaultAzureCredential — uploads may 500." >&2
        fi
    fi
fi

export PORT STORAGE_BACKEND
exec node "$SCRIPT_DIR/viewer-server.js"
