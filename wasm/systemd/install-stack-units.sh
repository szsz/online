#!/usr/bin/env bash
# install-stack-units.sh — install + enable the coolwasm on-box stack units
# and cut over from the legacy ad-hoc `sudo … nohup bash launch-*.sh`
# processes to systemd supervision (Restart=always).
#
# Standard way to bring up / recover EITHER on-box stack:
#     sudo bash wasm/systemd/install-stack-units.sh            # dev + ci
#     sudo bash wasm/systemd/install-stack-units.sh dev        # dev only
#     sudo bash wasm/systemd/install-stack-units.sh ci         # ci only
#
# After install, day-to-day control is plain systemd:
#     systemctl status  coolwasm-viewer@online-ci
#     systemctl restart coolwasm-relay@online
#     journalctl -u coolwasm-editor-static@online-ci -f
#
# Idempotent: re-running re-copies the units, reloads, and (re)starts any
# instance that isn't active. Safe to run repeatedly.
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    echo "Run as root (sudo)." >&2; exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEL="${1:-all}"   # all | dev | ci

# Instances: "unit-instance:port" — port is what we free before starting.
DEV_INSTANCES=(
    "coolwasm-sni-router.service:443"
    "coolwasm-relay@online:9091"
    "coolwasm-editor-static@online:6932"
    "coolwasm-viewer@online:6934"
)
CI_INSTANCES=(
    "coolwasm-relay@online-ci:9092"
    "coolwasm-editor-static@online-ci:7932"
    "coolwasm-viewer@online-ci:7934"
)

case "$SEL" in
    all) INSTANCES=("${DEV_INSTANCES[@]}" "${CI_INSTANCES[@]}") ;;
    dev) INSTANCES=("${DEV_INSTANCES[@]}") ;;
    ci)  INSTANCES=("${CI_INSTANCES[@]}") ;;
    *) echo "usage: $0 [all|dev|ci]" >&2; exit 1 ;;
esac

echo "── Installing unit files ──"
mkdir -p /var/log/coolwasm
install -m 0644 "$SCRIPT_DIR"/coolwasm-*.service /etc/systemd/system/
systemctl daemon-reload

# Retire the abandoned single-purpose relay unit if present (superseded by
# coolwasm-relay@online).
if systemctl list-unit-files launch-relay-dev.service >/dev/null 2>&1; then
    echo "── Retiring legacy launch-relay-dev.service ──"
    systemctl disable --now launch-relay-dev.service 2>/dev/null || true
fi

free_port() {
    # Kill whatever ad-hoc (non-systemd) process holds $1, plus its sudo/nohup
    # parent, so the systemd unit can bind. If the port is already served by a
    # systemd unit, leave it (systemctl restart handles that instance).
    local port="$1"
    local pid
    pid="$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
    [[ -z "$pid" ]] && return 0
    # Skip if already under systemd.
    if systemctl status "$pid" >/dev/null 2>&1 && \
       [[ "$(ps -o unit= -p "$pid" 2>/dev/null | tr -d ' ')" == coolwasm-* ]]; then
        return 0
    fi
    echo "    freeing :$port (ad-hoc pid=$pid + parent)"
    local parent; parent="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    kill "$pid" 2>/dev/null || true
    [[ -n "$parent" && "$parent" != "1" ]] && kill "$parent" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8; do ss -ltnH "sport = :$port" 2>/dev/null | grep -q . || return 0; sleep 1; done
}

echo "── Enabling + starting units (cutting over from ad-hoc) ──"
for entry in "${INSTANCES[@]}"; do
    unit="${entry%%:*}"; port="${entry##*:}"
    echo "  $unit  (:$port)"
    free_port "$port"
    systemctl enable "$unit" >/dev/null 2>&1 || true
    systemctl restart "$unit"
done

echo "── Health ──"
sleep 3
for entry in "${INSTANCES[@]}"; do
    unit="${entry%%:*}"; port="${entry##*:}"
    if ss -ltnH "sport = :$port" 2>/dev/null | grep -q .; then
        printf '  %-42s :%s  %s\n' "$unit" "$port" "$(systemctl is-active "$unit")"
    else
        printf '  %-42s :%s  NOT LISTENING (check journalctl -u %s)\n' "$unit" "$port" "$unit"
    fi
done
echo "Done."
