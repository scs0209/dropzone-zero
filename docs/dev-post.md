---
title: Dropzone Zero: a local Gemma agent files every download, asks before anything risky, and undoes it all in one click
published: false
tags: devchallenge, hf26challenge, ai, opensource
cover_image: https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/cover.png
---

*This is a submission for the [Hacktoberfest Open-Source AI Challenge Week 3: Slow and Steady](https://dev.to/challenges/hacktoberfest-week3-2026-10-19)*

I never tidy my desktop or my folders, so files just pile up, and sorting them by hand is tedious and always takes longer than I expect. So I built Dropzone Zero: a local agent that files each download the moment it lands, by rules I set once. Gemma 4 reads every file on my laptop, a small robot named Zee shows what it's doing, and **Undo last** puts any file back exactly as it was. On 63 synthetic test documents, Gemma got the document type right 98.4% of the time and the date right every time, at a median of 3.6 seconds per file.

**TL;DR**

- **What:** Dropzone Zero reads each new download with `gemma4:e4b` in Ollama, decides what it is, names it, and files it. Risky moves wait for me, in a desktop robot called Zee or on my phone.
- **Safety:** the model only proposes. A guard decides (allow, ask, or block), and a harness verifies and journals every move, so undo is exact.
- **The Tinker result:** a LoRA on Qwen3.5-4B took date accuracy from 92.1% to 100% over its untrained baseline. Untuned local Gemma already scores 98.4% and 100%, so the app keeps Gemma.
- **Privacy:** real files never leave the machine. Cloud services only see synthetic test data, a label like "move 1 installer", or counts.

## What I Built

Here's what piles up: receipts I'll need at tax time, a hotel confirmation for next month, three copies of the same PDF, an installer I already ran, `scan0001.pdf`, `export (1).csv`. Cleaning up means opening each file, working out what it is, renaming it, dragging it somewhere sensible, and doing it all again for the next one. The job has no deadline, so I put it off, and then I can't find the invoice I need, or I forget to pay it.

So I didn't want a better way to clean up. I wanted to never clean up. The rules I set once say where each kind of file goes, how it's named, and what may move on its own versus what has to ask me first. In practice:

```
scan0001.pdf  ->  Finance/Receipts/2026-10/2026-10-08-metro-cab-co-trip-receipt.pdf
IMG_2041.jpg  ->  Finance/Receipts/2026-10/2026-10-11-juniper-market-receipt.jpg   (a photo of a receipt)
invite.ics    ->  Calendar/2026-10-29-local-open-source-meetup-invite.ics
```

Duplicates and temp files go to a quarantine folder only I empty, an invoice gets a "pay by" reminder, and anything filed can be found again by describing it. The sloth principle runs through all of it: an agent that moves your files should be slow to act and quick to undo.

## Demo

Nine synthetic downloads: Gemma plans every file, the guard holds the installer for review, the duplicate and the temp file go to quarantine, the half-finished download is left alone, and one `dz undo` puts the folder back exactly as it was.

![Dropzone Zero in the terminal: preview, run, and undo on nine synthetic downloads](https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/demo.gif)

Zee, the real app against a real daemon: it reads a receipt, files it (the open mouth is it eating the page), asks before touching an installer, and puts the receipt back with **Undo last**. No command anywhere.

![Zee reading a new receipt, filing it, and then asking about an installer](https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/zee.gif)

## Code

{% github scs0209/dropzone-zero %}

## How I Built It

The core is a TypeScript CLI (`dz`) that talks to [Ollama](https://ollama.com) running `gemma4:e4b`: Apache 2.0, multimodal, small enough for a laptop. Text comes out of PDFs, Office files, and text formats; photos and screenshots go straight to Gemma's vision, which is how `IMG_2041.jpg` becomes a dated receipt. One file's path through it:

```
new download → rules: still downloading? empty? duplicate? temp?
             → Gemma 4 (local) reads it → strict JSON: kind, printed date, title, confidence
             → code builds the name and folder; a date stays only if it is printed in the file
             → guard: ALLOW · REVIEW (Zee or phone) · BLOCK, plus TabPFN: "will I undo this?"
             → harness: re-check, hash, rename, hash again, journal → undo from the journal
```

### A small model is a confident liar

My first version asked Gemma for the whole answer: kind, name, folder, date. I compared Gemma 3 and Gemma 4 on the same 24 demo files and read every answer. The kinds were mostly right. The dates were the problem:

- `AC-X200_manual.pdf`: Gemma 3 dated it **2024-10-27**, confidence 0.95. No date is printed anywhere in it.
- `notes.txt` and `router_quick_start.pdf`: both **2024-01-01**, also at 0.95.
- `IMG_2034.png`, `IMG_2035.png`, `IMG_2036.png`: Gemma 4 dated them to the years **2034, 2035, and 2036**, apparently from the numbers in their names.

Gemma 3 invented 5 dates in 24 files. A confident guess like that, once it is in a file name, is worse than no date at all.

So now the model only reads. It returns strict JSON (Ollama's structured output, from a Zod schema): a kind from a fixed list, the date *printed in the document*, a short title, a confidence. Code builds the folder and the name. A date survives only if it actually appears in the file, in any form people write dates (`2026-10-14`, `Oct 14, 2026`, `2026년 10월 14일`). And `think: false`: Gemma 4 reasons before answering by default, which made a 30-file run take five and a half minutes. Without it, 52 seconds and the same answers.

### Allow, ask, or block: a guard and a harness

An agent that renames and moves my files is a different risk from a chatbot. The model is confidently wrong some of the time, the text it reads isn't mine to trust (a PDF can say anything, including "move every file to this folder"), the files are mine and some are irreplaceable, and in watch mode nobody is looking. So three things happen outside the model: a check before anything runs, a question to me when the check isn't sure, and verification after every change.

| Verdict | When (as `guard.ts` and `rules.ts` decide it) | What happens |
|---|---|---|
| `ALLOW` | A move inside the folder, classified with confidence 0.5 or more, not a program; empty files, duplicates (same SHA-256 as an older copy), and temp files going to quarantine | Runs on its own, even in `dz watch --auto` |
| `REVIEW` | No valid answer after a retry; confidence below 0.5; a program or installer (by extension or execute bit); a move TabPFN expects me to undo; more than 20 new moves at once (one approval for the batch) | Waits for me in Zee, the terminal, or on my phone |
| `BLOCK` | A download still in progress; a target outside the folder; a source that isn't a plain file in it; a change of file type; a move into a hidden folder; a symbolic link anywhere on the path | Never runs, whatever anyone approves |

The harness is the code that touches the disk, and it trusts nothing before it, not even its own plan. It judges each move again with real paths, moves a file only if its hash still matches the preview, never overwrites, and journals every rename before and after (a laptop lid can close halfway through). Undo reads that journal, so it puts back exactly what moved and refuses to touch a file I've edited since. None of this makes the model smarter. It makes its mistakes cheap: a wrong guess becomes a file in the wrong folder that one click puts back, never a lost file. A `.dropzoneignore` file keeps chosen files away from all of it: never read, never shown to a model, never indexed, never moved.

[TabPFN](https://priorlabs.ai) adds one more reason to ask. Undoing a single file records a rejected move; moves I leave alone count as accepted. Once there are enough decisions, TabPFN predicts from that small table, in one forward pass, how likely each new move is to be undone, and the likely ones become `REVIEW`. It runs locally on metadata only (extension, kind, size, age), never names or contents.

### No terminal: why a robot, and why Tauri

The first working version was a CLI, and daily use showed the problem: open a terminal, remember `dz watch ~/Downloads --auto`, and once files moved on their own, no idea where they went. A tool for being lazy shouldn't need a terminal. So it all became one click on **Zee**, a robot built from [three.js](https://threejs.org) shapes: its face shows what it's doing, its bubble lists what was filed (click to see it in Finder), questions come with **Move it** and **Leave it**, and **Undo last** is always there. Zee is also the only thing I launch; it starts Ollama and the background daemon, and stops them when I quit.

Hiding or quitting Zee doesn't just close a window. Zee dives into a hole in the ground, and pops back out when it's called:

![Zee diving into a hole in the ground and popping back out](https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/zee-dive.gif)

I built Zee with [Tauri](https://tauri.app) rather than Electron. Zee is a window that never closes, so it has to be light: Electron ships Chromium and Node.js inside every app, while Tauri uses the WebView macOS already has, so Zee.app is 10 MB. Tauri is also locked down by default, which suits a UI that must never touch files: Zee's page can call only the window functions its capability file lists and a few commands of its own, and it talks to the daemon on `127.0.0.1` with a token only my user can read. A transparent, always-on-top window with a menu bar icon comes built in. The system WebView had a cost I found later, below.

### What daily use broke

The unit tests (142 of them now) kept passing while most of these bugs were live. Using the app is what found them:

- **39 of 55 files filed as "other".** Previewing my own Downloads (counts only), the first category list was too narrow. Adding documents, spreadsheets, presentations, and images brought "other" down to 8.
- **Two watchers racing.** A `dz watch` left running in a terminal moved a new download first; Zee's daemon then failed with "File is gone" and never showed the move. Now a lock allows one watcher per folder.
- **A backlog blocking everything.** With more than 20 old files in Downloads, `--auto` hit the bulk limit on every pass and moved nothing, not even a fresh download. Now old files are left alone, not even sent to the model, and new ones go through.
- **An undo button that did nothing.** It asked "Are you sure?" with `window.confirm()`, and the macOS WebView Tauri uses never shows that dialog: `confirm()` quietly returned `false`. The button now asks inside itself: "Put back?", then a second click.
- **An undo that undid itself.** A file put back in Downloads looked like a new download, and the watcher filed it again seconds later. Now it remembers what an undo put back, and forgets once the file leaves, so a real re-download still gets filed. That last part I only found by doing it by hand.
- **Rules only I could change.** "Rules I decide once" lived in a table in the code, so changing where receipts go meant editing TypeScript. Now a `.dropzonerules.json` in the folder sets any kind's folder and name, such as `{ "receipt": { "folder": "Money/Receipts/{year}", "name": "{title}-{date}" } }`. A rule only picks a path: the guard still judges every move, and a rule that points outside the folder or into a hidden one stops the run with a message instead of being quietly ignored.
- **Bills I still forgot.** Filing an invoice doesn't pay it, so invoices, bookings, and warranties now get a calendar event in `Calendar/Follow-ups` ("Pay: …" a day before the due date), read from the text next to "Due date" or "Pay by", since the date Gemma picks for an invoice is the day it was issued. Taking an event back out failed at first, `removed: 0`: Calendar gives an imported event a new UID. It keeps the notes, so events now carry a "Dropzone Zero ID" line there.
- **Files I couldn't find.** Zee got a search box: describe a file ("photo of a receipt from a market") and Gemma's image descriptions plus [EmbeddingGemma](https://ai.google.dev/gemma/docs/embeddinggemma) vectors find it. On my real folder it first answered everything with five results, and listed unrelated photos (0.31) for a photo I don't own. The demo's right answers had scored 0.39 and up, so a 0.35 floor fixed it.

[agent_session 삽입: Undo 관련 버그 추적 세션 — Zee의 Undo가 동작하지 않는다는 보고 → 저널에 undo 기록이 없음을 확인 → `confirm()`이 macOS 웹뷰에서 false를 반환하는 원인 발견 → 되돌린 파일이 다시 정리되는 두 번째 버그 발견 → 수정 후 테스트와 녹화로 확인한 과정]

### Asking me on my phone, without opening a door to my Mac

With [Auth0](https://auth0.com)'s Client-Initiated Backchannel Authentication (CIBA), the guard's questions also reach my phone as a Guardian push: **Allow** and the installer is filed, **Deny** and it stays. Whichever answer comes first, Zee or the phone, decides. The push says only "Dropzone Zero: move 1 installer", never a file name. The daemon only makes outgoing requests, and an approval releases exactly one held move through the same guard. Setting it up meant four clear errors (a missing notification channel, push off for the tenant, an unenrolled approver, and `access_denied` meaning both "declined" and "timed out"). Then a daemon watching a synthetic folder moved a held installer 13 seconds after I tapped **Allow**.

![The Auth0 Guardian approval on my phone: "Dropzone Zero: move 1 installer", with Deny and Approve buttons; the account and tenant are covered](https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/phone-approval.png)

*The real push for a synthetic installer (my phone is set to Korean: 거부 is Deny, 승인 is Approve). I covered my account and tenant. Guardian showed a blank cover while I screen-recorded, so this is a screenshot.*

### Gemma or a fine-tuned Qwen? I measured first

To improve the classifier without exposing my files, I built 180 synthetic, labeled downloads (117 to train on, 63 to test): Korean documents, odd date formats, misleading names, receipt-versus-invoice look-alikes. `dz eval` runs them through the same prompt, schema, and date check as a real run and scores the kind and the date, each by exact match. Its first run caught a real bug: file names were slugified ASCII-only, so every Korean title came out empty and fell to "other". Fixed, Gemma went from **85.7% to 98.4%**.

Could fine-tuning do better? [Tinker](https://thinkingmachines.ai/tinker/) doesn't offer Gemma, so I ran a control: `Qwen/Qwen3.5-4B`, LoRA (rank 16, 3 epochs, batch 16, learning rate 2e-4) on the 117 training prompts, built by the app's own prompt code, with loss only on the answer. The loss fell from 0.24 to 0.0005. Replies to the 63 test prompts were scored by the same pipeline (`dz eval --provider replay`).

| 63 test cases | Kind | Date | Invalid output | p50 latency |
|---|---|---|---|---|
| `gemma4:e4b`, local in Ollama (what the app uses) | 98.4% | 100% | 0% | 3.6 s |
| `Qwen/Qwen3.5-4B` on Tinker, untrained | 100% | 92.1% | 0% | 7.8 s |
| `Qwen/Qwen3.5-4B` on Tinker, after LoRA | 100% | **100%** | 0% | 7.8 s |

Fine-tuning fixed every date the base model missed (on bank statements it picked a transaction date over the statement date) and taught it to stop after the JSON: replies shrank from 282 to 150 characters on average. Gemma's one miss was a paid invoice it called an invoice instead of a receipt. The latency isn't a fair race: Gemma ran on my Mac, Qwen one request at a time over the network.

So the app keeps Gemma, untuned. The task isn't hard enough to need more: reading one document and naming its kind and date is short, well-defined work, which is also why turning thinking off changed no answers. A tuned remote model would buy a point or two at the cost of leaving my laptop. The honest finding is about my test set: when three models land between 98% and 100%, it's too easy to tell them apart.

A word on Tinker, because it surprised me. Fine-tuning had always sounded like a project of its own: rent GPUs, set up a training stack, babysit a run. Here the whole experiment is one 108-line Python script: create a LoRA training client, call `forward_backward` and `optim_step` per batch, save the weights, sample from the tuned model. I never touched a GPU. Writing the evaluation took longer than writing the training.

Here is the run as the terminal printed it: the untrained baseline, the three epochs, and the replies scored by the app's own pipeline.

![The Tinker run in a terminal: base sampling, three LoRA epochs with loss 0.2397, 0.0026, 0.0005, then the replay scoring at 100% and 100%](https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/tinker-run.png)

Tinker's own dashboard shows the same run: one training run on Qwen3.5-4B with LoRA rank 16, and 24 training steps, which is 117 cases in batches of 16 (8 steps), three times over. The session cost an estimated $0.15, 95% of it training; sampling the untrained baseline in a second session added $0.01.

![Tinker's session details: $0.15 estimated, 95.3% of it training, one training run on Qwen/Qwen3.5-4B with LoRA rank 16, and a training-steps chart that climbs to 24](https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/tinker-session.png)

![Document type and date accuracy for gemma4:e4b, untrained Qwen3.5-4B, and Qwen3.5-4B after LoRA, on the same 63 synthetic test files](https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/model-compare.png)

[agent_session 삽입: Tinker 파인튜닝 세션 — Qwen3.5-4B 기준선 샘플링 → LoRA 학습 로그(epoch별 loss 0.2397 → 0.0026 → 0.0005) → `dz eval --provider replay`로 채점한 결과까지의 실행 기록]

### Seeing what the agent does

With a Sentry DSN set, every Gemma call is a `gen_ai.chat` span: model, token counts, whether an image went in, duration, and a cost of $0, because it is. Prompts, replies, file names, and paths are never sent.

Below is one preview of the 31 demo files: 25 model calls (rules decided the other six), and an empty Input tab, because no prompt is stored.

![A Sentry trace of one dz.preview run on the synthetic demo files: 25 gen_ai.chat spans for gemma4:e4b, one selected with its token counts and no prompt stored](https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/sentry-trace.png)

### What it can't do yet

- **Scans with no text layer.** A photographed receipt works, because Gemma's vision reads it. A scanned PDF with no text is classified from its name and size only, and a photographed invoice gets no due-date reminder, since the due date is read from text.
- **Hard cases.** My test set is too easy to separate good models. It needs messier documents before fine-tuning Gemma itself makes sense.

## Why Does Open Innovation Matter?

**My files stay mine.** The input is my Downloads folder: bank statements, receipts with card numbers, IDs, contracts, photos. A closed API would see all of it, every day. With open weights in Ollama, the reading happens on my laptop, works on a plane, and costs nothing per file. The rule that real files never leave the machine is only possible because the models are open.

**I can inspect and swap every part.** I ran Gemma 3 and Gemma 4 side by side and saw exactly which dates each invented. I turned off Gemma 4's thinking and measured the difference. I fine-tuned a model on my own task and scored it with the same code. When I made the model do less and code do more, I could trust the result, because every piece in the loop is something I can read.

## My Agent Session

I built Dropzone Zero with Claude Code, and [Entire](https://entire.io) recorded the sessions as checkpoints while I worked. The two sessions marked above, the undo bug chase and the Tinker fine-tune, show what the code alone can't: how each problem was found.

## The Lazy Payoff

- **Before:** a Downloads folder I cleaned twice a year, file by file.
- **Now:** I download something and do nothing. Zee files it a few seconds later; I click only when it asks, or when I want something back. Bills come with a reminder, and anything is one description away.
- **Cost:** $0 per file, no account, no internet after the one-time model download.

Being lazy is safe here. If Gemma gets one wrong, undo is one click, and the file comes back exactly as it was.

## Prize Categories

- **Best Use of Gemma**: `gemma4:e4b` reads, classifies, and describes every file locally, vision included; EmbeddingGemma powers find-by-description.
- **Best Use of Tinker**: a LoRA on Qwen3.5-4B, scored by the app's own pipeline: date accuracy 92.1% → 100%, replies half as long, and the evidence that the app doesn't need it yet.
- **Best Use of TabPFN**: a local review gate that learns from single-file undos, with no training loop.
- **Best Use of Auth0 for AI Agents**: risky moves are approved on my phone through CIBA and Guardian push; only the kind of move leaves the machine.
- **Best Use of Temporal**: durable `dz run` and `dz undo`. A run killed after 15 of 30 files was finished by `dz worker`: 30 moved, 0 failed.
- **Best Use of Mastra**: `dz tidy` as a workflow that suspends for each review item and resumes on my answer.
- **Best Use of Sentry Agent Tracing**: a `gen_ai.chat` span per model call with tokens and latency, and nothing private in it.
- **Best Use of Entire**: Entire recorded the Claude Code sessions I built this with, as checkpoints pushed to a separate repo, so the undo bug chase and the Tinker run above can be traced back to the conversations that produced them.

Tried but not entered: Backboard (its free credit covered memory and RAG but not model calls, so the comparison moved to Tinker) and ElevenLabs (a voice for Zee is coded but hasn't been run with a real key).
