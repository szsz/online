#!/usr/bin/env bash
# cv-provenance.sh — content-viewer provenance helpers (single source of truth).
#
# The pinned Tresorit content-preview commit lives in wasm/CONTENT_VIEWER_COMMIT.txt
# (counterpart to wasm/LO_BUILD_ID). This lib is sourced by the deploy script,
# the three test runners, and the CI publishers so they all resolve + render the
# same value the same way.
#
#   source "<repo>/wasm/lib/cv-provenance.sh"
#   PINNED="$(cv_pinned_commit)"                 # repo-pinned cp commit (40-hex or '')
#   DEPLOYED="$(cv_deployed_commit "$CV_URL")"   # cp commit live at CV_URL (best-effort)
#   cv_provenance_html "$PINNED" "$DEPLOYED" "$CV_URL"   # summary-page HTML block

_CV_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_CV_WASM_DIR="$(cd "$_CV_LIB_DIR/.." && pwd)"

# Repo-pinned content-preview commit. Strips comment (#) + blank lines and takes
# the last remaining line — same parse convention as wasm/LO_BUILD_ID. Prints
# empty (rc 0) when the pin file is absent so callers degrade gracefully.
cv_pinned_commit() {
    local f="${CONTENT_VIEWER_COMMIT_FILE:-$_CV_WASM_DIR/CONTENT_VIEWER_COMMIT.txt}"
    [[ -f "$f" ]] || return 0
    grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$f" | tail -1 | tr -d '[:space:]'
}

# cp_commit currently deployed at a content-viewer URL (reads /version.json).
# Best-effort: short timeout, prints empty on any failure.
cv_deployed_commit() {
    local url="${1:-}"; [[ -n "$url" ]] || return 0
    curl -fsS --max-time 15 "$url/version.json" 2>/dev/null | node -e "
        let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
            try{process.stdout.write(String(JSON.parse(d).cp_commit||''))}catch(e){}
        })" 2>/dev/null || true
}

# 7-char short form.
cv_short() { printf '%.7s' "${1:-}"; }

# Match verdict between a pinned + deployed commit, as a short HTML span.
cv_match_html() {
    local pinned="${1:-}" deployed="${2:-}"
    if [[ -z "$deployed" ]]; then
        printf '<span style="color:#888">(viewer unreachable)</span>'
    elif [[ -z "$pinned" ]]; then
        printf '<span style="color:#888">(no pin)</span>'
    elif [[ "$pinned" == "$deployed" ]]; then
        printf '<span style="color:#16a34a">&#10003; matches pin</span>'
    else
        printf '<span style="color:#dc2626">&#10007; differs from pin</span>'
    fi
}

# Provenance block for a summary page. Args: pinned deployed url
cv_provenance_html() {
    local pinned="${1:-}" deployed="${2:-}" url="${3:-}"
    cat <<HTML
<div class="cv-prov" style="margin:0 0 1.25rem;padding:.6rem .9rem;border:1px solid #e5e7eb;border-radius:6px;background:#fafafa;font-size:.9rem;line-height:1.6">
  <strong>Content viewer</strong>
  &middot; pinned <code>$(cv_short "$pinned")</code>
  &middot; deployed <code>$( [[ -n "$deployed" ]] && cv_short "$deployed" || printf '&mdash;' )</code>
  $(cv_match_html "$pinned" "$deployed")
  $( [[ -n "$url" ]] && printf '&middot; <a href="%s/version.json">version.json</a> <span style="color:#888">%s</span>' "$url" "$url" )
</div>
HTML
}
