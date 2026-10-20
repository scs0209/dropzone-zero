# Dropzone Zero

A local agent that keeps your Downloads folder tidy, and can put everything back with one command.

Receipts, booking confirmations, photos, manuals, and half-finished downloads pile up because opening, renaming, and moving each file by hand is tedious. Dropzone Zero reads each file with a local open-weight model, plans where it belongs, shows you the plan, and only then moves it. Every move is journaled with before and after paths and SHA-256 hashes, so a single `dz undo` restores the folder exactly.

> Status: early development for the [Hacktoberfest 2026 DEV Challenge](https://dev.to/challenges/hacktoberfest-week3-2026-10-19) (Week 3, "Slow and Steady").

## Principles

- **Your files stay on your machine.** Classification runs on a local model. Cloud services only ever see the synthetic demo files or aggregate counts.
- **Nothing is deleted.** Duplicates and stale temp files go to a quarantine folder you can empty yourself.
- **Every action is reversible and verified.** A file only moves if it still has the SHA-256 hash it had when you previewed it, and it is hashed again at its new place. Every step is written to a journal before and after it happens.
- **Preview before acting.** Bulk changes wait for your approval.

## Quick start

Requires Node.js 22.9 or newer, [pnpm](https://pnpm.io), and [Ollama](https://ollama.com) for the local model. The optional review gate also needs [uv](https://docs.astral.sh/uv/).

```bash
pnpm install
ollama pull gemma4:e4b  # about 6.6 GB, once
ollama serve            # skip if the Ollama app is already running
pnpm seed               # creates demo/inbox with 31 synthetic files
pnpm seed:history       # optional: synthetic past decisions for the review gate
pnpm dz preview demo/inbox
pnpm dz run demo/inbox      # asks before moving anything
pnpm dz undo demo/inbox     # puts every file back
```

On an Apple Silicon laptop the 31-file demo preview takes about 70 to 100 seconds with `gemma4:e4b`, most of it spent looking at images. On a real Downloads folder with larger PDFs and photos, expect about 5 seconds per file. Gemma 4 thinks before answering by default; Dropzone Zero turns that off, because for one-file classification it was about 15 times slower with no better answers.

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
| `dz autostart enable [folder]` | Starts `dz watch --auto` at every login (macOS LaunchAgent); `disable` removes it, `status` shows whether it is running |
| `dz recent [folder] [--reveal]` | Lists what moved where, newest first; `--reveal` opens the latest file (or `--file <name>`) in Finder |
| `dz status [folder]` | Shows where every file stands: planned, needs review, approved, blocked, executing, verified, failed, or restored |
| `dz approve [folder] --file <name>` | Releases an item the guard holds for review, for exactly the move shown (`--all` releases every review item) |
| `dz receipts [folder]` | Reads every receipt and invoice and writes date, vendor, total, currency, and document number to a CSV |

`scan` and `preview` take `--json` for machine-readable output; `run` and `undo` take `--yes` to skip the confirmation, and `--temporal` to run as a durable workflow (below). `dz preview --summary` prints only counts and timings, with no file names, so you can share how it did on a real folder without sharing what is in it. The folder defaults to `DZ_INBOX`, then `~/Downloads`.

Dropzone Zero keeps its state in a hidden `.dropzone` folder inside the folder it organizes: the saved plan, the journal (`journal.jsonl`), and `quarantine/`. Quarantine is never emptied for you.

## Guardrails: the model proposes, the guard decides

Three parts with separate jobs: the model reads files and proposes a plan; the guard decides what may run; the executor carries it out and verifies it. The model never decides whether something is allowed, and no file name or document text is ever treated as an instruction. The model can only answer with a category, a date, and a title, and code turns that into a move, so the worst a hostile document can do is get itself misfiled.

Every planned item gets one verdict, shown in the first column of `dz preview`:

| Verdict | When | What happens |
|---|---|---|
| `ALLOW` | A contained move or quarantine with a confident classification | Runs with `dz run` |
| `REVIEW` | Programs and installers (by extension or execute bit), low confidence (under 0.5), failed classification, or the review gate expects you to undo it | Waits until `dz approve` releases that exact move |
| `BLOCK` | Partial downloads, targets outside the folder, a change of file type, anything that is not a move or quarantine | Never runs, whatever is approved |

The executor does not trust the plan file either. Right before each rename it judges the item again and checks the disk:

- the source is a regular file, not a symbolic link;
- the source and target really sit inside the folder after resolving symbolic links, and no folder on the way is a link (checked again after creating folders);
- the target does not exist (no overwrites), and the file still has the hash it had at preview time;
- an approval only counts for the exact content, action, and target that were approved: if the plan changes, it must be approved again;
- the saved plan carries a SHA-256 digest, and a plan edited by anything but Dropzone Zero is refused.

Runs of more than 20 allowed moves (`DZ_BULK_LIMIT`) are reported as bulk changes, which is where a second approval step plugs in.

Each file moves through explicit states: `planned` or `needs-review` → `approved` → `executing` → `verified` (or `failed`), and `restored` after an undo; `blocked` never moves. The states are replayed from the saved plan and the append-only journal rather than stored separately, so they cannot drift from what actually happened. A file left in `executing` means a run stopped between the rename and its check, and `dz status` says how to finish or reverse it.

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

With `--auto`, only files that arrive after watching starts are moved. Files that were already in the folder are not even sent to the model, so a cluttered Downloads folder never makes a new download wait; sort the backlog with `dz tidy` whenever you like, or pass `--include-existing` to let watch handle it too.

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

While it runs, watch owns the saved plan, so use `dz tidy` for the backlog before or after a watch session rather than during it.

## How a run stays safe

- `dz run` executes exactly the plan you previewed. The model is not asked again, so what you saw is what happens.
- A file is skipped, not moved, if it changed since the preview, if its target already exists, or if the guard says no.
- Every move is a rename inside the same folder tree: no copy, no delete, and the file is never in two places or none. The journal records each move as "started" before the rename and "done" after the new location is hashed, so even a run interrupted mid-move can be undone.
- `dz undo` moves a file back only if it still has the hash it was moved with and its old place is free. If you edited a file after the run, undo leaves it where it is and tells you.

## A review gate that learns what you undo

Everyone files differently. Some people keep screenshots in Downloads to share them quickly; some never want exports sorted. Rather than adding settings for every habit, Dropzone Zero watches what you put back.

- `dz undo --file <name>` moves one file back and records it as a rejected move. Moves you leave alone count as accepted. (Undoing a whole run teaches nothing; that usually means "not now", not "wrong place".)
- Once a folder has at least 20 decisions with at least 3 of each kind, `dz preview` asks [TabPFN](https://priorlabs.ai), a tabular foundation model, how likely each planned move is to be put back. TabPFN learns from a small table in a single forward pass, with no training loop, which is what makes it practical for a few dozen personal decisions.
- Moves that are more likely rejected than not get a `REVIEW` verdict with the reason, and nothing moves until you approve it.

The gate only sees metadata: extension, file type, category, confidence, size, age, and the shape of the planned target. It never sees names or contents, and it runs locally through [uv](https://docs.astral.sh/uv/) with the TabPFN v2 weights, which need no account or API key. The first preview that uses it creates `ml/.venv` (about 1 GB, mostly PyTorch) and downloads the weights once. Set `DZ_REVIEW_GATE=off` to skip it.

To see it on the demo, give the demo folder a synthetic past in which a fictional user kept moving screenshots back:

```bash
pnpm seed && pnpm seed:history
pnpm dz preview demo/inbox
# REVIEW  move  screenshot  Screenshot 2026-10-12 at 09.41.22.png  -> Screenshots/...  (You moved back similar files before (86% likely))
# Review gate: 1 sent to review, learned from 90 decisions (11 moved back).
```

Built with TabPFN. The v2 weights are under the [Prior Labs License](https://huggingface.co/Prior-Labs/TabPFN-v2-clf/blob/main/LICENSE.txt) (Apache 2.0 with an additional attribution requirement); newer TabPFN weights need a license acceptance and an API key, so Dropzone Zero does not use them.

## Receipts to CSV

After a run, `dz receipts` reads everything under `Finance/Receipts` and `Finance/Invoices` (and anything the saved plan marks as a receipt or invoice but has not moved yet), including photographed receipts, and writes `Finance/receipts-YYYY-MM-DD.csv`:

```csv
date,vendor,kind,total,currency,document_number,file,status
2026-10-11,JUNIPER MARKET,receipt,23.35,USD,0417-22,Finance/Receipts/2026-10/2026-10-11-juniper-market-receipt.jpg,ok
,Pixelwave Hosting,invoice,12.00,USD,INV-3391,Finance/Invoices/2026-10/2026-10-31-pixelwave-hosting-invoice-payment.pdf,check: date
```

The same rule as for file dates applies: a value is kept only if it is printed in the document (`103.99`, `1,234.50`, `1.234,50`, and `12,000` all count). Anything the model cannot point to is left blank, and the row says `check:` with what is missing, so a wrong number never slips into your bookkeeping looking like a right one. On the demo, all six receipts and invoices come out right; the two marked for checking really have no purchase date. Exports never overwrite an earlier one, and cells that start with `=`, `+`, `-`, or `@` are escaped so a spreadsheet will not run them as formulas.

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

## How a plan is made

1. **Rules first.** Partial downloads are skipped. Empty files, duplicates (same SHA-256 as an older copy), and temp files are planned for quarantine. These cases never reach the model.
2. **Read the file.** Text is pulled from PDFs with [unpdf](https://github.com/unjs/unpdf) (a serverless build of Mozilla's PDF.js, so compressed real-world PDFs work too) from Office files (`.docx`, `.xlsx`, `.pptx`, through a small built-in ZIP reader), and from text formats such as `.txt`, `.md`, `.csv`, `.json`, and `.ics`, capped at 2,000 characters. Images (`.png`, `.jpg`, `.webp`, up to 20 MB) go to Gemma's vision input, so a phone photo named `IMG_2041.jpg` can come out as `Finance/Receipts/2026-10/2026-10-11-juniper-market-receipt.jpg`. Installers and other binaries are described by name and size only.
3. **The model reads; code files.** Gemma returns strict JSON: a category, the date written in the document, a short title, a confidence, and a reason. The folder and final name are built in code from that answer (for example `Finance/Receipts/2026-10/2026-10-14-bluebird-coffee-receipt.pdf`). A date the model reports is kept only if it actually appears in the file (as 2026-10-14, 10/14/2026, Oct 14, 2026, 2026년 10월 14일, and other common forms), because small models fill gaps with plausible dates. For images, the model also transcribes the text it reads, and the date has to appear in that transcription.
   Categories cover what a real Downloads folder holds, not just paperwork: receipts, invoices, statements, bookings, photos, screenshots, images, manuals, warranties, notes, documents, spreadsheets, presentations, calendar invites, installers, and temp files. An early version without the generic document, spreadsheet, presentation, and image categories sent 75% of a real folder to "other"; with them, it is 15%.
4. **Doubt means stay put.** Invalid JSON gets one retry, then the file falls back to `other` and is skipped. Anything under 0.5 confidence is also skipped and shown for review.

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Local Ollama server |
| `DZ_MODEL` | `gemma4:e4b` | Any Ollama model that supports structured output |
| `SENTRY_DSN` | unset | Optional error and timing reports, see below |

## Telemetry

Off by default. With `SENTRY_DSN` set, Dropzone Zero sends counts (files, moves, quarantines, skips, fallbacks), timings, and errors to [Sentry](https://sentry.io). File names, paths, and contents are never sent: console and HTTP breadcrumbs are disabled, and every error message and stack frame is scrubbed of paths before it leaves the machine.

## Roadmap

- [x] Scan with SHA-256 duplicate detection
- [x] Local classification with Gemma 4 through Ollama, and `dz preview`
- [x] `dz run` with hash checks before and after every move, journaled
- [x] `dz undo` from the journal
- [x] Run and undo as a durable Temporal workflow, so a crash or reboot resumes where it stopped
- [x] Guardrail engine with ALLOW / REVIEW / BLOCK verdicts, checked again by the executor
- [x] `dz watch` with `--auto` for allowed moves only
- [x] Gemma vision for photos and screenshots (Ollama's `images` field)
- [ ] Vision for scanned PDFs that have no text layer (render the first page to an image)
- [x] `dz tidy` as a Mastra workflow with a suspend/resume approval step

## Demo data

`pnpm seed` builds a Downloads-style folder with 31 files: receipts, bookings, photos (one of them a photographed receipt), manuals, exports, installers, temp files, and duplicates. The receipt photo is rendered by `scripts/make-receipt-photo.py`. Every name, company, and amount in it is fictional.

## License

[MIT](LICENSE)
