#!/usr/bin/env bash
# build-dicts.sh — produce per-language lazy-loadable hunspell dictionary
# bundles for the lazy-load spellcheck runtime.
#
# Sources: github.com/LibreOffice/dictionaries (upstream LO dicts).
#
# For each requested top-level language directory (e.g. "en", "de", "fr"),
# we download:
#   - description.xml           extension manifest (for LO's package loader)
#   - dictionaries.xcu          maps locale → .aff/.dic file pair
#   - *.dic                     hunspell dict files (multiple per language is
#                               fine — one per region, e.g. en_US + en_GB)
#   - *.aff                     hunspell affix files
#   - META-INF/manifest.xml     OXT package metadata (if present)
# and we intentionally OMIT:
#   - *.idx / *.dat / thesaurus / hyphenation — not needed for spellcheck
#   - README*, *.txt, *.png, dialog/, Lightproof.py — not used by hunspell
#
# Packaging: plain POSIX tar of the selected files, then gzip -9.
# We used brotli initially but `DecompressionStream('br')` is not supported
# in all Chromium builds we hit — gzip is universally available.
# Output:
#   wasm/online-build/dicts/<lang>.tar.gz       per-language gzip bundle
#   wasm/online-build/dicts/manifest.json       index of what's available
#
# Usage:
#   bash wasm/build-dicts.sh                      # default language set
#   bash wasm/build-dicts.sh en de fr             # explicit set
#
# Notes:
#   - Uses curl + GitHub's content API. No auth required for public repo,
#     but rate-limited (60 req/hr unanon). Skip a language's download if
#     its directory already exists locally (--force to re-fetch).
#   - `jq` preferred; falls back to python3 if jq is missing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_API='https://api.github.com/repos/LibreOffice/dictionaries/contents'
RAW_BASE='https://raw.githubusercontent.com/LibreOffice/dictionaries/master'
OUT_DIR="$SCRIPT_DIR/online-build/dicts"
FETCH_DIR="$SCRIPT_DIR/online-build/dicts-src"

# Default set: EVERY spell dictionary LibreOffice/dictionaries ships, so any
# document language a user opens can be loaded on demand (the editor fetches a
# language's bundle lazily — see wasm/docs/DICTIONARIES.md). Directory names are the
# upstream repo names (run `bash wasm/build-dicts.sh --list` to refresh this).
# build-dicts.sh auto-skips any dir without hunspell .dic/.aff files (some are
# hyphenation/thesaurus-only or complex-script), so they drop out cleanly.
# Bundles are lazy-loaded, so the on-server total size is not a client cost.
DEFAULT_LANGS=(
    af_ZA an_ES ar as_IN be_BY bg_BG bn_BD bo br_FR bs_BA
    ca ckb cs_CZ da_DK de el_GR en eo es et_EE
    fa_IR fr_FR gd_GB gl gu_IN gug he_IL hi_IN hr_HR hu_HU
    id is it_IT kmr_Latn kn_IN ko_KR lo_LA lt_LT lv_LV mn_MN
    mr_IN ne_NP nl_NL no oc_FR or_IN pa_IN pl_PL pt_BR pt_PT
    ro ru_RU sa_IN si_LK sk_SK sl_SI sq_AL sr sv_SE sw_TZ
    ta_IN te_IN th_TH tr_TR uk_UA vi zu_ZA
)

FORCE_REFETCH=false
LIST_ONLY=false
args=()
for arg in "$@"; do
    case "$arg" in
        --force)   FORCE_REFETCH=true ;;
        --list)    LIST_ONLY=true ;;
        --help|-h)
            sed -n '2,35p' "$0"; exit 0 ;;
        *) args+=("$arg") ;;
    esac
