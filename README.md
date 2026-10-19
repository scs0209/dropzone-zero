# Dropzone Zero

A local agent that keeps your Downloads folder tidy, and can put everything back with one command.

Receipts, booking confirmations, photos, manuals, and half-finished downloads pile up because opening, renaming, and moving each file by hand is tedious. Dropzone Zero reads each file with a local open-weight model, plans where it belongs, shows you the plan, and only then moves it. Every move is journaled with before and after paths and SHA-256 hashes, so a single `dz undo` restores the folder exactly.

> Status: early development for the [Hacktoberfest 2026 DEV Challenge](https://dev.to/challenges/hacktoberfest-week3-2026-10-19) (Week 3, "Slow and Steady").

## Principles

- **Your files stay on your machine.** Classification runs on a local model. Cloud services only ever see the synthetic demo files or aggregate counts.
- **Nothing is deleted.** Duplicates and stale temp files go to a quarantine folder you can empty yourself.
- **Every action is reversible and verified.** Files are copied, hash-checked, and only then is the original moved to quarantine.
- **Preview before acting.** Bulk changes wait for your approval.

## Quick start

Requires Node.js 22.2 or newer, [pnpm](https://pnpm.io), and [Ollama](https://ollama.com) for the local model.

```bash
pnpm install
ollama pull gemma3:4b   # about 3.3 GB, once
ollama serve            # skip if the Ollama app is already running
pnpm seed               # creates demo/inbox with 30 synthetic files
pnpm dz preview demo/inbox
```

On an Apple Silicon laptop the 30-file preview takes under a minute with `gemma3:4b`.

## Commands

| Command | What it does |
|---|---|
| `dz scan [folder]` | Lists files with size, age, hash, and flags (partial download, empty, duplicate) |
| `dz preview [folder]` | Plans a new name and folder for every file with the local model. Read-only: nothing moves |

Both commands take `--json` for machine-readable output. The folder defaults to `DZ_INBOX`, then `~/Downloads`.

More commands (`run`, `undo`) are on the way.

## How a plan is made

1. **Rules first.** Partial downloads are skipped. Empty files, duplicates (same SHA-256 as an older copy), and temp files are planned for quarantine. These cases never reach the model.
2. **Read the file.** Text is pulled from PDFs with [unpdf](https://github.com/unjs/unpdf) (a serverless build of Mozilla's PDF.js, so compressed real-world PDFs work too) and from text formats such as `.txt`, `.md`, `.csv`, `.json`, and `.ics`, capped at 2,000 characters. Images and installers are described by name and size only for now.
3. **The model reads; code files.** Gemma returns strict JSON: a category, the date written in the document, a short title, a confidence, and a reason. The folder and final name are built in code from that answer (for example `Finance/Receipts/2026-10/2026-10-14-bluebird-coffee-receipt.pdf`). A date the model reports is kept only if it actually appears in the file, because small models fill gaps with plausible dates.
4. **Doubt means stay put.** Invalid JSON gets one retry, then the file falls back to `other` and is skipped. Anything under 0.5 confidence is also skipped and shown for review.

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Local Ollama server |
| `DZ_MODEL` | `gemma3:4b` | Any Ollama model that supports structured output |
| `SENTRY_DSN` | unset | Optional error and timing reports, see below |

## Telemetry

Off by default. With `SENTRY_DSN` set, Dropzone Zero sends counts (files, moves, quarantines, skips, fallbacks), timings, and errors to [Sentry](https://sentry.io). File names, paths, and contents are never sent: console and HTTP breadcrumbs are disabled, and every error message and stack frame is scrubbed of paths before it leaves the machine.

## Roadmap

- [x] Scan with SHA-256 duplicate detection
- [x] Local classification with Gemma through Ollama, and `dz preview`
- [ ] `dz run`: copy, verify the hash, then move the original, journaling every step (Temporal workflow)
- [ ] `dz undo` from the journal
- [ ] Gemma vision for photos and screenshots (Ollama's `images` field)
- [ ] [Mastra](https://mastra.ai) agent wrapper. Not added yet: today the classifier is one structured call per file with no tools, and Mastra's agent would need an extra AI SDK provider for Ollama to do the same thing. It becomes worthwhile once the agent has tools to call (journal lookups, receipt-to-CSV, calendar follow-ups).

## Demo data

`pnpm seed` builds a Downloads-style folder with 30 files: receipts, bookings, photos, manuals, exports, installers, temp files, and duplicates. Every name, company, and amount in it is fictional.

## License

[MIT](LICENSE)
