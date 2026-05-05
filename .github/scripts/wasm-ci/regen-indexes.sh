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
<table><thead><tr><th>Build ID</th><th>When (UTC)</th><th>Branch</th><th>Commit</th><th>Tests</th><th>Notes</th></tr></thead><tbody>
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
                local branch sha sha_short
                # git_ref is "refs/heads/<branch>" or "refs/pull/.../merge"
                branch="$(jq -r '.git_ref // ""' "$tmp" 2>/dev/null | sed -E 's|^refs/heads/||;s|^refs/pull/([0-9]+).*|PR #\1|')"
                sha="$(jq -r '.git_sha // .git_short_sha // ""' "$tmp" 2>/dev/null)"
                sha_short="${sha:0:12}"
                if [[ "$prefix" == "app-builds/" || "$prefix" == "local-builds/" ]]; then
                    local rc lo p_pass p_fail tests_cell profile
                    rc="$(jq -r '.test_report.exit_code // empty' "$tmp" 2>/dev/null)"
                    lo="$(jq -r '.lo_build_id // ""' "$tmp" 2>/dev/null)"
                    p_pass="$(jq -r '.test_report.pass_count // empty' "$tmp" 2>/dev/null)"
                    p_fail="$(jq -r '.test_report.fail_count // empty' "$tmp" 2>/dev/null)"
                    profile="$(jq -r '.test_profile // ""' "$tmp" 2>/dev/null)"
                    if [[ -z "$rc" ]]; then
                        tests_cell="<span class=\"muted\">no tests yet</span>"
                    elif [[ -n "$p_pass" && -n "$p_fail" ]]; then
                        tests_cell="<a href=\"$id/tests/\"><span class=\"ok\">$p_pass</span> / <span class=\"bad\">$p_fail</span></a>"
                    elif [[ "$rc" == "0" ]]; then
                        tests_cell="<a class=\"ok\" href=\"$id/tests/\">passed</a>"
                    else
                        tests_cell="<a class=\"bad\" href=\"$id/tests/\">failed (rc=$rc)</a>"
                    fi
                    notes="LO=$lo"
                    [[ -n "$profile" ]] && notes="$notes · profile=$profile"
                    printf '<tr><td><a href="%s/">%s</a></td><td class="muted">%s</td><td>%s</td><td><code>%s</code></td><td>%s</td><td>%s</td></tr>\n' \
                        "$id" "$id" "$when" "$branch" "$sha_short" "$tests_cell" "$notes"
                else
                    # lo-builds: branch + commit + size from git_short_sha + a generic notes column
                    notes="$(jq -r '.lo_core_tar_size_human // ""' "$tmp" 2>/dev/null)"
                    printf '<tr><td><a href="%s/">%s</a></td><td class="muted">%s</td><td>%s</td><td><code>%s</code></td><td class="muted">—</td><td>%s</td></tr>\n' \
                        "$id" "$id" "$when" "$branch" "$sha_short" "$notes"
                fi
                [[ $n -ge 50 ]] && break
            done <<< "$manifests"
        fi
        echo '</tbody></table>'
    } > "$out"
}

gen_section "lo-builds/"    "LibreOffice WASM builds"    "$WORK/lo-builds.html"
gen_section "app-builds/"   "Online (cool-wasm) builds"  "$WORK/app-builds.html"
gen_section "local-builds/" "Local CI runs (ci-viewer.szebeni.hu)" "$WORK/local-builds.html"

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
<div class="box">
  <h3><a href="local-builds/">Local CI runs (ci-viewer.szebeni.hu)</a></h3>
  <p>Manual <code>workflow_dispatch</code> runs of <code>wasm-ci-local.yml</code> — tests run on the dev box's CI stack (ci-viewer.szebeni.hu / ci-editor.atgpartners.info / ci-relay.atgpartners.info) with selectable profile (basic / non-basic / snapshot / all).</p>
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

upload "$WORK/lo-builds.html"    "lo-builds/index.html"
upload "$WORK/app-builds.html"   "app-builds/index.html"
upload "$WORK/local-builds.html" "local-builds/index.html"
upload "$WORK/root.html"         "index.html"

echo "Indexes refreshed: $SITE/"
