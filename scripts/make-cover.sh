#!/usr/bin/env bash
# Renders docs/media/cover.html (the real Zee robot plus the title) to
# docs/media/cover.png at 2x with headless Chrome. ES modules need http, so a
# throwaway local server serves the repo on 127.0.0.1 while Chrome takes the shot.
set -euo pipefail
cd "$(dirname "$0")/.."
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
port=47811
python3 -m http.server "$port" --bind 127.0.0.1 >/dev/null 2>&1 &
server=$!
trap 'kill $server' EXIT
sleep 1
profile="$(mktemp -d)"
"$chrome" --headless=new --disable-gpu --use-angle=swiftshader --enable-unsafe-swiftshader --hide-scrollbars \
  --window-size=1000,420 --force-device-scale-factor=2 --virtual-time-budget=4000 --user-data-dir="$profile" \
  --screenshot=docs/media/cover.png "http://127.0.0.1:$port/docs/media/cover.html" 2>/dev/null
rm -rf "$profile"
