#!/usr/bin/env bash
# gc-old-deploys.sh — prune old per-deploy editor folders.
#
# Each editor build deploys into <DIR>/<YYYY-MM-DD-HHMMSS>/ and folders
# accumulate forever (the design choice — see project_iter51_session.md
# memory). With ~200MB per deploy on a 10GB plan-shared SMB volume, the
# disk fills after ~50 deploys. This script is the operator's escape
# hatch when that limit is approached.
#
# Two modes:
#   - Local: just point at the local PUB. The editor-static-server's
#     pointer file ($PUB/current-deploy.txt) and any /<id>/ URLs that
#     in-flight viewer tabs still hold are SACRED — this script refuses
#     to delete the folder currently named in current-deploy.txt.
#   - Azure: invoke via `az webapp ssh` against the editor App Service,
#     pointing at /home/site/wwwroot. Same protection rules apply.
#
# Usage:
#   bash wasm/gc-old-deploys.sh <DIR> <KEEP_N> [--dry-run]
#
# Example (local CI host):
#   bash wasm/gc-old-deploys.sh /tmp/static-deploy/public 20
#
# Example (Azure):
#   az webapp ssh --resource-group <rg> --name <editor-app> \
#       --command "bash /home/site/wwwroot/gc-old-deploys.sh \
#                       /home/site/wwwroot 20"
#
# Or copy the script into the deploy and run from the SSH shell.

set -euo pipefail

DIR="${1:-}"
KEEP_N="${2:-}"
DRY_RUN=false
for arg in "${@:3}"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
        *) echo "Unknown flag: $arg" >&2; exit 2 ;;
    esac
done

if [[ -z "$DIR" || -z "$KEEP_N" ]]; then
    sed -n '2,30p' "$0"
    exit 2
fi
if [[ ! -d "$DIR" ]]; then
    echo "ERROR: $DIR is not a directory" >&2
    exit 1
fi
if ! [[ "$KEEP_N" =~ ^[0-9]+$ ]] || (( KEEP_N < 1 )); then
    echo "ERROR: KEEP_N must be a positive integer (got: $KEEP_N)" >&2
    exit 2
fi

# Find per-deploy folders (timestamp shape, never anything else).
mapfile -t ALL < <(
    find "$DIR" -mindepth 1 -maxdepth 1 -type d \
        -regextype posix-extended \
        -regex '.*/[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}$' \
        | sort
)

if (( ${#ALL[@]} == 0 )); then
    echo "No per-deploy folders found under $DIR."
    exit 0
fi

# The current pointer (if any) is never a deletion candidate. The
# editor-server's middleware routes legacy unprefixed URLs through it;
# wiping it mid-session would break every flat-URL fetch in flight.
CURRENT=""
if [[ -f "$DIR/current-deploy.txt" ]]; then
    CURRENT="$(tr -d '[:space:]' < "$DIR/current-deploy.txt")"
fi

# Folders to keep: the last KEEP_N by name (timestamp sort = chronological)
# PLUS the current pointer (even if it would otherwise fall out of the window).
KEEP_SET=()
for ((i = ${#ALL[@]} - KEEP_N; i < ${#ALL[@]}; i++)); do
    if (( i >= 0 )); then KEEP_SET+=("$(basename "${ALL[$i]}")"); fi
done
if [[ -n "$CURRENT" ]] && [[ ! " ${KEEP_SET[*]} " =~ " $CURRENT " ]]; then
    KEEP_SET+=("$CURRENT")
fi

echo "Found ${#ALL[@]} per-deploy folder(s); keeping ${#KEEP_SET[@]}."
echo "Keep:"
printf '  %s\n' "${KEEP_SET[@]}" | sort
echo

DELETED=0
TOTAL_FREED=0
for full in "${ALL[@]}"; do
    name="$(basename "$full")"
    if [[ " ${KEEP_SET[*]} " =~ " $name " ]]; then
        continue
    fi
    size_bytes="$(du -sb "$full" 2>/dev/null | cut -f1 || echo 0)"
    size_human="$(du -sh "$full" 2>/dev/null | cut -f1 || echo '?')"
    if $DRY_RUN; then
        printf '  [dry-run] would delete %s (%s)\n' "$name" "$size_human"
    else
        printf '  deleting %s (%s)... ' "$name" "$size_human"
        rm -rf "$full"
        printf 'done\n'
    fi
    DELETED=$((DELETED + 1))
    TOTAL_FREED=$((TOTAL_FREED + size_bytes))
done

if (( DELETED == 0 )); then
    echo "Nothing to delete."
else
    freed_human="$(numfmt --to=iec --suffix=B "$TOTAL_FREED" 2>/dev/null || echo "$TOTAL_FREED bytes")"
    if $DRY_RUN; then
        echo "Would delete $DELETED folder(s), freeing $freed_human."
    else
        echo "Deleted $DELETED folder(s), freed $freed_human."
    fi
fi
