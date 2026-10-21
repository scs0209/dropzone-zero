---
title: Dropzone Zero: a sloth-speed Gemma agent that files my Downloads and can put it all back
published: false
tags: devchallenge, hf26challenge, ai, opensource
cover_image: https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/cover.png
---

*This is a submission for the [Hacktoberfest Open-Source AI Challenge Week 3: Slow and Steady](https://dev.to/challenges/hacktoberfest-week3-2026-10-19)*

## What I Built

My Downloads folder is where files go to be forgotten. Receipts I will need at tax time, a hotel confirmation for next month, three copies of the same PDF, an installer I already ran, `scan0001.pdf`, `export (1).csv`. Sorting it is a job with no deadline, so it never happens.

**Dropzone Zero** is a local agent that does that job for me. It reads each new download with Gemma 4 running on my laptop, decides what it is, gives it a name I could actually search for, and files it:

```
scan0001.pdf  ->  Finance/Receipts/2026-10/2026-10-08-metro-cab-co-trip-receipt.pdf
IMG_2041.jpg  ->  Finance/Receipts/2026-10/2026-10-11-juniper-market-receipt.jpg   (a photo of a receipt)
invite.ics    ->  Calendar/2026-10-29-local-open-source-meetup-invite.ics
```

The lazy part is that I don't run anything. A small 3D robot called **Zee** sits in the corner of my screen. A few seconds after Chrome finishes a download, Zee's eyes start scanning while Gemma reads the file, it chomps a page, and the file is gone from Downloads and in the right folder. If something looks risky, Zee waves and asks. If I disagree with where something went, I click **Undo last** and it goes back, byte for byte.

The sloth part is the philosophy. An agent that moves your files should be slow to act and quick to undo:

- **Nothing is ever deleted.** Duplicates and temp files go to a quarantine folder that only I empty.
- **Every move is verified.** A file moves only if its SHA-256 hash still matches what was previewed, and it is hashed again at its new place.
- **Everything is journaled and reversible.** `dz undo` restores the folder exactly.
- **My files never leave my machine.** The model runs locally. Cloud services only ever see synthetic data or counts.

## Demo

Nine synthetic downloads, start to finish: Gemma plans every file, the guard holds the installer for review, the duplicate and the temp file go to quarantine, the half-finished download is left alone, every move is checked by SHA-256, and one `dz undo` puts the folder back exactly as it was.

![Dropzone Zero in the terminal: preview, run, and undo on nine synthetic downloads](https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/demo.gif)

And here is Zee, the real app UI against a real daemon, as two synthetic downloads land: it reads the receipt, files it (that open mouth is it eating the page), waves and asks before touching an installer, and then puts the receipt back with **Undo last**.

![Zee reading a new receipt, filing it, and then asking about an installer](https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/zee.gif)

## Code

{% github scs0209/dropzone-zero %}

## How I Built It

### The model reads; code files

The core is a TypeScript CLI (`dz`) that talks to [Ollama](https://ollama.com) running `gemma4:e4b`, Gemma 4's 4B-effective model: Apache 2.0, multimodal, and small enough for a laptop. Text comes out of PDFs (unpdf), Office files (a tiny built-in ZIP reader), and text formats. Photos and screenshots go straight to Gemma's vision input, which is how a phone photo named `IMG_2041.jpg` becomes a dated receipt.

The most important design decision was what *not* to let the model do. My first version asked Gemma for the whole answer: category, new file name, target folder. A small model given that much freedom invents things. It made up folder layouts, and worse, it made up dates. When I compared Gemma 3 and Gemma 4 on the same 24 demo files, Gemma 3 invented 5 dates (a manual "dated" 2024-10-27, a note "dated" 2024-01-01), and Gemma 4 decided that `IMG_2034.png` was taken in the year 2034.

So now the model only reads. It returns strict JSON (enforced by Ollama's structured output from a Zod schema): a category from a fixed list, the date *written in the document*, a short title, a confidence, and a reason. Code builds the folder and the file name from that. And a date survives only if it actually appears in the file, in any of the forms people write dates: `2026-10-14`, `10/14/2026`, `Oct 14, 2026`, `2026년 10월 14일`. Small models fill gaps with plausible guesses; grounding is how you stop a plausible guess from becoming a file name.

One more Gemma 4 lesson: it thinks before answering by default. For a one-file classification that made a 30-file run take five and a half minutes. With `think: false` it took 52 seconds, with the same categories.

### A guard that decides, not the model

Gemma proposes; a guardrail engine decides. Every planned move gets a verdict:

- `ALLOW`: a normal move inside the folder.
- `REVIEW`: low confidence, an installer, or something I have put back before. It waits for me.
- `BLOCK`: anything that would leave the folder, go through a symbolic link, or change a file's type.

The executor checks the verdict again at move time, with real paths resolved, so a plan edited on disk cannot sneak past it, and a file whose target already exists is skipped, never overwritten. Moves are renames inside one folder tree: no copy, no delete, never in two places or none. The journal writes "started" before each rename and "done" after the new location is hashed, so even a run killed mid-move can be undone.

### It learns what I undo, without a training loop

Everyone files differently. Rather than adding a setting for every habit, Dropzone Zero watches what I put back. When I undo a single file, that is recorded as a rejected move; moves I leave alone count as accepted. Once there are enough decisions, [TabPFN](https://priorlabs.ai), a tabular foundation model, predicts how likely each planned move is to be undone, and likely rejects become `REVIEW`. TabPFN learns from a small table in one forward pass, which is exactly right for a few dozen personal decisions. It runs locally with the v2 weights and sees only metadata (extension, category, size, age, the shape of the target), never names or contents.

### Filing is half the job

An invoice in the right folder is still an invoice I forget to pay. So when Dropzone Zero files an invoice, a booking, or a warranty, it also writes a calendar event for what comes next: "Pay: Pixelwave hosting invoice" a day before it is due, the hotel booking on its date, "Warranty ends" a month before it does. The same rule as everywhere else applies: the due date is read from the text next to "Due date" or "Pay by" and kept only if it is really written there, because the date Gemma picks for an invoice is the day it was issued, not the day it is due. The events are plain `.ics` files that wait in `Calendar/Follow-ups`; Zee shows them under **Coming up**, and one click hands one to the Calendar app, which asks before adding it. On the demo folder, five documents in gave four follow-ups out; the receipt, rightly, asked nothing of me.

### Durable, watchable, and one click away

- **[Temporal](https://temporal.io)** wraps `dz run` and `dz undo` as durable workflows. I killed a run after 15 of 30 files; `dz worker` finished it with 30 moved and 0 failed, and undo restored every file byte for byte.
- **[Mastra](https://mastra.ai)** runs `dz tidy`, the whole routine in one go: analyze, plan, ask me about each review item (the workflow suspends and resumes on my answer), confirm, move.
- **`dz watch`** picks up new downloads, waits for them to finish writing, and with `--auto` moves only `ALLOW` items. A backlog of old files is left alone, and never even sent to the model, until I ask.
- **Zee** is a [Tauri](https://tauri.app) app, about 10 MB, with a robot built from simple [three.js](https://threejs.org) shapes. Zee never touches files. It talks to a local daemon on `127.0.0.1` with a token only my user can read, and every click goes through the same guard as the CLI. Zee is also the only thing I launch: it starts Ollama and the daemon, and stops them when I quit it.

### Measuring it, and what fine-tuning taught me

To improve the classifier without exposing my own files, I built 180 synthetic, labeled downloads: Korean documents, different date formats, misleading file names, and look-alikes such as a receipt versus an invoice. `dz eval` runs them through the exact same prompt, schema check, and date grounding as a real run.

The first run caught a real bug. File names were slugified ASCII-only, so every Korean title came out empty, and those files fell back to "other". After the fix, category accuracy on the test split went from **85.7% to 98.4%**.

Then I tried fine-tuning with [Tinker](https://thinkingmachines.ai/tinker/). Tinker does not offer Gemma, so I used a similar-size open model, Qwen3.5-4B, as a control: LoRA, rank 16, three epochs on the 117 training cases, and the recorded replies scored by the same pipeline (`dz eval --provider replay`).

| 63 test cases | Category | Date | p50 latency |
|---|---|---|---|
| Gemma 4 e4b, local (what the app uses) | 98.4% | 100% | 3.5 s |
| Qwen3.5-4B on Tinker, untrained | 100% | 92.1% | 7.8 s |
| Qwen3.5-4B on Tinker, after LoRA | 100% | **100%** | 7.8 s |

Fine-tuning fixed every date the base model missed (on bank statements it picked a transaction date instead of the statement date) and taught it to stop after the JSON: replies shrank from 282 to 150 characters on average. But the honest takeaway is about my test set, not the models. When three models land between 98% and 100%, the test is too easy to tell them apart. Harder cases, such as scans with no text layer, come before fine-tuning Gemma itself.

### Approving from my phone, without opening a door to my Mac

The guard's questions used to wait for me at my desk. Now they also come to my phone. With [Auth0](https://auth0.com)'s Client-Initiated Backchannel Authentication (CIBA), the daemon asks Auth0 to send a Guardian push to me, then polls until I answer. If I'm out, I tap **Allow** and the installer is filed before I'm back; I tap **Deny** and it stays in Downloads. Whichever answer comes first, Zee's bubble or the phone, decides, and the other question closes.

It stays quiet most of the time, which is the point. An ordinary download, a photo, a screenshot, a PDF receipt, is filed without asking, and I only see a notification on the Mac. My phone buzzes only when Zee would have asked anyway: an installer, a file Gemma isn't sure about (confidence below 0.5), a move the review gate expects me to undo, or more than 20 new files at once.

Two things made this fit the rest of the project. The push carries only the kind of move, "Dropzone Zero: move 1 installer", never a file name, because the file name is exactly the private part. And nothing has to reach my Mac: the daemon only makes outgoing requests, its API still listens on 127.0.0.1 alone, and an approval releases the same single, fingerprint-bound move that **Move it** does in Zee, through the same guard. If I ignore the push, nothing happens; Zee simply keeps asking.

Getting there took four small walls, each with a clear error message, which is how I like my walls:

1. **"Application must have at least one channel configured."** A CIBA application needs a notification channel. The Auth0 MCP server created and inspected the app for me, but it can't set that field yet, so I turned on the CIBA grant and the Guardian push channel in the dashboard, then trimmed the app back to the CIBA grant only through the MCP.
2. **"Push notifications not enabled on tenant."** The channel on the app isn't enough; Guardian push has to be on for the whole tenant (Security > Multi-factor Auth).
3. **"User does not have push notifications set up."** The approver has to be enrolled in Guardian. My app has no sign-in screen, so I made MFA required for a moment, signed in once through the database connection's **Try** button, scanned the QR code with Guardian, and set the policy back. The enrollment stays.
4. **A decline and a timeout look the same.** Auth0 answers `access_denied` for both. Treating a timeout as **Leave it** would quietly drop the question, so an `access_denied` that arrives near the deadline counts as unanswered, and Zee keeps asking.

Then it worked: a test push came back `approved`, and a daemon watching a synthetic folder moved a held installer 13 seconds after I approved it on the phone.

### Seeing what the agent does

With a Sentry DSN set, every Gemma call becomes a `gen_ai.chat` span with the model, input and output tokens, whether an image went in, and how long it took. The cost is recorded as $0, because it is. Prompts, replies, file names, and paths are never sent; error messages and stack frames are scrubbed of paths before they leave.

<!-- TODO: add a screenshot of the Sentry trace (dz.preview with gen_ai.chat children). -->

## Why Does Open Innovation Matter?

Because the input is my Downloads folder. It holds bank statements, receipts with card numbers, IDs, contracts, and photos. A closed API would see all of it, every day, forever. With an open-weight model in Ollama, the most sensitive part of the job, reading the files, happens on my laptop, works on a plane, and costs nothing per file. The project's rule is simple: real files never leave the machine; cloud services get only synthetic data or counts. That rule is only possible because the model is open.

Open weights also let me treat the model as a part I can inspect and swap, not a black box. I could run Gemma 3 and Gemma 4 side by side on the same files and see exactly where each invented dates. I could turn off Gemma 4's thinking and measure the 15x difference. I could fine-tune a model on my own task and score it with the same code. And when I made the model do less and code do more, I could trust the result, because every piece in the loop is something I can read.

The open pieces around the model matter as much. TabPFN learns my undo habits locally. Temporal makes a file-moving agent survive a crash. Mastra gives `dz tidy` a real pause for a human. None of them needed my files to leave home.

## My Agent Session

I built Dropzone Zero with Claude Code, and the agent sessions behind it were recorded with [Entire](https://entire.io).

<!-- TODO: link or embed the session (DevRelay / Entire). -->

## The Lazy Payoff

- **Before:** a Downloads folder I cleaned twice a year, by opening, renaming, and dragging each file.
- **Now:** I download something and do nothing. Zee files it a few seconds after the download finishes. The only times I click are when Zee asks about an installer or a low-confidence file, or when I want something back.
- **Real folder, read-only:** I previewed my own Downloads folder (55 files) with `dz preview --summary`, which prints only counts. The first version sent 39 of the 55 files to "other". After adding everyday categories (documents, spreadsheets, presentations, images), that dropped to 8.
- **Cost:** $0 per file, no account, no internet needed after the one-time model download.

The best part of a sloth agent is that being lazy is safe. If Gemma gets one wrong, undo is one click, and the file comes back exactly as it was.

## Prize Categories

- **Best Use of Gemma**: Gemma 4 e4b runs locally through Ollama for every classification, including vision for photographed receipts.
- **Best Use of Tinker**: a LoRA control on the synthetic set, scored by the same pipeline: date accuracy from 92.1% to 100% over the untrained baseline, with replies half as long.
- **Best Use of TabPFN**: a local review gate that learns from single-file undos.
- **Best Use of Auth0 for AI Agents**: the agent asks a person before a risky move, on their phone, through CIBA and Guardian push; only the kind of move leaves the machine.
- **Best Use of Temporal**: durable `dz run` and `dz undo` that resume after a crash.
- **Best Use of Mastra**: `dz tidy` as a workflow with a suspend/resume approval step.
- **Best Use of Sentry Agent Tracing**: a `gen_ai.chat` span per model call with tokens and latency, and nothing private in it.
- **Best Use of Entire**: the agent sessions behind the project.
