#!/usr/bin/env python3
# Copyright the Collabora Online contributors.
#
# SPDX-License-Identifier: MPL-2.0
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

import argparse
import json
import os
import sys

# Base path: two levels up from this script
BASE_PATH = os.path.dirname(os.path.dirname(__file__)) + "/"


def readwhole(file_path):
    """Read entire file content as UTF-8."""
    with open(file_path, "r", encoding="utf-8") as f:
        return f.read()


def _short(s, max_len):
    """
    Convert multi-line JSON into a single-line string
    for warnings and truncate if too long.
    """
    s = "\\n".join(s.splitlines())
    return s[:max_len] + "…" if len(s) > max_len else s


def insert(*relfiles):
    """
    Merge one or more JSON translation files into a single object.

    - Later files override earlier ones.
    - Warn only if a key is overwritten with a different value.
    - Output is sorted and pretty-printed for stable diffs.
    """
    if not relfiles:
        raise RuntimeError("insert(): no files specified")

    merged = {}
    seen_in = {}  # Tracks where a key was first introduced

    for rel in relfiles:
        full_path = os.path.join(BASE_PATH, rel)

        raw = readwhole(full_path)
        obj = json.loads(raw)

        if not isinstance(obj, dict):
            raise RuntimeError(f"insert(): {rel} is not a JSON object")

        for k, v in obj.items():
            if k in merged:
                prev = seen_in.get(k, "(unknown)")

                # Compare serialized JSON to detect actual value changes
                old_json = json.dumps(
                    merged[k], ensure_ascii=False, indent=4, sort_keys=True
                )
                new_json = json.dumps(
                    v, ensure_ascii=False, indent=4, sort_keys=True
                )

                if old_json != new_json:
                    old_s = _short(old_json, 140)
                    new_s = _short(new_json, 140)
                    sys.stderr.write(
                        f"insert(): key '{k}' overwritten "
                        f"({prev} -> {rel}): {old_s} -> {new_s}\n"
                    )
            else:
                seen_in[k] = rel

            merged[k] = v

    # Stable output 
    return json.dumps(merged, ensure_ascii=False, indent=4, sort_keys=True)


# Languages that match directly on onlylang (the part of window.LANG
# before any '-' or '_' separator).
SIMPLE_LANGS = [
    "ar", "ca", "cs", "cy", "da", "de", "el", "es", "eu", "fi",
    "fr", "ga", "gl", "he", "hr", "hu", "hy", "id", "is", "it",
    "ja", "kk", "ko", "nl", "pl", "pt", "ro", "ru", "sk", "sl",
    "sq", "sv", "tr", "uk",
]

# Languages that need explicit alias checks on the FULL window.LANG.
ALIASES = {
    "en_GB": ["en-GB", "en_GB"],
    "pt_BR": ["pt-BR", "pt_BR"],
    "zh_CN": ["zh-CN", "zh-Hans-CN", "zh_CN", "zh_Hans_CN"],
    "zh_TW": ["zh-TW", "zh-Hant-TW", "zh_TW", "zh_Hant_TW"],
}


def localizations_for(lang):
    """JSON string of the merged UI/uno/locore localizations for `lang`."""
    lang_hyphen = lang.replace("_", "-")
    return insert(
        f"po/ui-{lang}.po.json",
        f"l10n/uno/{lang_hyphen}.json",
        f"l10n/locore/{lang_hyphen}.json",
    )


def localizations_help_for(lang):
    """JSON string of the merged help localizations for `lang`."""
    return insert(f"po/help-{lang}.po.json")


