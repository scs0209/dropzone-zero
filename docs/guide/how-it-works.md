# How it works

[← Back to the README](../../README.md)

## How a plan is made

1. **Rules first.** Partial downloads are skipped. Empty files, duplicates (same SHA-256 as an older copy), and temp files are planned for quarantine. These cases never reach the model.
2. **Read the file.** Text is pulled from PDFs with [unpdf](https://github.com/unjs/unpdf) (a serverless build of Mozilla's PDF.js, so compressed real-world PDFs work too) from Office files (`.docx`, `.xlsx`, `.pptx`, through a small built-in ZIP reader), and from text formats such as `.txt`, `.md`, `.csv`, `.json`, and `.ics`, capped at 2,000 characters. Images (`.png`, `.jpg`, `.webp`, up to 20 MB) go to Gemma's vision input, so a phone photo named `IMG_2041.jpg` can come out as `Finance/Receipts/2026-10/2026-10-11-juniper-market-receipt.jpg`. Installers and other binaries are described by name and size only.
3. **The model reads; code files.** Gemma returns strict JSON: a category, the date written in the document, a short title, a confidence, and a reason. The folder and final name are built in code from that answer (for example `Finance/Receipts/2026-10/2026-10-14-bluebird-coffee-receipt.pdf`), by the default layout or your `.dropzonerules.json`. A date the model reports is kept only if it actually appears in the file (as 2026-10-14, 10/14/2026, Oct 14, 2026, 2026년 10월 14일, and other common forms), because small models fill gaps with plausible dates. For images, the model also transcribes the text it reads, and the date has to appear in that transcription.
   Categories cover what a real Downloads folder holds, not just paperwork: receipts, invoices, statements, bookings, photos, screenshots, images, manuals, warranties, notes, documents, spreadsheets, presentations, calendar invites, installers, and temp files. An early version without the generic document, spreadsheet, presentation, and image categories sent 75% of a real folder to "other"; with them, it is 15%.
4. **Doubt means stay put.** Invalid JSON gets one retry, then the file falls back to `other` and is skipped. Anything under 0.5 confidence is also skipped and shown for review.

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Local Ollama server |
| `DZ_MODEL` | `gemma4:e4b` | Any Ollama model that supports structured output |
| `SENTRY_DSN` | unset | Optional error and timing reports, see below |

## Measuring the classifier

`eval/cases.jsonl` holds 180 synthetic downloads with labels (117 to train on, 63 to test with): Korean documents, different date formats, misleading file names, and look-alike categories such as receipt vs invoice. Every vendor, name, and amount is made up, so this set, and only this set, may be sent to a cloud service. `dz eval` runs the test cases through the same prompt, schema check, and date grounding as a real run.

The first run caught a real bug: file names were built ASCII-only, so every Korean title came out empty and those files landed in "other". After the fix, category accuracy went from 85.7% to 98.4%.

As a control, a similar-size open model was fine-tuned on the 117 training cases with [Tinker](https://thinkingmachines.ai/tinker/) (LoRA, rank 16, 3 epochs; `ml/finetune.py`). Tinker does not offer Gemma, so this does not change the app's model; it asks whether fine-tuning is worth doing at all. Its replies are scored by the same pipeline with `dz eval --provider replay`.

| Model (63 test cases) | Category | Date | Invalid | p50 latency |
|---|---|---|---|---|
| Gemma 4 e4b, local (Ollama, the app's model) | 98.4% | 100% | 0% | 3.6 s |
| Qwen3.5-4B on Tinker, untrained | 100% | 92.1% | 0% | 7.8 s |
| Qwen3.5-4B on Tinker, LoRA on the 117 training cases | 100% | 100% | 0% | 7.8 s |

What this says: fine-tuning fixed the base model's date misses (it picked a transaction date over the statement date, and missed dates on screenshots) and taught it to stop after the JSON (replies went from 282 to 150 characters on average). But local Gemma, untuned, is already at 98.4% with one miss (a paid invoice read as an invoice instead of a receipt), so there is little left to win, and the cloud models are slower because of the round trip. The bigger lesson is about the test set: three models scoring 98 to 100% means it is too easy to tell them apart. Harder cases (scans without a text layer, mixed-language documents, near-duplicate categories) come before any fine-tuning of Gemma itself.

## Telemetry

Off by default. With `SENTRY_DSN` set, Dropzone Zero sends counts (files, moves, quarantines, skips, fallbacks), timings, and errors to [Sentry](https://sentry.io). Every Gemma call is traced as a `gen_ai.chat` span with the model name, input and output tokens, whether an image went in, and its duration (cost is recorded as $0, since the model runs locally), so a slow or failing model shows up in Sentry's AI monitoring. `DZ_SENTRY_DEBUG=1` prints what the SDK sends. File names, paths, prompts, replies, and contents are never sent: console and HTTP breadcrumbs are disabled, and every error message and stack frame is scrubbed of paths before it leaves the machine.

## Demo data

`pnpm seed` builds a Downloads-style folder with 31 files: receipts, bookings, photos (one of them a photographed receipt), manuals, exports, installers, temp files, and duplicates. The receipt photo is rendered by `scripts/make-receipt-photo.py`. Every name, company, and amount in it is fictional.

## Roadmap

- [x] Scan with SHA-256 duplicate detection
- [x] Local classification with Gemma 4 through Ollama, and `dz preview`
- [x] `dz run` with hash checks before and after every move, journaled
- [x] `dz undo` from the journal
- [x] Run and undo as a durable Temporal workflow, so a crash or reboot resumes where it stopped
- [x] Guardrail engine with ALLOW / REVIEW / BLOCK verdicts, checked again by the executor
- [x] `dz watch` with `--auto` for allowed moves only
- [x] Gemma vision for photos and screenshots (Ollama's `images` field)
- [x] Your own folder and name rules (`.dropzonerules.json`), checked by the same guard
- [ ] Vision for scanned PDFs that have no text layer (render the first page to an image)
- [x] `dz tidy` as a Mastra workflow with a suspend/resume approval step
