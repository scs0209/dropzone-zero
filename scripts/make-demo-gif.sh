#!/usr/bin/env bash
# Records docs/media/demo.tape and encodes docs/media/demo.gif. vhs writes text
# and cursor layers as separate PNG frames; ffmpeg overlays them and builds a
# palette so the GIF stays small. Needs vhs, ffmpeg, Ollama with gemma4:e4b, and
# `pnpm seed` first.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf demo/gif-frames
vhs docs/media/demo.tape
frames=demo/gif-frames
ffmpeg -y -v error -framerate 50 -i "$frames/frame-text-%05d.png" -framerate 50 -i "$frames/frame-cursor-%05d.png" \
  -filter_complex "[0][1]overlay,pad=iw+64:ih+48:32:24:color=0xfdf6e3,setpts=PTS/1.5,fps=12,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" \
  docs/media/demo.gif
ls -la docs/media/demo.gif
