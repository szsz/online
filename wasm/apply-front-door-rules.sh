#!/usr/bin/env bash
# apply-front-door-rules.sh — idempotently apply the editor's FD rule set.
#
# The rule set is intentionally small. The editor is a per-deploy
# folder model: each build lives at /<APP_BUILD_ID>/, immutable by
# construction. The whole storage account exists for editor content,
# every byte of it; we mark everything immutable. To "update" you
# deploy a new folder and point the viewer at it — never overwrite.
#
# Rules:
#   1. Global response headers — COOP/COEP/CORP/CORS (needed for
#      cross-origin isolated SharedArrayBuffer + cross-origin embedding
#      by the viewer iframe)
#   2. Global Cache-Control: immutable — everything is content-
#      addressed by URL path (the <id>/ folder is the version)
#
# Brotli handling is NOT done via FD URL rewrite. The deploy step
# uploads pre-compressed `.br` content as the canonical blob URL with
# Content-Encoding: br metadata — browsers decompress transparently.
# All modern browsers support brotli; non-brotli clients get
# undecodable bytes (theoretical concern only).
#
# Inputs:
#   AZURE_FD_PROFILE   FD profile name (e.g. wasmeditor)
#   AZURE_FD_RG        resource group
#   AZURE_FD_ENDPOINT  endpoint name
#   AZURE_FD_ROUTE     route to attach (default: default-route)
#
# Tags the rule set with sha256(this script) so subsequent runs skip
# work when nothing in the rules has changed.

set -euo pipefail

: "${AZURE_FD_PROFILE:?}"
: "${AZURE_FD_RG:?}"
: "${AZURE_FD_ENDPOINT:?}"
: "${AZURE_FD_ROUTE:=default-route}"

RS=editor

WANT_HASH="$(sha256sum "$0" | cut -d' ' -f1)"
echo "applier fingerprint: $WANT_HASH"

HAVE_HASH="$(az afd rule-set show \
    --profile-name "$AZURE_FD_PROFILE" \
    --resource-group "$AZURE_FD_RG" \
    --rule-set-name "$RS" \
    --query "tags.\"applier-fingerprint\"" -o tsv 2>/dev/null || true)"
if [[ "$HAVE_HASH" == "$WANT_HASH" ]]; then
    echo "Rule set '$RS' already at fingerprint $WANT_HASH — nothing to apply."
    exit 0
fi
echo "applier fingerprint (current): ${HAVE_HASH:-<none>}"

PROF=(--profile-name "$AZURE_FD_PROFILE" --resource-group "$AZURE_FD_RG" --rule-set-name "$RS")

# Delete + recreate the rule set (idempotent reset).
# Order matters: detach from route first, else Azure refuses to delete
# with "This resource is still associated with a route."
if az afd rule-set show "${PROF[@]:0:4}" --rule-set-name "$RS" -o none 2>/dev/null; then
    echo "Detaching rule set '$RS' from route '$AZURE_FD_ROUTE'..."
    # `az afd route update --rule-sets ""` should clear it; if it
    # doesn't, az takes a JSON array via shorthand.
    az afd route update \
        --profile-name "$AZURE_FD_PROFILE" \
        --resource-group "$AZURE_FD_RG" \
        --endpoint-name "$AZURE_FD_ENDPOINT" \
        --route-name "$AZURE_FD_ROUTE" \
        --rule-sets '[]' \
        --only-show-errors > /dev/null 2>&1 || true
    echo "Deleting existing rule set '$RS'..."
    az afd rule-set delete "${PROF[@]:0:4}" --rule-set-name "$RS" --yes --only-show-errors > /dev/null
fi

echo "Creating rule set '$RS'..."
az afd rule-set create "${PROF[@]:0:4}" --rule-set-name "$RS" --only-show-errors > /dev/null

# ── Rule 1: global headers (COOP/COEP/CORP + CORS) ──────────────
echo "  [1] globalHeaders"
az afd rule create "${PROF[@]}" --rule-name globalHeaders --order 1 \
    --match-processing-behavior Continue \
    --action-name ModifyResponseHeader \
    --header-action Overwrite \
    --header-name 'Cross-Origin-Opener-Policy' --header-value 'same-origin' \
    --only-show-errors > /dev/null

for pair in \
    'Cross-Origin-Embedder-Policy=require-corp' \
    'Cross-Origin-Resource-Policy=cross-origin' \
    'Access-Control-Allow-Origin=*' \
    'Access-Control-Allow-Methods=GET, HEAD, OPTIONS'; do
    name="${pair%%=*}"; value="${pair#*=}"
    az afd rule action add "${PROF[@]}" --rule-name globalHeaders \
        --action-name ModifyResponseHeader \
        --header-action Overwrite \
        --header-name "$name" --header-value "$value" \
        --only-show-errors > /dev/null
done

# ── Rule 2: everything immutable ───────────────────────────────────
# The editor storage is the per-deploy content store. Every blob URL is
# versioned by its <id>/ path. Mark everything immutable; updates ship
# as a new <id>/ folder + viewer pointer flip.
echo "  [2] immutableAll"
az afd rule create "${PROF[@]}" --rule-name immutableAll --order 2 \
    --match-processing-behavior Continue \
    --action-name ModifyResponseHeader \
    --header-action Overwrite \
    --header-name 'Cache-Control' --header-value 'public, max-age=31536000, immutable' \
    --only-show-errors > /dev/null

# ── Tag rule-set with fingerprint ──────────────────────────────────
az afd rule-set update "${PROF[@]:0:4}" --rule-set-name "$RS" \
    --set "tags.\"applier-fingerprint\"=$WANT_HASH" \
    --only-show-errors > /dev/null 2>&1 || echo "  WARN: tag failed (non-fatal)"

# ── Attach to route ────────────────────────────────────────────────
# Empirically `az afd route update --rule-sets <full-id>` is a no-op
# (silently fails to attach); using the rule-set NAME works.
echo "Attaching rule set to route '$AZURE_FD_ROUTE'..."
az afd route update \
    --profile-name "$AZURE_FD_PROFILE" \
    --resource-group "$AZURE_FD_RG" \
    --endpoint-name "$AZURE_FD_ENDPOINT" \
    --route-name "$AZURE_FD_ROUTE" \
    --rule-sets "$RS" \
    --only-show-errors > /dev/null

# Purge edge so the new rules take effect on next request.
echo "Purging FD edge cache..."
az afd endpoint purge \
    --profile-name "$AZURE_FD_PROFILE" \
    --resource-group "$AZURE_FD_RG" \
    --endpoint-name "$AZURE_FD_ENDPOINT" \
    --content-paths '/*' \
    --no-wait --only-show-errors > /dev/null 2>&1 || true

echo "Done. Rule set '$RS' applied + attached to route '$AZURE_FD_ROUTE'."
echo "Note: FD edge propagation can take 5-15 min."
