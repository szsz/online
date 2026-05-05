#!/usr/bin/env bash
# Deploy the freshly-built online to Azure App Services (prod tier).
# Reuses ~/ENV/online-prod-deploy.env on the runner host so deploy
# targets and storage account names stay out of source control.
#
# Runner identity (MSI) is what az uses; deploy-azure.sh fails fast if
# the CLI isn't logged in.
set -euo pipefail

WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
PROD_DEPLOY_ENV="${PROD_DEPLOY_ENV:-$HOME/ENV/online-prod-deploy.env}"

if [[ ! -f "$PROD_DEPLOY_ENV" ]]; then
    echo "ERROR: $PROD_DEPLOY_ENV not found." >&2
    echo "       Provision it once on the runner host: copy" >&2
    echo "       wasm/.env.deploy.example to $PROD_DEPLOY_ENV and fill in." >&2
    exit 1
fi

# deploy-azure.sh expects build artefacts at wasm/online-build/. The actual
# build output lives in $CI_STATE_DIR/online-build/ (bind-mounted into the
# container at /lo/online/wasm/online-build during build). On the host
# wasm/online-build is empty after checkout, so we symlink it here so the
# deploy script's "Copying browser/dist/" step finds the artefacts.
ONLINE_BUILD_HOST="${CI_STATE_DIR:?}/online-build"
if [[ ! -d "$ONLINE_BUILD_HOST/browser/dist" ]]; then
    echo "ERROR: $ONLINE_BUILD_HOST/browser/dist missing — earlier build step didn't produce editor artefacts." >&2
    exit 1
fi
rm -rf "$WORKSPACE/wasm/online-build"
ln -s "$ONLINE_BUILD_HOST" "$WORKSPACE/wasm/online-build"

# Pass ENV_FILE explicitly. This OVERRIDES the runner agent's
# /home/localadmin/actions-runners/online/.env value (which sets
# ENV_FILE=~/ENV/online-ci.env for the launchers in the local-CI lane).
# Without the explicit override, deploy-azure.sh would source the
# wrong env file (the local-stack one).
ENV_FILE="$PROD_DEPLOY_ENV" bash "$WORKSPACE/wasm/deploy-azure.sh"
