#!/usr/bin/env bash
# Installs and launches the app on the TV registered with `ares-setup-device` (see README).
set -euo pipefail
cd "$(dirname "$0")"
DEVICE="${1:-tv}"
IPK="$(ls -t dist/*.ipk | head -1)"
npx --yes -p @webos-tools/cli@3.2.6 ares-install -d "$DEVICE" "$IPK"
npx --yes -p @webos-tools/cli@3.2.6 ares-launch -d "$DEVICE" com.freestream.tv
