#!/usr/bin/env bash
# Renders docs/media/model-compare.html (numbers read from eval/results) to
# docs/media/model-compare.png at 2x with headless Chrome, served over a
# throwaway local server the same way as make-cover.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
port=47812
python3 -m http.server "$port" --bind 127.0.0.1 >/dev/null 2>&1 &
server=$!
trap 'kill $server' EXIT
sleep 1
profile="$(mktemp -d)"
"$chrome" --headless=new --disable-gpu --hide-scrollbars \
  --window-size=1000,480 --force-device-scale-factor=2 --virtual-time-budget=4000 --user-data-dir="$profile" \
  --screenshot=docs/media/model-compare.png "http://127.0.0.1:$port/docs/media/model-compare.html" 2>/dev/null
rm -rf "$profile"
