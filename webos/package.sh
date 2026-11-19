#!/usr/bin/env bash
# Builds the LG webOS launcher app (.ipk) that opens FreeStream on this Mac.
#   ./package.sh                          -> uses this Mac's Wi-Fi IP and port 8080
#   ./package.sh http://192.168.1.20:8080 -> uses the given address
set -euo pipefail
cd "$(dirname "$0")"

URL="${1:-}"
if [ -z "$URL" ]; then
  IP="$(ipconfig getifaddr en0 || true)"
  [ -n "$IP" ] || { echo "Could not detect this Mac's Wi-Fi IP. Pass the URL: ./package.sh http://<ip>:8080"; exit 1; }
  PORT="$(grep -E '^PORT=' ../.env 2>/dev/null | cut -d= -f2 || true)"
  URL="http://$IP:${PORT:-8080}"
fi

echo "window.FREESTREAM_URL = '$URL';" > app/config.js
mkdir -p dist
npx --yes -p @webos-tools/cli@3.2.6 ares-package app -o dist >/dev/null
echo "Built $(ls -t dist/*.ipk | head -1) -> opens $URL"
