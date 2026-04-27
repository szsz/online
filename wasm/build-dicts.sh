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

# Default set: what we expect most users to need. Pick by file size /
# geography; add/remove here. Directory names are upstream repo names —
# run `bash wasm/build-dicts.sh --list` to see all options.
# Upstream uses locale-coded dirs for most langs (hu_HU, pl_PL, …) and
# bare 2-letter dirs for a handful (en, de, es, …). `--list` shows them.
DEFAULT_LANGS=(
    en de es
    fr_FR it_IT nl_NL pt_BR pt_PT
    hu_HU pl_PL cs_CZ sk_SK ro
    ru_RU tr_TR hr_HR el_GR
    da_DK sv_SE uk_UA
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
    curl -sL --fail -m 30 "$REPO_API/" | \
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

    if [[ ! -d "$src_dir" ]]; then
        mkdir -p "$src_dir"
        echo "  Listing upstream…"
        api_json="$(curl -sL --fail -m 30 "$REPO_API/$lang")" || {
            echo "  WARN: $lang not found upstream, skipping"
            rm -rf "$src_dir"
            continue
        }
        # Select only the files we care about.
        names="$(echo "$api_json" | api_names \
            | grep -E '\.(dic|aff|xcu|xml)$' \
            | grep -v -E '^(description-|changelog|README|affDescription)' \
            || true)"
        if [[ -z "$names" ]]; then
            echo "  WARN: no dict files in $lang (maybe a non-hunspell language?) — skipping"
            rm -rf "$src_dir"
            continue
        fi
        for name in $names; do
            echo "    fetch $name"
            curl -sL --fail -m 60 "$RAW_BASE/$lang/$name" -o "$src_dir/$name" || {
                echo "    FAIL $name — removing and skipping lang"
                rm -rf "$src_dir"
                continue 2
            }
        done
        # META-INF/manifest.xml is optional but harmless.
        curl -sL --fail -m 30 "$RAW_BASE/$lang/META-INF/manifest.xml" \
            -o "$src_dir/manifest.xml" 2>/dev/null && \
            { mkdir -p "$src_dir/META-INF"; mv "$src_dir/manifest.xml" "$src_dir/META-INF/"; } || true
    else
        echo "  Using cached $src_dir"
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

echo >> "$MANIFEST_TMP"
echo ']' >> "$MANIFEST_TMP"
mv "$MANIFEST_TMP" "$OUT_DIR/manifest.json"
trap - EXIT

echo
echo "=== Done ==="
echo "Output: $OUT_DIR"
ls -la "$OUT_DIR" | tail -n +2 | awk '{printf "  %-20s %10s\n", $NF, $5}'
