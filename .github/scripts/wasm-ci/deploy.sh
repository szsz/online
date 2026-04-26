#!/usr/bin/env bash
# Deploy the freshly-built online to Azure App Services using the existing
# wasm/deploy-azure.sh. Reuses .env.deploy on the runner host so we don't
# put deploy targets in source control. Runner identity (MSI) is what az
# uses; deploy-azure.sh fails fast if not logged in.
set -euo pipefail

WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
ENV_DEPLOY_HOST="${CI_STATE_DIR:?}/.env.deploy"

if [[ ! -f "$ENV_DEPLOY_HOST" ]]; then
    echo "ERROR: $ENV_DEPLOY_HOST not found." >&2
    echo "       Provision it once on the runner host with the Azure App Service names + storage keys." >&2
    echo "       Template: $WORKSPACE/wasm/.env.deploy.example" >&2
    exit 1
fi

# deploy-azure.sh reads wasm/.env.deploy. Symlink the host-managed file in.
ln -sf "$ENV_DEPLOY_HOST" "$WORKSPACE/wasm/.env.deploy"

bash "$WORKSPACE/wasm/deploy-azure.sh"
