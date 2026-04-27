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

# deploy-azure.sh expects build artefacts at wasm/online-build/. The actual
# build output lives in $CI_STATE_DIR/online-build/ (bind-mounted into the
# container at /lo/online/wasm/online-build during build). On the host
# wasm/online-build is empty after checkout, so we symlink it here so the
# deploy script's "Copying browser/dist/" step finds the artefacts.
ONLINE_BUILD_HOST="${CI_STATE_DIR}/online-build"
if [[ ! -d "$ONLINE_BUILD_HOST/browser/dist" ]]; then
    echo "ERROR: $ONLINE_BUILD_HOST/browser/dist missing — earlier build step didn't produce editor artefacts." >&2
    exit 1
fi
rm -rf "$WORKSPACE/wasm/online-build"
ln -s "$ONLINE_BUILD_HOST" "$WORKSPACE/wasm/online-build"

bash "$WORKSPACE/wasm/deploy-azure.sh"
