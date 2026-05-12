#!/usr/bin/env bash
# Publish a small manifest for an editor-only build (Front Door static).
#
# Layout on coolwasmfiles ($web container, static-website endpoint):
#   editor-builds/<EDITOR_BUILD_ID>/manifest.json
#   editor-builds/latest.txt                       — id of newest build
#   editor-builds/index.html                       — regen'd listing
#
# An editor build is the contents of `<APP_BUILD_ID>/...` on the
# wasmeditor FD endpoint — i.e. what `deploy-front-door.sh` just
# uploaded. We don't archive zips here (the deploy is the artefact;
# FD storage is durable); the manifest just records what was built
# and when so the index listing has something to show.
#
# Required env:
#   EDITOR_BUILD_ID
#   LO_BUILD_ID
#   AZURE_STORAGE_ACCOUNT   (coolwasmfiles)
#   STATIC_SITE_BASE        (https://coolwasmfiles.z6.web.core.windows.net)
#
# Optional:
#   GIT_SHA, GIT_REF        — recorded as-is
#   EDITOR_FD_URL           — recorded as endpoints.editor

set -euo pipefail

# shellcheck source=_lib.sh
source "$(dirname "$0")/_lib.sh"
ensure_storage_key

EBID="${EDITOR_BUILD_ID:?}"
LO_BID="${LO_BUILD_ID:?}"
ACCT="${AZURE_STORAGE_ACCOUNT:?}"
SITE="${STATIC_SITE_BASE:?}"

# The FD endpoint where the editor lives. Read from the deploy env
# if available so the manifest's "endpoints.editor" is a working
# clickable URL.
FD_DEPLOY_ENV="${FD_DEPLOY_ENV:-$HOME/ENV/online-front-door-deploy.env}"
if [[ -f "$FD_DEPLOY_ENV" ]]; then
    # shellcheck disable=SC1090
    set -a; source "$FD_DEPLOY_ENV"; set +a
fi
EDITOR_FD_URL="${EDITOR_FD_URL:-https://wasmeditor-enhhe6gndwb0d2ej.a02.azurefd.net}"

OUT="$(mktemp -d)"
trap "rm -rf '$OUT'" EXIT

cat > "$OUT/manifest.json" <<JSON
{
  "editor_build_id": "$EBID",
  "lo_build_id": "$LO_BID",
  "git_sha": "${GIT_SHA:-}",
  "git_ref": "${GIT_REF:-}",
  "completed_utc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "endpoints": {
    "editor": "$EDITOR_FD_URL/$EBID/"
  }
}
JSON

upload() {
    local src="$1" name="$2" ct="${3:-application/json}"
    az storage blob upload \
        --account-name "$ACCT" \
        --container-name '$web' \
        --name "$name" \
        --file "$src" \
        --content-type "$ct" \
        --overwrite \
        --no-progress >/dev/null
}

upload "$OUT/manifest.json" "editor-builds/$EBID/manifest.json"

# Latest pointer — flipped LAST so a half-uploaded build never becomes
# `latest`. wasm-ci.yml (viewer-only path) reads this to fill in
# editor_build_id when no editor rebuild happened this run.
echo -n "$EBID" > "$OUT/latest.txt"
upload "$OUT/latest.txt" "editor-builds/latest.txt" "text/plain"

# Regenerate the index pages so the new editor-builds/<id>/ shows up
# in the listings.
bash "$(dirname "$0")/regen-indexes.sh"

echo "Published: $SITE/editor-builds/$EBID/"
echo "         + $SITE/editor-builds/latest.txt now points at $EBID"
