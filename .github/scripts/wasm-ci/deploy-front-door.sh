#!/usr/bin/env bash
# Deploy the freshly-built editor to Azure Front Door + Storage
# (static-website mode). Wrapper around wasm/deploy-front-door.sh that
# sources the deploy env file and optionally applies the FD rule set.
#
# Env file: ~/ENV/online-front-door-deploy.env on the runner host —
# same convention as deploy.sh (App Service path) uses for staging env.
set -euo pipefail

WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
FD_DEPLOY_ENV="${FD_DEPLOY_ENV:-$HOME/ENV/online-front-door-deploy.env}"

if [[ ! -f "$FD_DEPLOY_ENV" ]]; then
    echo "ERROR: $FD_DEPLOY_ENV not found." >&2
    echo "       Provision it on the runner host with at least:" >&2
    echo "         EDITOR_STORAGE_ACCOUNT, EDITOR_STORAGE_CONTAINER, EDITOR_FD_URL" >&2
    echo "       Optional (enables rule auto-apply):" >&2
    echo "         AZURE_FD_PROFILE, AZURE_FD_RG, AZURE_FD_ENDPOINT, AZURE_FD_ROUTE" >&2
    exit 1
fi
set -a; source "$FD_DEPLOY_ENV"; set +a

# Source the wasm/online-build symlink the App-Service deploy step set up
# earlier in this job — deploy-front-door.sh reads browser/dist + paired
# online.{js,wasm} from there.
if [[ ! -L "$WORKSPACE/wasm/online-build" && ! -d "$WORKSPACE/wasm/online-build" ]]; then
    echo "ERROR: wasm/online-build symlink missing — deploy.sh must run first" >&2
    exit 1
fi

# Apply the FD rule set first (idempotent — fingerprint check inside the
# script makes this a no-op when rules haven't changed). Skip cleanly if
# the AFD profile/RG/endpoint env vars haven't been provisioned yet —
# rule apply is independent of the build deploy and can land later.
if [[ -n "${AZURE_FD_PROFILE:-}" && -n "${AZURE_FD_RG:-}" && -n "${AZURE_FD_ENDPOINT:-}" ]]; then
    echo "=== Applying Front Door rule set (idempotent) ==="
    bash "$WORKSPACE/wasm/apply-front-door-rules.sh"
else
    echo "=== Skipping FD rule apply: AZURE_FD_PROFILE/RG/ENDPOINT not set in $FD_DEPLOY_ENV ==="
fi

# Run the deploy.
ENV_FILE="$FD_DEPLOY_ENV" bash "$WORKSPACE/wasm/deploy-front-door.sh"
