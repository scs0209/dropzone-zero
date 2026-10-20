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

Requires Node.js 22.2 or newer, [pnpm](https://pnpm.io), and [Ollama](https://ollama.com) for the local model.

```bash
pnpm install
ollama pull gemma4:e4b  # about 6.6 GB, once
ollama serve            # skip if the Ollama app is already running
pnpm seed               # creates demo/inbox with 31 synthetic files
pnpm dz preview demo/inbox
pnpm dz run demo/inbox      # asks before moving anything
pnpm dz undo demo/inbox     # puts every file back
```

On an Apple Silicon laptop the 31-file demo preview takes about 70 to 100 seconds with `gemma4:e4b`, most of it spent looking at images. On a real Downloads folder with larger PDFs and photos, expect about 5 seconds per file. Gemma 4 thinks before answering by default; Dropzone Zero turns that off, because for one-file classification it was about 15 times slower with no better answers.

## Commands

| Command | What it does |
|---|---|
| `dz scan [folder]` | Lists files with size, age, hash, and flags (partial download, empty, duplicate) |
| `dz preview [folder]` | Plans a new name and folder for every file with the local model and saves the plan. Nothing moves |
| `dz run [folder]` | Carries out the saved plan after you confirm, verifying each file by hash before and after it moves |
| `dz undo [folder]` | Reverses the most recent run: files go back to their old names and places, and folders the run created are removed if empty |

`scan` and `preview` take `--json` for machine-readable output; `run` and `undo` take `--yes` to skip the confirmation. `dz preview --summary` prints only counts and timings, with no file names, so you can share how it did on a real folder without sharing what is in it. The folder defaults to `DZ_INBOX`, then `~/Downloads`.

Dropzone Zero keeps its state in a hidden `.dropzone` folder inside the folder it organizes: the saved plan, the journal (`journal.jsonl`), and `quarantine/`. Quarantine is never emptied for you.

## How a run stays safe

- `dz run` executes exactly the plan you previewed. The model is not asked again, so what you saw is what happens.
- A file is skipped, not moved, if it changed since the preview, if its target already exists, or if a target would leave the folder.
- Every move is a rename inside the same folder tree: no copy, no delete, and the file is never in two places or none. The journal records each move as "started" before the rename and "done" after the new location is hashed, so even a run interrupted mid-move can be undone.
- `dz undo` moves a file back only if it still has the hash it was moved with and its old place is free. If you edited a file after the run, undo leaves it where it is and tells you.

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
- [ ] Run and undo as a durable [Temporal](https://temporal.io) workflow, so a crash or reboot resumes where it stopped
- [x] Gemma vision for photos and screenshots (Ollama's `images` field)
- [ ] Vision for scanned PDFs that have no text layer (render the first page to an image)
- [ ] [Mastra](https://mastra.ai) agent wrapper. Not added yet: today the classifier is one structured call per file with no tools, and Mastra's agent would need an extra AI SDK provider for Ollama to do the same thing. It becomes worthwhile once the agent has tools to call (journal lookups, receipt-to-CSV, calendar follow-ups).

## Demo data

`pnpm seed` builds a Downloads-style folder with 31 files: receipts, bookings, photos (one of them a photographed receipt), manuals, exports, installers, temp files, and duplicates. The receipt photo is rendered by `scripts/make-receipt-photo.py`. Every name, company, and amount in it is fictional.

## License

[MIT](LICENSE)
