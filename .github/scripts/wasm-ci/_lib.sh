# Sourced helper for CI scripts using the coolwasmfiles storage account.
# Not directly executable.
#
# The runner's MSI has Contributor (control-plane) on the storage account but
# NOT Storage Blob Data Contributor (data-plane). It can however list account
# keys via the Contributor role. We fetch the key once at the start of each
# script and export AZURE_STORAGE_KEY so subsequent `az storage blob …` calls
# transparently use key auth.

ensure_storage_key() {
    if [[ -z "${AZURE_STORAGE_KEY:-}" ]]; then
        AZURE_STORAGE_KEY="$(az storage account keys list \
            --account-name "${AZURE_STORAGE_ACCOUNT:?AZURE_STORAGE_ACCOUNT must be set}" \
            --query '[0].value' -o tsv)"
        export AZURE_STORAGE_KEY
    fi
}

# Install wasm/node_modules (+ puppeteer's Chromium) from the persistent
# host cache under $CI_STATE_DIR, symlinked into the workspace. Idempotent:
# re-installs only when package-lock.json changed or puppeteer is missing.
# Shared by test-critical.sh (the merge gate) and test-local.sh (full
# suite) so both resolve `require('puppeteer')`. Exports PUPPETEER_CACHE_DIR.
ensure_node_modules() {
    local ws="${1:-${GITHUB_WORKSPACE:-$(pwd)}}"
    : "${CI_STATE_DIR:?CI_STATE_DIR must be set}"
    local nm="$CI_STATE_DIR/online-node-modules"
    local npmc="$CI_STATE_DIR/npm-cache"
    local pupc="$CI_STATE_DIR/puppeteer-cache"
    mkdir -p "$nm" "$npmc" "$pupc"
    export PUPPETEER_CACHE_DIR="$pupc"
    rm -rf "$ws/wasm/node_modules"
    ln -s "$nm" "$ws/wasm/node_modules"
    local lock="$ws/wasm/package-lock.json"
    local stamp="$nm/.installed-from-lock"
    if [[ ! -f "$stamp" ]] || ! cmp -s "$lock" "$stamp" || [[ ! -d "$nm/puppeteer" ]]; then
        echo "--- Installing wasm/node_modules ---"
        find "$nm" -mindepth 1 -delete 2>/dev/null || true
        ( cd "$ws/wasm" && npm ci --cache "$npmc" --prefer-offline --no-audit --no-fund 2>&1 | tail -8 )
        cp "$lock" "$stamp"
    else
        echo "[OK] node_modules cache hit."
    fi
}
