#!/usr/bin/env bash
# Regenerate the listing pages so the static-website endpoint browses cleanly.
#   /                   — top-level (lo + app builds, recent first)
#   /lo-builds/         — list of LO builds
#   /app-builds/        — list of online app builds
set -euo pipefail

# shellcheck source=_lib.sh
source "$(dirname "$0")/_lib.sh"
ensure_storage_key

ACCT="${AZURE_STORAGE_ACCOUNT:?}"
SITE="${STATIC_SITE_BASE:?}"

list_prefix() {
    local prefix="$1"
    # --num-results: az defaults to 5000; we already have 6000+ blobs under
    # app-builds/ (mostly per-test screenshots) so the default page cuts off
    # the most recent manifests. Bump to a safe ceiling.
    az storage blob list \
        --account-name "$ACCT" \
        --container-name '$web' \
        --prefix "$prefix" \
        --num-results 100000 \
        --query "[?ends_with(name, '/manifest.json')].name" \
        -o tsv 2>/dev/null | sort -r
}

WORK="$(mktemp -d)"
trap "rm -rf '$WORK'" EXIT

# ── per-section listings ────────────────────────────────────────
gen_section() {
    local prefix="$1" title="$2" out="$3"
    {
        cat <<HTML
<!doctype html>
<meta charset="utf-8"><title>$title</title>
<base href="/$prefix">
<style>body{font:14px system-ui;margin:2rem;max-width:60rem}h1{margin-bottom:.2rem}
table{border-collapse:collapse;width:100%}td,th{padding:.4rem .6rem;border-bottom:1px solid #eee;text-align:left}
a{color:#0066cc;text-decoration:none}a:hover{text-decoration:underline}
.muted{color:#666}.ok{color:#2e7d32}.bad{color:#c62828}</style>
<h1>$title</h1>
<p><a href="/">← root</a></p>
<table><thead><tr><th>Build ID</th><th>When</th><th>Notes</th></tr></thead><tbody>
HTML
        local manifests
        manifests="$(list_prefix "$prefix")"
        if [[ -z "$manifests" ]]; then
            echo '<tr><td colspan="3" class="muted">no builds yet</td></tr>'
        else
            local n=0
            while IFS= read -r mfp; do
                [[ -z "$mfp" ]] && continue
                local id when notes
                # path is "<prefix><id>/manifest.json"
                id="${mfp#$prefix}"; id="${id%/manifest.json}"
                local tmp="$WORK/m-$n.json"; n=$((n+1))
                az storage blob download --account-name "$ACCT" \
                    --container-name '$web' --name "$mfp" --file "$tmp" --no-progress >/dev/null 2>&1 || continue
                when="$(jq -r '.completed_utc // ""' "$tmp" 2>/dev/null)"
                if [[ "$prefix" == "app-builds/" ]]; then
                    local rc lo p_pass p_fail
                    rc="$(jq -r '.test_report.exit_code // empty' "$tmp" 2>/dev/null)"
                    lo="$(jq -r '.lo_build_id // ""' "$tmp" 2>/dev/null)"
                    p_pass="$(jq -r '.test_report.pass_count // empty' "$tmp" 2>/dev/null)"
                    p_fail="$(jq -r '.test_report.fail_count // empty' "$tmp" 2>/dev/null)"
                    if [[ -z "$rc" ]]; then
                        notes="LO=$lo · <span class=\"muted\">no tests yet</span>"
                    elif [[ -n "$p_pass" && -n "$p_fail" ]]; then
                        # Have counts: render as "X passed · Y failed" link.
                        local pass_cls="ok" fail_cls="bad"
                        notes="LO=$lo · <a href=\"$id/tests/\"><span class=\"$pass_cls\">$p_pass passed</span> · <span class=\"$fail_cls\">$p_fail failed</span></a>"
                    elif [[ "$rc" == "0" ]]; then
                        notes="LO=$lo · <a class=\"ok\" href=\"$id/tests/\">tests passed</a>"
                    else
                        notes="LO=$lo · <a class=\"bad\" href=\"$id/tests/\">tests failed (rc=$rc)</a>"
                    fi
                else
                    notes="$(jq -r '.git_short_sha // ""' "$tmp" 2>/dev/null)"
                fi
                printf '<tr><td><a href="%s/">%s</a></td><td class="muted">%s</td><td>%s</td></tr>\n' \
                    "$id" "$id" "$when" "$notes"
                [[ $n -ge 50 ]] && break
            done <<< "$manifests"
        fi
        echo '</tbody></table>'
    } > "$out"
}

gen_section "lo-builds/"  "LibreOffice WASM builds"  "$WORK/lo-builds.html"
gen_section "app-builds/" "Online (cool-wasm) builds" "$WORK/app-builds.html"

# ── root index ──────────────────────────────────────────────────
cat > "$WORK/root.html" <<HTML
<!doctype html>
<meta charset="utf-8"><title>cool wasm builds</title>
<style>body{font:14px system-ui;margin:2rem;max-width:60rem}h1{margin-bottom:.2rem}
a{color:#0066cc;text-decoration:none}a:hover{text-decoration:underline}
.box{border:1px solid #ddd;border-radius:6px;padding:1rem;margin:1rem 0}</style>
<h1>cool wasm — CI build index</h1>
<p class="muted">Static-website endpoint of the <code>coolwasmfiles</code> Azure storage account.</p>
<div class="box">
  <h3><a href="lo-builds/">LibreOffice core builds</a></h3>
  <p>Outputs of the <code>szsz/libreoffice-core-wasm</code> dev branch CI.</p>
</div>
<div class="box">
  <h3><a href="app-builds/">Online (cool-wasm) builds</a></h3>
  <p>Outputs of the <code>szsz/online</code> dev branch CI — each links its test report.</p>
</div>
HTML

upload() {
    local src="$1" name="$2"
    az storage blob upload \
        --account-name "$ACCT" \
        --container-name '$web' --name "$name" --file "$src" \
        --content-type 'text/html; charset=utf-8' \
        --overwrite --no-progress >/dev/null
}

upload "$WORK/lo-builds.html"  "lo-builds/index.html"
upload "$WORK/app-builds.html" "app-builds/index.html"
upload "$WORK/root.html"       "index.html"

echo "Indexes refreshed: $SITE/"
