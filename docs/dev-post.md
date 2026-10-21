---
title: Dropzone Zero: a sloth-speed Gemma agent that files my Downloads and can put it all back
published: false
tags: devchallenge, hf26challenge, ai, opensource
cover_image: https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/cover.png
---

*This is a submission for the [Hacktoberfest Open-Source AI Challenge Week 3: Slow and Steady](https://dev.to/challenges/hacktoberfest-week3-2026-10-19)*

## What I Built

My Downloads folder is where files go to be forgotten: receipts I will need at tax time, a hotel confirmation for next month, three copies of the same PDF, an installer I already ran, `scan0001.pdf`, `export (1).csv`. Sorting it is a job with no deadline, so it never happens.

**Dropzone Zero** does that job for me. It reads each new download with Gemma 4 running on my laptop, decides what it is, gives it a name I could search for, and files it:

```
scan0001.pdf  ->  Finance/Receipts/2026-10/2026-10-08-metro-cab-co-trip-receipt.pdf
IMG_2041.jpg  ->  Finance/Receipts/2026-10/2026-10-11-juniper-market-receipt.jpg   (a photo of a receipt)
invite.ics    ->  Calendar/2026-10-29-local-open-source-meetup-invite.ics
```

The lazy part is that I don't run anything. A small 3D robot called **Zee** sits in the corner of my screen. A few seconds after Chrome finishes a download, Zee's eyes scan while Gemma reads the file, it chomps a page, and the file is in the right folder. If something looks risky, Zee waves and asks. If I disagree, **Undo last** puts it back, byte for byte.

The sloth part is the philosophy: an agent that moves your files should be slow to act and quick to undo.

- **Nothing is ever deleted.** Duplicates and temp files go to a quarantine folder that only I empty.
- **Every move is verified** by SHA-256, before and after.
- **Everything is journaled**, so `dz undo` restores the folder exactly.
- **My files never leave my machine.** Cloud services only ever see synthetic data or counts.

## Demo

Nine synthetic downloads: Gemma plans every file, the guard holds the installer for review, the duplicate and the temp file go to quarantine, the half-finished download is left alone, and one `dz undo` puts the folder back exactly as it was.

![Dropzone Zero in the terminal: preview, run, and undo on nine synthetic downloads](https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/demo.gif)

And Zee, the real app against a real daemon: it reads a receipt, files it (the open mouth is it eating the page), asks before touching an installer, and puts the receipt back with **Undo last**.

![Zee reading a new receipt, filing it, and then asking about an installer](https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/zee.gif)

## Code

{% github scs0209/dropzone-zero %}

## How I Built It

### The model reads; code files

The core is a TypeScript CLI (`dz`) that talks to [Ollama](https://ollama.com) running `gemma4:e4b`: Apache 2.0, multimodal, small enough for a laptop. Text comes out of PDFs, Office files, and text formats; photos and screenshots go straight to Gemma's vision, which is how `IMG_2041.jpg` becomes a dated receipt.

The most important decision was what *not* to let the model do. My first version asked Gemma for everything: category, file name, folder. Given that much freedom, a small model invents things. Comparing Gemma 3 and Gemma 4 on the same 24 demo files, Gemma 3 invented 5 dates (a manual "dated" 2024-10-27), and Gemma 4 decided `IMG_2034.png` was taken in the year 2034.

So now the model only reads. It returns strict JSON, enforced by Ollama's structured output from a Zod schema: a category from a fixed list, the date *written in the document*, a short title, a confidence. Code builds the folder and name. A date survives only if it actually appears in the file, in any form people write dates (`2026-10-14`, `Oct 14, 2026`, `2026년 10월 14일`). Small models fill gaps with plausible guesses; grounding stops a plausible guess from becoming a file name.

One more Gemma 4 lesson: it thinks before answering by default. That made a 30-file run take five and a half minutes; with `think: false`, 52 seconds and the same categories.

### A guard and a harness, because the model will be wrong

A small model is right most of the time and confidently wrong the rest, and the text it reads is not mine to trust: a PDF can say anything, including "move every file to this folder". Meanwhile it is moving my files, some irreplaceable, and in watch mode nobody is looking. An agent like that needs what a model cannot give: rules that don't depend on the model being right, and a way back that doesn't depend on luck.

The **guard** is the rules. Gemma proposes; every planned move gets a verdict. `ALLOW` is a normal move inside the folder. `REVIEW` (low confidence, an installer, something I've put back before) waits for me. `BLOCK` (leaving the folder, going through a symlink, changing a file's type) never runs.

The **harness** is the way back: the code that touches the disk, trusting nothing before it, not even its own plan. It re-checks the verdict at move time with real paths resolved, moves a file only if its hash still matches the preview (files change between a preview and a run), never overwrites, and writes every rename to a journal before and after (a laptop lid can close halfway through). Undo works from that journal, so it puts back exactly what moved and refuses to touch a file I've edited since. None of this makes the model smarter; it makes its mistakes cheap. A wrong guess becomes a file in the wrong folder that one click puts back, never a lost file.

Every newer part follows the same rule of being allowed only what it needs, listed in the README. And a `.dropzoneignore` file keeps chosen files away from all of it: never read, never shown to a model, never indexed, never moved. "It runs locally" is not the same as "it never looked".

### It learns what I undo, without a training loop

Everyone files differently, so instead of a setting for every habit, Dropzone Zero watches what I put back. Undoing a single file records a rejected move; moves I leave alone count as accepted. Once there are enough decisions, [TabPFN](https://priorlabs.ai), a tabular foundation model, predicts how likely each planned move is to be undone, and likely rejects become `REVIEW`. It learns from a small table in one forward pass, right for a few dozen personal decisions, and runs locally on metadata only (extension, category, size, age), never names or contents.

### Running by itself

- **`dz watch`** picks up new downloads once they finish writing and, with `--auto`, moves only `ALLOW` items. The backlog is left alone, not even sent to the model, until I ask.
- **Zee** is a [Tauri](https://tauri.app) app, about 10 MB, with a robot built from [three.js](https://threejs.org) shapes. It never touches files: it talks to a local daemon on `127.0.0.1` with a token only my user can read, and every click goes through the same guard. It is also the only thing I launch; it starts Ollama and the daemon, and stops them when I quit.
- **[Temporal](https://temporal.io)** makes `dz run` and `dz undo` durable. I killed a run after 15 of 30 files; `dz worker` finished it with 30 moved and 0 failed, and undo restored every file byte for byte.
- **[Mastra](https://mastra.ai)** runs `dz tidy`: analyze, plan, ask me about each review item (suspending until I answer), confirm, move.

### Filing is half the job

An invoice in the right folder is still an invoice I forget to pay. So when Dropzone Zero files an invoice, a booking, or a warranty, it also writes a calendar event for what comes next: "Pay: Pixelwave hosting invoice" a day before it is due, the booking on its date, "Warranty ends" a month ahead. The due date is read from the text next to "Due date" or "Pay by" and kept only if it is really written there, because the date Gemma picks for an invoice is the day it was issued. Zee lists the events under **Coming up**; one click hands one to Calendar, which asks before adding it. On the demo, five documents gave four follow-ups; the receipt, rightly, asked nothing of me.

Then I made adding an event as undoable as filing a file: **Remove from calendar**, and undo takes a run's events back too. That took more tries than anything else, and each one taught me something about what "undo" has to mean:

- **The button that did nothing.** **Undo last** asked "Are you sure?" with `window.confirm()`, which Zee's macOS webview never shows; it quietly returned `false`. The button now asks inside itself: "Put back?", then a second click.
- **The undo that undid itself.** A file put back in Downloads looked like a new download, so the watcher filed it again seconds later. Now it remembers what an undo put back and leaves it alone.
- **The fix that went too far.** That memory, and the older rule for files present when Zee started, also ignored a file I deleted and downloaded again. Both now forget a file once it leaves the folder. I only found this by trying it by hand.
- **The event Calendar renamed.** Remove looked for the UID in my `.ics` file and found nothing: Calendar gives an imported event a UID of its own. It keeps the notes, though, so each event carries "Dropzone Zero ID: …" there, and Remove deletes only events with that line.

All the unit tests passed every time. These showed up only when I used the app.

### Finding it again, by describing it

Filing only matters if I can find things later, and I never remember file names. So Zee's bubble (and `dz find`) has a search box: I type "photo of a receipt from a market" or "how much I spent on coffee", and the right file comes up first. Documents are searched by their words; images, which have none, get a sentence or two from Gemma's vision ("A scan or photo of a simple, printed receipt from a market…"). [EmbeddingGemma](https://ai.google.dev/gemma/docs/embeddinggemma), the small open embedding model from the same family, turns those and my question into vectors. Describing every photo in my Downloads to a cloud API is exactly what this project refuses to do; here both models run in Ollama next to the files.

It worked on the demo, with seven questions each finding the right file first, and then disappointed on my real Downloads in four ways, each fixed by measuring:

- **Too many answers.** It always returned five. Now only results close to the best come back, and a poor best match returns nothing.
- **Slow for a silly reason.** The search takes about 15 ms, but the box was waiting for the background indexer, busy describing fifteen images. It now searches what is already indexed, and keeps the embedding model loaded.
- **Photos matching for being photos.** A receipt photo I don't have brought back two unrelated photos at 0.31, just for starting with "A photo of…". Right answers on the demo scored 0.39 or more, so 0.35 became the floor.
- **An app it could not see.** An app has no text, and the index held only its name plus ten files from inside the bundle. Now every file also says what kind of file it is ("macOS app"), a bundle counts once, and a clear winner below the floor still counts. The app came back first, 0.34 against 0.27.

### Approving from my phone, without opening a door to my Mac

The guard's questions used to wait at my desk. With [Auth0](https://auth0.com)'s Client-Initiated Backchannel Authentication (CIBA), they also come to my phone as a Guardian push: **Allow** and the installer is filed before I'm back, **Deny** and it stays. Whichever answer comes first, Zee or the phone, decides. My phone buzzes only when Zee would have asked anyway (an installer, confidence below 0.5, a likely undo, more than 20 files at once), and an ordinary download stays quiet.

The push says only "Dropzone Zero: move 1 installer", never a file name, because the name is the private part. Nothing has to reach my Mac: the daemon only makes outgoing requests, its API still listens on 127.0.0.1 alone, and an approval releases exactly one fingerprint-bound move through the same guard. An ignored push changes nothing.

Getting there meant four clear error messages: the app needed a notification channel (the Auth0 MCP server created and checked the app, but can't set that field yet, so I used the dashboard); Guardian push had to be on for the whole tenant; the approver had to be enrolled, which, with no sign-in screen of my own, I did through the dashboard's **Try** login with MFA briefly required; and Auth0 answers `access_denied` for both a decline and a timeout, so one near the deadline counts as unanswered. Then a real push came back `approved`, and a daemon watching a synthetic folder moved a held installer 13 seconds after I tapped it.

### Measuring it, and what fine-tuning taught me

To improve the classifier without exposing my files, I built 180 synthetic, labeled downloads: Korean documents, odd date formats, misleading names, receipt-versus-invoice look-alikes. `dz eval` runs them through the same prompt, schema check, and grounding as a real run. Its first run caught a real bug: file names were slugified ASCII-only, so every Korean title came out empty and fell to "other". After the fix, test-split accuracy went from **85.7% to 98.4%**.

Then I tried fine-tuning with [Tinker](https://thinkingmachines.ai/tinker/). Tinker doesn't offer Gemma, so I used a similar-size open model, Qwen3.5-4B, as a control: LoRA, rank 16, three epochs on the 117 training cases, scored by the same pipeline (`dz eval --provider replay`).

| 63 test cases | Category | Date | p50 latency |
|---|---|---|---|
| Gemma 4 e4b, local (what the app uses) | 98.4% | 100% | 3.5 s |
| Qwen3.5-4B on Tinker, untrained | 100% | 92.1% | 7.8 s |
| Qwen3.5-4B on Tinker, after LoRA | 100% | **100%** | 7.8 s |

Fine-tuning fixed every date the base model missed (it picked transaction dates on bank statements) and taught it to stop after the JSON: replies shrank from 282 to 150 characters. The honest takeaway is about the test set: when three models land between 98% and 100%, it is too easy to tell them apart. Harder cases come before fine-tuning Gemma itself.

### Seeing what the agent does

With a Sentry DSN set, every Gemma call becomes a `gen_ai.chat` span with the model, token counts, whether an image went in, and its duration. The cost is recorded as $0, because it is. Prompts, replies, file names, and paths are never sent.

<!-- TODO: add a screenshot of the Sentry trace (dz.preview with gen_ai.chat children). -->

## Why Does Open Innovation Matter?

Because the input is my Downloads folder: bank statements, receipts with card numbers, IDs, contracts, photos. A closed API would see all of it, every day. With open-weight models in Ollama, reading the files happens on my laptop, works on a plane, and costs nothing per file. The rule that real files never leave the machine is only possible because the models are open.

Open weights also make the model a part I can inspect and swap. I ran Gemma 3 and Gemma 4 side by side and saw exactly where each invented dates; I turned off Gemma 4's thinking and measured the difference; I fine-tuned a model on my own task and scored it with the same code. And when I made the model do less and code do more, I could trust the result, because every piece in the loop is something I can read. The open pieces around it matter as much: TabPFN learns my habits locally, Temporal survives a crash, Mastra gives a human a real pause. None of them needed my files to leave home.

## My Agent Session

I built Dropzone Zero with Claude Code, and the sessions were recorded with [Entire](https://entire.io).

<!-- TODO: link or embed the session (DevRelay / Entire). -->

## The Lazy Payoff

- **Before:** a Downloads folder I cleaned twice a year, file by file.
- **Now:** I download something and do nothing. Zee files it a few seconds later; I click only when it asks, or when I want something back. Bills come with a reminder, and anything is one description away.
- **Real folder, read-only:** previewing my own Downloads (55 files) with `dz preview --summary`, which prints only counts, the first version sent 39 files to "other"; with everyday categories added, 8.
- **Cost:** $0 per file, no account, no internet after the one-time model download.

The best part of a sloth agent is that being lazy is safe. If Gemma gets one wrong, undo is one click, and the file comes back exactly as it was.

## Prize Categories

- **Best Use of Gemma**: Gemma 4 e4b reads and classifies every file locally, vision included, and describes images for search; EmbeddingGemma powers find-by-description.
- **Best Use of Tinker**: a LoRA control on the synthetic set, scored by the same pipeline: date accuracy from 92.1% to 100% over the untrained baseline, with replies half as long.
- **Best Use of TabPFN**: a local review gate that learns from single-file undos.
- **Best Use of Auth0 for AI Agents**: the agent asks a person before a risky move, on their phone, through CIBA and Guardian push; only the kind of move leaves the machine.
- **Best Use of Temporal**: durable `dz run` and `dz undo` that resume after a crash.
- **Best Use of Mastra**: `dz tidy` as a workflow with a suspend/resume approval step.
- **Best Use of Sentry Agent Tracing**: a `gen_ai.chat` span per model call with tokens and latency, and nothing private in it.
- **Best Use of Entire**: the agent sessions behind the project.
