# The terminal demo GIF for the DEV post: preview, run, and undo on a small
# synthetic folder. Needs Ollama with gemma4:e4b and `pnpm seed` first.
# Rebuild with: pnpm media:demo

# vhs 0.12 cannot encode with ffmpeg 9, so it writes frames and scripts/make-demo-gif.sh encodes them.
Output demo/gif-frames/

Set Shell "bash"
Set FontSize 14
Set Width 1760
Set Height 720
Set Padding 24
Set Theme "Builtin Solarized Light"
Set TypingSpeed 35ms

# Nine files from the seeded demo folder: receipts, a photo of a receipt, a
# booking, an invite, a duplicate, an installer, a temp file, and a download
# that is still in progress.
Hide
Type `export PS1='$ ' && R=$PWD && dz() { node --import tsx "$R/src/cli.ts" "$@"; } && rm -rf demo/gif && mkdir -p demo/gif/Downloads && cd demo/inbox && cp -p scan0001.pdf IMG_2041.jpg invite.ics booking.pdf Receipt-2026-10-03.pdf 'Receipt-2026-10-03 (1).pdf' Notely-4.2.1.dmg '~$draft.tmp' 'Unconfirmed 48211.crdownload' ../gif/Downloads/ && cd ../gif && clear` Enter
Sleep 1s
Show

Type "ls Downloads" Sleep 300ms Enter
Sleep 2s

Type "dz preview Downloads" Sleep 300ms Enter
Wait+Screen@3m /reverses a run/
Sleep 4s

Type "dz run Downloads" Sleep 300ms Enter
Wait+Screen@30s /\[y\/N\]/
Sleep 1s
Type "y" Sleep 300ms Enter
Wait+Screen@1m /verified by SHA-256/
Sleep 3s

Type "clear && find Downloads -type f ! -name '*.json*' | sort" Sleep 300ms Enter
Sleep 4s

Type "dz undo Downloads --yes" Sleep 300ms Enter
Wait+Screen@1m /restored \d+ files/
Sleep 2s

Type "ls Downloads" Sleep 300ms Enter
Sleep 4s
