# Commands and everyday use

[← Back to the README](../../README.md)

## Commands

| Command | What it does |
|---|---|
| `dz tidy [folder]` | The whole routine in one go: analyze, plan, ask you about each review item, confirm, then move (a Mastra workflow) |
| `dz scan [folder]` | Lists files with size, age, hash, and flags (partial download, empty, duplicate) |
| `dz preview [folder]` | Plans a new name and folder for every file with the local model and saves the plan. Nothing moves |
| `dz run [folder]` | Carries out the saved plan after you confirm, verifying each file by hash before and after it moves |
| `dz undo [folder]` | Reverses the most recent run: files go back to their old names and places, and folders the run created are removed if empty |
| `dz undo [folder] --file <name>` | Moves single files from the last run back (by old name, new name, or new path) and teaches the review gate that this move was wrong |
| `dz worker` | Runs a Temporal worker that finishes any `--temporal` run or undo that was interrupted |
| `dz watch [folder] [--auto]` | Keeps planning as files arrive. With `--auto`, allowed moves run on their own; review and blocked items still wait |
| `dz daemon [folder]` | The watcher plus a local API (127.0.0.1, token-protected) for the Zee desktop app |
| `dz autostart enable [folder]` | Starts Dropzone Zero at every login (macOS LaunchAgent): Zee, which runs the rest, if built; otherwise the daemon. `disable` removes it, `status` shows what is running |
| `dz recent [folder] [--reveal]` | Lists what moved where, newest first; `--reveal` opens the latest file (or `--file <name>`) in Finder |
| `dz status [folder]` | Shows where every file stands: planned, needs review, approved, blocked, executing, verified, failed, or restored |
| `dz approve [folder] --file <name>` | Releases an item the guard holds for review, for exactly the move shown (`--all` releases every review item) |
| `dz find "<description>" [folder]` | Finds files by describing them, images included (`--reveal` opens the best match in Finder); `dz index` refreshes the search index |
| `dz receipts [folder]` | Reads every receipt and invoice and writes date, vendor, total, currency, and document number to a CSV |
| `dz eval [--split test]` | Scores the classifier on the synthetic labeled set in `eval/cases.jsonl` (see [Measuring the classifier](how-it-works.md#measuring-the-classifier)) |

`scan` and `preview` take `--json` for machine-readable output; `run` and `undo` take `--yes` to skip the confirmation, and `--temporal` to run as a durable workflow (below). `dz preview --summary` prints only counts and timings, with no file names, so you can share how it did on a real folder without sharing what is in it. The folder defaults to `DZ_INBOX`, then `~/Downloads`.

Dropzone Zero keeps its state in a hidden `.dropzone` folder inside the folder it organizes: the saved plan, the journal (`journal.jsonl`), and `quarantine/`. Quarantine is never emptied for you.

## One command: `dz tidy`, a Mastra workflow

`dz tidy` runs analyze → plan → approve → move as a [Mastra](https://mastra.ai) workflow. The approve step suspends the run: you see the plan table, answer y or n for each item the guard holds for review, and confirm; the workflow then resumes with your answers and moves only what is allowed or approved.

```text
2 items need your decision:
  Move Notely-4.2.1.dmg -> Installers/notely-4-2-1-installer.dmg? (Program or installer) [y/N] y
  Move SlothPlayer-setup.pkg -> Installers/slothplayer-setup-package.pkg? (Program or installer) [y/N] n

Move 29 files now? [y/N] y
Run 20261020T023758879Z: moved 29 files, every one verified by SHA-256. `dz undo` puts them back.
```

Mastra orchestrates the steps; it never gets a say in what may happen to a file. Each step calls Dropzone Zero's own functions, no step hands the model a tool, and approving can only release review items: blocked items stay blocked because the executor judges every item again. Mastra's own usage telemetry (which reports to PostHog by default) is switched off before Mastra loads, the version is pinned, and the install was checked against the June 2026 `@mastra` npm compromise (pnpm 10 does not run dependency install scripts, which is how that attack spread).

## Watching the folder

`dz watch` plans again whenever the folder changes, so a new download is classified seconds after it lands. It uses Node's built-in `fs.watch`, waits for a burst of events to settle, and leaves a file alone until it has stopped changing for five seconds, so half-written downloads are never planned. Each file is shown to the model once; later passes reuse the answer by content hash.

```bash
pnpm dz watch ~/Downloads --auto
# 12:49:27  nothing new; 30 files that were already here are left alone (`dz tidy` sorts them)
# 12:49:37  waiting for 1 file to finish writing; 30 files that were already here are left alone
# 12:49:46  1 planned (1 new to the model): 1 allowed, 0 review, 0 blocked
# 12:49:46  moved 1 file (run 20261020T034946551Z); `dz undo` reverses it
```

That run is a Chrome-style download (a `.crdownload` file renamed when finished) of a photographed receipt landing in a folder that already held 30 files: eleven seconds after the download completed, it was in `Finance/Receipts/2026-10/2026-10-11-juniper-market-purchase-receipt.jpg`.

With `--auto`, only files that arrive after watching starts are moved. Files are known by name, so a file you edit in place (an export you are working on, a receipt that undo put back) stays the same file and is never filed because you saved it; one that leaves the folder and comes back is a new download. Files that were already in the folder are not even sent to the model, so a cluttered Downloads folder never makes a new download wait; sort the backlog with `dz tidy` whenever you like, or pass `--include-existing` to let watch handle it too.

Watch mode does not loosen anything. Without `--auto` it only plans. With it, only `ALLOW` items move on their own; `BLOCK` items never move; and anything that needs a person, a `REVIEW` item or a batch of new files larger than the bulk limit, is asked about right in the watch terminal, once:

```text
13:01:55  1 planned (1 new to the model): 0 allowed, 1 review, 0 blocked
13:01:55  not running: 1 waiting for review
  Move SlothPlayer-2.0.pkg -> Installers/slothplayer-2-0-installer.pkg? (Program or installer) [y/N] y
13:02:00  moved 1 file (run 20261020T040200483Z); `dz undo` reverses it
```

The watcher keeps handling new files while a question is open. On macOS a desktop notification says where a download was filed (`IMG_5120.jpg → Finance/Receipts/2026-10`) or that a decision is waiting, so you do not have to keep an eye on the terminal (`DZ_NOTIFY=off` silences them; they are shown locally and sent nowhere). Without a terminal to ask in, `dz approve` and `dz run` from another shell do the same job. To find a file later, `dz recent` lists every move from the journal, and `dz recent --reveal` opens Finder with the latest one selected:

```bash
pnpm dz recent ~/Downloads --limit 3
# 10/20/2026, 1:20:41 PM  IMG_5120.jpg  ->  Finance/Receipts/2026-10/2026-10-11-juniper-market-purchase-receipt.jpg
pnpm dz recent ~/Downloads --reveal
```

### Start at login

```bash
pnpm dz autostart enable ~/Downloads   # starts now and at every login
pnpm dz autostart status
pnpm dz autostart disable              # stops it and removes it from login
```

This writes a standard per-user LaunchAgent (`~/Library/LaunchAgents/dev.dropzone-zero.watch.plist`), loads it with `launchctl`, and logs to `~/Library/Logs/dropzone-zero/watch.log`. If Ollama is not up yet at login, the watcher waits for it. In the background there is no terminal to ask in, so decisions arrive as notifications and are answered with `dz status`, `dz approve`, or `dz run`. macOS may ask whether node may access your Downloads folder; the watcher needs that permission to read it.

Only one watcher runs per folder: `dz watch` and `dz daemon` take a lock in `.dropzone/watch.lock`, and a second one refuses to start and names the one already running (two watchers would race for the same download). While it runs, watch owns the saved plan, so use `dz tidy` for the backlog before or after a watch session rather than during it.

## Durable runs with Temporal

A few hundred renames finish in seconds, but a laptop can still sleep, crash, or lose power halfway. With `--temporal`, a run or an undo becomes a [Temporal](https://temporal.io) workflow: every file is one activity, and the Temporal server remembers which ones finished. If the process dies, `dz worker` continues with the next file instead of starting over.

```bash
brew install temporal
temporal server start-dev          # local server, web UI at http://localhost:8233
pnpm dz run demo/inbox --temporal
```

Each step is safe to repeat, which is what makes retries safe: a move whose file is already at its target with the right hash counts as done, and so does a restore whose file is already back. To see it work, slow the steps down, kill the run, and let a worker finish it:

```bash
DZ_STEP_DELAY_MS=300 pnpm dz run demo/inbox --yes --temporal   # press Ctrl+C after a few seconds
pnpm dz worker                                                 # picks up the open workflow and finishes it
```

In testing, a run killed after 15 of 30 files was finished by `dz worker` with 30 moved and 0 failed, and `dz undo` then restored all 32 demo files byte for byte. Workflow history holds file names, targets, and hashes, so point `TEMPORAL_ADDRESS` only at a server you run yourself, such as the local dev server above.