done
if (( ${#args[@]} )); then
    LANGS=("${args[@]}")
else
    LANGS=("${DEFAULT_LANGS[@]}")
fi

have() { command -v "$1" >/dev/null 2>&1; }

# GitHub API auth: unauthenticated is 60 req/hr (the script makes one
# directory listing per language + a few file downloads, the latter via
# raw.githubusercontent which is uncounted). A fresh CI runner without
# the dicts-src cache populated hits ~25 API calls — usually fits in
# 60/hr, but a same-runner re-build in the same hour can exhaust the
# quota and break the build with `WARN: $lang not found upstream`. The
# WARN path is fatal-ish: that language silently drops from the deploy
# manifest, and the regression test for dict coverage then fails.
#
# Authenticated is 5000 req/hr. Honour GH_TOKEN or GITHUB_TOKEN if set
# (CI sets one of these from `secrets.GITHUB_TOKEN`); fall back to
# unauthenticated for local runs.
CURL_AUTH_HEADERS=()
GH_AUTH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [[ -n "$GH_AUTH_TOKEN" ]]; then
    CURL_AUTH_HEADERS=(-H "Authorization: Bearer $GH_AUTH_TOKEN")
    echo "  (using authenticated GitHub API — 5000 req/hr)"
fi

# Parse GitHub-API JSON response → names. Prefer jq, fall back to python3.
api_names() {
    if have jq; then
        jq -r '.[] | select(.type=="file") | .name'
    else
        python3 -c 'import json,sys; [print(f["name"]) for f in json.load(sys.stdin) if f["type"]=="file"]'
    fi
}

if $LIST_ONLY; then
    echo "Available top-level language directories in LibreOffice/dictionaries:"
    curl -sL --fail -m 30 "${CURL_AUTH_HEADERS[@]}" "$REPO_API/" | \
        (have jq && jq -r '.[] | select(.type=="dir") | .name' \
                || python3 -c 'import json,sys; [print(d["name"]) for d in json.load(sys.stdin) if d["type"]=="dir"]') \
        | column
    exit 0
fi

mkdir -p "$OUT_DIR" "$FETCH_DIR"

# ── Per-language fetch + pack ────────────────────────────────────────
MANIFEST_TMP="$(mktemp)"
trap 'rm -f "$MANIFEST_TMP"' EXIT
echo '[' > "$MANIFEST_TMP"
first=true

for lang in "${LANGS[@]}"; do
    echo
    echo "=== $lang ==="
    src_dir="$FETCH_DIR/$lang"
    out_file="$OUT_DIR/$lang.tar.gz"

    if $FORCE_REFETCH; then rm -rf "$src_dir"; fi

    # Re-fetch a cached dir that has no .dic — it's stale/empty (e.g. built
    # by a pre-2026-07-11 version before the nested-subdir sweep below, which
    # shipped fr_FR with zero hunspell data → French spellcheck dead).
    if [[ -d "$src_dir" ]] && ! ls "$src_dir"/*.dic >/dev/null 2>&1; then
        echo "  Cached $src_dir has no .dic (stale/empty) — re-fetching"
        rm -rf "$src_dir"
    fi

    if [[ ! -d "$src_dir" ]]; then
        mkdir -p "$src_dir"
        echo "  Listing upstream…"
        api_json="$(curl -sL --fail -m 30 "${CURL_AUTH_HEADERS[@]}" "$REPO_API/$lang")" || {
            echo "  WARN: $lang not found upstream, skipping"
            rm -rf "$src_dir"
            continue
        }
        # Select the top-level files we care about.
        names="$(echo "$api_json" | api_names \
            | grep -E '\.(dic|aff|xcu|xml)$' \
            | grep -v -E '^(description-|changelog|README|affDescription)' \
            || true)"
        for name in $names; do
            echo "    fetch $name"
            curl -sL --fail -m 60 "$RAW_BASE/$lang/$name" -o "$src_dir/$name" || {
                echo "    FAIL $name — removing and skipping lang"
                rm -rf "$src_dir"
                continue 2
            }
        done
        # Nested-subdir sweep. Some languages (e.g. fr_FR) keep their
        # .dic/.aff under <lang>/dictionaries/ rather than at the top level,
        # with dictionaries.xcu referencing them as %origin%/<file> (package
        # root). The top-level listing misses them, so the bundle shipped
        # with only the .xcu → empty-of-data (French spellcheck broken until
        # 2026-07-11). Sweep immediate subdirs for spell .dic/.aff and fetch
        # them FLAT into src_dir — matches %origin% + the de/en layout, and
        # dict-loader keys on basename regardless of tar path.
        subdirs="$(echo "$api_json" | { have jq \
            && jq -r '.[] | select(.type=="dir") | .name' \
            || python3 -c 'import json,sys; [print(d["name"]) for d in json.load(sys.stdin) if d["type"]=="dir"]'; } || true)"
        for sub in $subdirs; do
            case "$sub" in META-INF|ui|pythonpath|.github|images) continue ;; esac
            sub_json="$(curl -sL --fail -m 30 "${CURL_AUTH_HEADERS[@]}" "$REPO_API/$lang/$sub" 2>/dev/null)" || continue
            sub_names="$(echo "$sub_json" | api_names | grep -E '\.(dic|aff)$' || true)"
            for name in $sub_names; do
                [[ -e "$src_dir/$name" ]] && continue   # top-level copy wins
                echo "    fetch $sub/$name (nested → flat)"
                curl -sL --fail -m 60 "$RAW_BASE/$lang/$sub/$name" -o "$src_dir/$name" || true
            done
        done
        # META-INF/manifest.xml is optional but harmless.
        curl -sL --fail -m 30 "$RAW_BASE/$lang/META-INF/manifest.xml" \
            -o "$src_dir/manifest.xml" 2>/dev/null && \
            { mkdir -p "$src_dir/META-INF"; mv "$src_dir/manifest.xml" "$src_dir/META-INF/"; } || true
    else
        echo "  Using cached $src_dir"
    fi

    # Never ship an empty-of-data bundle: a spell dictionary REQUIRES a .dic.
    # (Applies to fresh + cached dirs.) A language with none after the
    # top-level + nested sweep is non-hunspell or moved upstream — skip it
    # rather than manifest a data-less bundle.
    if ! ls "$src_dir"/*.dic >/dev/null 2>&1; then
        echo "  WARN: no .dic in $lang after top-level + nested sweep — skipping (won't ship empty)"
        rm -rf "$src_dir"
        continue
    fi

    # Derive supported locales from dictionaries.xcu (first 3 Locales nodes).
    locales="$(grep -oP 'oor:name="Locales"[^<]*<value>\K[^<]+' "$src_dir/dictionaries.xcu" 2>/dev/null \
               | tr '\n' ' ' | tr -s ' ' || true)"

    # Pack + gzip.
    tar -C "$src_dir" -czf "$out_file" .
    sha256="$(sha256sum "$out_file" | cut -d' ' -f1)"
    size_gz="$(stat -c '%s' "$out_file")"

    # Append to manifest.
    $first || echo ',' >> "$MANIFEST_TMP"
    first=false
    cat >> "$MANIFEST_TMP" <<EOF
  { "lang": "$lang",
    "file": "$lang.tar.gz",
    "locales": "$(echo "$locales" | sed 's/"/\\"/g')",
    "size": $size_gz,
    "sha256": "$sha256" }
EOF

    printf '  %-7s  %7sB  %s\n' \
        "$lang" "$(numfmt --to=iec --suffix= "$size_gz")" "$sha256"
done

# ── Robust manifest: derive it from the ACTUAL packed bundles in OUT_DIR, not
# just the languages processed THIS run. A partial run — a subset LANGS, a
# GitHub API rate-limit, or a one-off manual build — otherwise emits a manifest
# missing languages whose valid *.tar.gz are already present from a prior run.
# dict-loader reads only the manifest, so those languages silently vanish: the
# 2026-07-11 "manual-frdict" editor shipped a 2-entry manifest (fr_FR, de)
# despite 66 packed bundles, which disabled English spellcheck end-to-end. Each
# bundle is re-validated (must contain a .dic); empties are dropped. ──
: > "$MANIFEST_TMP"; echo '[' > "$MANIFEST_TMP"; mf_first=true
for tgz in "$OUT_DIR"/*.tar.gz; do
    [[ -e "$tgz" ]] || continue
    l="$(basename "$tgz" .tar.gz)"
    # Detect a .dic from a CAPTURED listing, not `tar … | grep -q`: under the
    # `set -o pipefail` in force here, `grep -q` exits on the first match and
    # closes the pipe, so `tar` dies with SIGPIPE and the pipeline returns
    # non-zero — which `if !` then reads as "no .dic", spuriously dropping any
    # bundle whose first .dic sorts EARLY in the archive (e.g. fr_FR lists
    # ./hyph_fr.dic third). Capturing lets tar finish before grep runs.
    if ! grep -q '\.dic$' <<<"$(tar -tzf "$tgz" 2>/dev/null || true)"; then
        echo "  drop bundle with no .dic: $l"; rm -f "$tgz"; continue
    fi
    sz="$(stat -c '%s' "$tgz")"; sh="$(sha256sum "$tgz" | cut -d' ' -f1)"
    # Locales come from the bundled dictionaries.xcu (best-effort; unused by the
    # dict-loader critical path, which keys on lang).
    loc="$(tar -xzOf "$tgz" ./dictionaries.xcu 2>/dev/null || tar -xzOf "$tgz" dictionaries.xcu 2>/dev/null || true)"
    loc="$(printf '%s' "$loc" | grep -oP 'oor:name="Locales"[^<]*<value>\K[^<]+' | tr '\n' ' ' | tr -s ' ' || true)"
    $mf_first || echo ',' >> "$MANIFEST_TMP"; mf_first=false
    cat >> "$MANIFEST_TMP" <<EOF
  { "lang": "$l",
    "file": "$l.tar.gz",
    "locales": "$(echo "$loc" | sed 's/"/\\"/g')",
    "size": $sz,
    "sha256": "$sh" }
EOF
done
echo >> "$MANIFEST_TMP"
echo ']' >> "$MANIFEST_TMP"
mv "$MANIFEST_TMP" "$OUT_DIR/manifest.json"
trap - EXIT
echo "  manifest: $(grep -c '"lang"' "$OUT_DIR/manifest.json") bundles"

# Regression guard for the nested-subdir bug (2026-07-11): fr_FR nests its
# .dic/.aff under fr_FR/dictionaries/. If the nested sweep above ever
# regresses, French silently ships an empty bundle again. Fail loudly when
# fr_FR was requested + we reached this point online but produced no bundle.
if printf '%s\n' "${LANGS[@]}" | grep -qx fr_FR && [[ ! -f "$OUT_DIR/fr_FR.tar.gz" ]]; then
    echo "ERROR: fr_FR was requested but produced no bundle — the nested-dictionaries" >&2
    echo "       sweep regressed (French .dic/.aff live under fr_FR/dictionaries/)." >&2
    exit 1
fi

echo
echo "=== Done ==="
echo "Output: $OUT_DIR"
ls -la "$OUT_DIR" | tail -n +2 | awk '{printf "  %-20s %10s\n", $NF, $5}'
