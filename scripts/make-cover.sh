#!/usr/bin/env bash
# Renders docs/media/cover.html (the hand-drawn cover) to docs/media/cover.png at
# 2x with headless Chrome. The lettering is Marker Felt, which ships with macOS.
set -euo pipefail
cd "$(dirname "$0")/.."
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
profile="$(mktemp -d)"
"$chrome" --headless=new --disable-gpu --hide-scrollbars --window-size=1000,420 --force-device-scale-factor=2 \
  --user-data-dir="$profile" --screenshot=docs/media/cover.png "file://$PWD/docs/media/cover.html" 2>/dev/null
rm -rf "$profile"
