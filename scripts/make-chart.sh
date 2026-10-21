#!/usr/bin/env bash
# Renders the post's figures to PNG at 2x with headless Chrome, served over a
# throwaway local server the same way as make-cover.sh:
#   docs/media/model-compare.html -> model-compare.png (numbers read from eval/results)
#   docs/media/tinker-run.html    -> tinker-run.png (the Tinker run's real output)
set -euo pipefail
cd "$(dirname "$0")/.."
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
port=47812
python3 -m http.server "$port" --bind 127.0.0.1 >/dev/null 2>&1 &
server=$!
trap 'kill $server' EXIT
sleep 1
shoot() {
  local name=$1 size=$2 profile
  profile="$(mktemp -d)"
  "$chrome" --headless=new --disable-gpu --hide-scrollbars \
    --window-size="$size" --force-device-scale-factor=2 --virtual-time-budget=4000 --user-data-dir="$profile" \
    --screenshot="docs/media/$name.png" "http://127.0.0.1:$port/docs/media/$name.html" 2>/dev/null
  rm -rf "$profile"
}
shoot model-compare 1000,480
shoot tinker-run 1040,450
