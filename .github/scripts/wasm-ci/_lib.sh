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
