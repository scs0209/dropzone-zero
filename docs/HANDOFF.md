# Hand-over (2026-10-20)

Where Dropzone Zero stands, for picking the work up on another machine.
Deadline for the DEV post: 2026-10-25 23:59 PDT (2026-10-26 15:59 KST).

## Set up a new machine

```bash
pnpm install
ollama pull gemma4:e4b
pnpm seed                      # demo/ is not in git
cp .env.example .env           # then fill in keys by hand; .env is never committed
pnpm test                      # daemon tests bind a local port
```

- `ml/.venv` (TabPFN, Tinker) is created on first use with `uv`; it is about 1 GB.
- Zee must be rebuilt on each machine (`pnpm app:build`): `services.rs` finds the
  checkout through the path it was built from.
- `dz autostart` writes a LaunchAgent for this machine only; run it again there.
- Media: `pnpm media:cover`, `pnpm media:demo` (needs vhs and ffmpeg), `pnpm media:zee`
  (needs Google Chrome). All use synthetic files only.

## Done

Everything in the README, plus: Sentry `gen_ai.chat` spans (checked with a real DSN),
the Tinker control experiment (`ml/finetune.py`, `dz eval --provider replay`),
the post draft `docs/dev-post.md`, cover and both GIFs in `docs/media/`.
Backboard, Auth0, and Render were dropped.

## Open

- **Zee resize shake fix (e1692ee):** compiles, but not yet tried in a rebuilt Zee.app.
- **Post TODOs:** a Sentry trace screenshot (needs a Sentry login) and the agent
  session link (DevRelay or Entire; choose which sessions may be public).
- **Numbers to reconcile:** the README says 75% of a real folder went to "other"
  before the new categories; the work notes say 39 of 55 files (about 71%).
  The post uses 39/55 -> 8/55.
- **`pnpm media:zee`:** clicking an answer in headless Chrome stalls its renderer,
  so the GIF ends on Zee's question. Cause not found; not seen in the app.
- Not done: ElevenLabs, .ics follow-up, .tech domain.

## Conventions

- Everything in the repo is in English. Commits are Conventional Commits ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commit and push as the personal account scs0209 only.
- Real files never leave the machine; cloud services get synthetic data or counts.
  Never delete files; duplicates and temp files go to quarantine.