def emit_combined(out):
    """Emit the legacy combined l10n-all.js — one file with the
    if/else-if chain over window.LANG that picks one of the embedded
    locales and assigns window.LOCALIZATIONS / LOCALIZATIONS_HELP.
    Backward-compatible output of this script's original behavior."""
    out.write("var onlylang = window.LANG;\n")
    out.write("var hyphen = onlylang.indexOf('-');\n")
    out.write("if (hyphen > 0) {\n")
    out.write("    onlylang = onlylang.substring(0, hyphen);\n")
    out.write("}\n")
    out.write("var underscore = onlylang.indexOf('_');\n")
    out.write("if (underscore > 0) {\n")
    out.write("    onlylang = onlylang.substring(0, underscore);\n")
    out.write("}\n\n")
    out.write("if (false) {\n    ;\n}\n")

    for lang in SIMPLE_LANGS:
        out.write(f"else if (onlylang == '{lang}') {{\n")
        out.write(f"    window.LOCALIZATIONS = {localizations_for(lang)};\n")
        out.write(f"    window.LOCALIZATIONS_HELP = {localizations_help_for(lang)};\n")
        out.write("}\n")

    for lang in sorted(ALIASES.keys()):
        cond = " || ".join(
            f"window.LANG == '{alias}'" for alias in ALIASES[lang]
        )
        out.write(f"else if ({cond}) {{\n")
        out.write(f"    window.LOCALIZATIONS = {localizations_for(lang)};\n")
        out.write(f"    window.LOCALIZATIONS_HELP = {localizations_help_for(lang)};\n")
        out.write("}\n")

    out.write("\nelse {\n    window.LOCALIZATIONS = {};\n}\n")


def emit_chunks(chunks_dir):
    """Write one self-contained chunk per locale (l10n-<code>.js) plus a
    manifest (l10n-manifest.json) listing every chunk + its byte size +
    the LANG aliases that should pick it.

    Each chunk is a tiny standalone JS file that, when loaded, sets
    window.LOCALIZATIONS and window.LOCALIZATIONS_HELP to the locale's
    strings. The runtime loader (added in a later iter) picks ONE chunk
    based on window.LANG instead of including all 38 locales in
    bundle.js — which is what the legacy combined output does today.
    English (the source language) gets no chunk; the empty-LOCALIZATIONS
    fallback in the loader is the English path.

    This function is purely additive: chunks land in `chunks_dir`
    alongside whatever the legacy combined output already produces.
    Building the loader / dropping the combined output from bundle.js
    is the next iteration's scope."""
    os.makedirs(chunks_dir, exist_ok=True)
    manifest = {"locales": []}
    total_bytes = 0

    def _write_chunk(lang, lang_aliases):
        lines = []
        lines.append(f"// l10n-{lang}.js — auto-generated by create-l10n-all-js.py")
        lines.append(f"// Aliases that should pick this chunk: {', '.join(lang_aliases)}")
        lines.append(f"window.LOCALIZATIONS = {localizations_for(lang)};")
        lines.append(f"window.LOCALIZATIONS_HELP = {localizations_help_for(lang)};")
        body = "\n".join(lines) + "\n"
        path = os.path.join(chunks_dir, f"l10n-{lang}.js")
        with open(path, "w", encoding="utf-8") as f:
            f.write(body)
        return len(body.encode("utf-8"))

    for lang in SIMPLE_LANGS:
        size = _write_chunk(lang, [lang])
        manifest["locales"].append({
            "code": lang, "match": "primary",
            "aliases": [lang], "file": f"l10n-{lang}.js", "size": size,
        })
        total_bytes += size

    for lang in sorted(ALIASES.keys()):
        size = _write_chunk(lang, ALIASES[lang])
        manifest["locales"].append({
            "code": lang, "match": "alias",
            "aliases": ALIASES[lang], "file": f"l10n-{lang}.js", "size": size,
        })
        total_bytes += size

    manifest["total_bytes"] = total_bytes
    with open(os.path.join(chunks_dir, "l10n-manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")
    sys.stderr.write(
        f"emit_chunks: wrote {len(manifest['locales'])} chunks "
        f"({total_bytes:,} bytes) to {chunks_dir}\n"
    )


# ─────────────────────────────────────────────────────────────────
# CLI: backward-compat default (combined output to stdout) +
# optional --chunks-dir for per-locale chunks (additive).
# ─────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--chunks-dir", metavar="DIR",
        help="In addition to writing the combined output to stdout, "
             "emit one self-contained l10n-<code>.js chunk per locale "
             "into DIR plus a l10n-manifest.json. Used by the lazy-load "
             "build path (see iter 8). Without this flag, behavior is "
             "identical to the original script: combined output to stdout.",
    )
    ap.add_argument(
        "--no-combined", action="store_true",
        help="Skip the combined stdout output (useful when the build "
             "rule that captures stdout is being phased out and only "
             "chunks are wanted).",
    )
    args = ap.parse_args()

    if not args.no_combined:
        emit_combined(sys.stdout)

    if args.chunks_dir:
        emit_chunks(args.chunks_dir)


if __name__ == "__main__":
    main()
