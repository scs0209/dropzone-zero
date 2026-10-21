---
title: Dropzone Zero: a sloth-speed Gemma agent that files my Downloads and can put it all back
published: false
tags: devchallenge, hf26challenge, ai, opensource
cover_image: https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/cover.png
---

*This is a submission for the [Hacktoberfest Open-Source AI Challenge Week 3: Slow and Steady](https://dev.to/challenges/hacktoberfest-week3-2026-10-19)*

## What I Built

My Downloads folder is where files go to be forgotten: receipts I will need at tax time, a hotel confirmation for next month, three copies of the same PDF, an installer I already ran, `scan0001.pdf`, `export (1).csv`. Sorting it means opening each file, working out what it is, renaming it, and dragging it somewhere sensible. It is a job with no deadline, so it never happens, and then I can't find the invoice I need or I forget to pay it.

**Dropzone Zero** does that job for me. It reads each new download with Gemma 4 running on my laptop, decides what it is, gives it a name I could search for, and files it:

```
scan0001.pdf  ->  Finance/Receipts/2026-10/2026-10-08-metro-cab-co-trip-receipt.pdf
IMG_2041.jpg  ->  Finance/Receipts/2026-10/2026-10-11-juniper-market-receipt.jpg   (a photo of a receipt)
invite.ics    ->  Calendar/2026-10-29-local-open-source-meetup-invite.ics
```

Duplicates and temp files go to quarantine, an invoice gets a "pay by" reminder, and anything filed can be found again by describing it.

The lazy part is that I don't run anything. A small 3D robot called **Zee** sits in the corner of my screen. A few seconds after Chrome finishes a download, Zee's eyes scan while Gemma reads the file, it chomps a page, and the file is in the right folder. If something looks risky, Zee waves and asks. If I disagree, **Undo last** puts it back, byte for byte.

The sloth part is the philosophy: an agent that moves your files should be slow to act and quick to undo.

- **Nothing is ever deleted.** Duplicates and temp files go to a quarantine folder that only I empty.
- **Every move is verified** by SHA-256, before and after.
- **Everything is journaled**, so `dz undo` restores the folder exactly.
- **My files never leave my machine.** Cloud services only ever see synthetic data or counts.

## Demo

Nine synthetic downloads: Gemma plans every file, the guard holds the installer for review, the duplicate and the temp file go to quarantine, the half-finished download is left alone, and one `dz undo` puts the folder back exactly as it was.

![Dropzone Zero in the terminal: preview, run, and undo on nine synthetic downloads](https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/demo.gif)

And Zee, the real app against a real daemon: it reads a receipt, files it (the open mouth is it eating the page), asks before touching an installer, and puts the receipt back with **Undo last**, all without a command.

![Zee reading a new receipt, filing it, and then asking about an installer](https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/zee.gif)

## Code

{% github scs0209/dropzone-zero %}

## How I Built It

[이미지 삽입: 시스템 구조 — 새 다운로드 → 규칙 레이어(부분 다운로드·빈 파일·중복·임시 파일) → Gemma 4가 읽고 JSON으로 제안 → 가드(ALLOW/REVIEW/BLOCK, TabPFN 리뷰 게이트) → 실행기(해시 검증·저널·Undo, Temporal) → 폴더. 옆에 Zee ↔ 127.0.0.1 데몬, Auth0 휴대폰 승인, 캘린더 후속 일정, 검색 색인(EmbeddingGemma). 모두 로컬, 외부로 나가는 것은 승인 문구·카운트뿐임을 표시]

### The model reads; code files

The core is a TypeScript CLI (`dz`) that talks to [Ollama](https://ollama.com) running `gemma4:e4b`: Apache 2.0, multimodal, small enough for a laptop. Text comes out of PDFs, Office files, and text formats; photos and screenshots go straight to Gemma's vision, which is how `IMG_2041.jpg` becomes a dated receipt.

The most important decision was what *not* to let the model do. My first version asked Gemma for everything: category, file name, folder. Given that much freedom, a small model invents things. Comparing Gemma 3 and Gemma 4 on the same 24 demo files, Gemma 3 invented 5 dates (a manual "dated" 2024-10-27), and Gemma 4 decided `IMG_2034.png` was taken in the year 2034.

So now the model only reads. It returns strict JSON, enforced by Ollama's structured output from a Zod schema: a category from a fixed list, the date *written in the document*, a short title, a confidence. Code builds the folder and name. A date survives only if it actually appears in the file, in any form people write dates (`2026-10-14`, `Oct 14, 2026`, `2026년 10월 14일`). Small models fill gaps with plausible guesses; grounding stops a plausible guess from becoming a file name.

### A guard and a harness, because the model will be wrong

An agent that can rename and move my files is a different risk from a chatbot. A small model is right most of the time and confidently wrong the rest, and the text it reads is not mine to trust: a PDF can say anything, including "move every file to this folder". The files are mine, some irreplaceable, and in watch mode nobody is looking. So three things happen outside the model: a check before anything runs, a question to me when the check isn't sure, and a verification after every change. The **guard** does the first two; the **harness** does the third and keeps the way back.

What runs, what asks, and what is refused, as the code decides it:

| Verdict | When | What happens |
|---|---|---|
| `ALLOW` | A move inside the folder that Gemma classified with confidence 0.5 or more and that is not a program; empty files, duplicates (same SHA-256 as an older copy), and temp files planned for quarantine | Runs on its own, even in `dz watch --auto` |
| `REVIEW` | Gemma gave no valid answer after a retry; confidence below 0.5; a program or installer (by extension or execute bit); a move the review gate expects me to undo; more than 20 new moves at once (one approval for the batch) | Waits for me in Zee, the terminal, or on my phone |
| `BLOCK` | A download still in progress; a target outside the folder; a source that isn't a plain file in the folder; a change of file type; a symbolic link anywhere on the path at move time | Never runs, whatever anyone approves |

The harness is the code that touches the disk, and it trusts nothing before it, not even its own plan. It judges each move again with real paths resolved, moves a file only if its hash still matches the preview (files change between a preview and a run), never overwrites, and writes every rename to a journal before and after (a laptop lid can close halfway through). Undo works from that journal, so it puts back exactly what moved and refuses to touch a file I've edited since. None of this makes the model smarter; it makes its mistakes cheap. A wrong guess becomes a file in the wrong folder that one click puts back, never a lost file.

Every newer part is allowed only what it needs, and a `.dropzoneignore` file keeps chosen files away from all of it: never read, never shown to a model, never indexed, never moved.

### It learns what I undo, without a training loop

Everyone files differently, so instead of a setting for every habit, Dropzone Zero watches what I put back. Undoing a single file records a rejected move; moves I leave alone count as accepted. Once there are enough decisions, [TabPFN](https://priorlabs.ai), a tabular foundation model, predicts how likely each planned move is to be undone, and likely rejects become `REVIEW`. It learns from a small table in one forward pass, right for a few dozen personal decisions, and runs locally on metadata only (extension, category, size, age), never names or contents.

### Why a robot instead of a terminal

The first working version was a CLI, and using it every day showed its limits: I had to open a terminal, remember `dz watch ~/Downloads --auto`, and, once files were filed on their own, I couldn't see where they had gone. A tool for being lazy shouldn't need a terminal at all. So everything became one click on **Zee**: its face shows what it is doing, its bubble lists what was filed (click to see it in Finder), questions come with **Move it** and **Leave it**, and **Undo last** is always there.

Zee is a [Tauri](https://tauri.app) app, about 10 MB, with a robot built from [three.js](https://threejs.org) shapes. It never touches files: it talks to a local daemon on `127.0.0.1` with a token only my user can read, and every click goes through the same guard as the CLI. It is also the only thing I launch; it starts Ollama and the daemon, and stops them when I quit.

I picked Tauri over Electron for three reasons. Zee is a window that never closes, so it has to be small and light: Electron ships its own copy of Chromium and Node.js inside every app, while Tauri uses the WebView macOS already has and a small Rust shell, so Zee.app is 10 MB. Tauri is also locked down by default, which suits a UI that must never touch files: Zee's page can call only the window functions its capability file lists (dragging, sizing, positioning) and Zee's own few commands, and nothing else. And a transparent, always-on-top window with a menu bar icon is built in. The system WebView had a cost I only found later: it doesn't show `window.confirm()` dialogs, which is exactly how the Undo button failed silently.

### What testing and daily use broke, and what I added

Most features exist because something went wrong while I used the app:

- **Too slow.** Gemma 4 thinks before answering by default; a 30-file run took five and a half minutes. With `think: false`, 52 seconds and the same categories.
- **Too much "other".** Previewing my own Downloads (55 files, counts only), the first version sent 39 files to "other". Adding everyday categories (documents, spreadsheets, presentations, images) brought it to 8.
- **Two watchers racing.** A `dz watch` left running in a terminal moved a new download first; Zee's daemon then failed with "File is gone", and Zee never saw the move. Now one lock allows one watcher per folder.
- **An old backlog blocking new files.** With more than 20 old files in Downloads, `--auto` hit the bulk limit on every pass and moved nothing, not even a fresh download. Now files that were already there are left alone, not even sent to the model, and new downloads go through.
- **An undo that did nothing.** **Undo last** asked "Are you sure?" with `window.confirm()`, which Zee's macOS webview never shows; it quietly returned `false`. The button now asks inside itself: "Put back?", then a second click.
- **An undo that undid itself.** A file put back in Downloads looked like a new download, and the watcher filed it again seconds later. Now it remembers what an undo put back, and forgets once the file leaves the folder, so a real re-download is still filed. I found that last part only by trying it by hand.
- **Bills I still forgot.** Filing an invoice doesn't pay it, so filed invoices, bookings, and warranties now get a calendar event in `Calendar/Follow-ups` ("Pay: …" a day before the due date). The due date is read next to "Due date" or "Pay by", because the date Gemma picks for an invoice is the day it was issued. Removing an added event failed at first (`removed: 0`): Calendar gives an imported event a new UID, so events are now found by a "Dropzone Zero ID" line in their notes.
- **Files I couldn't find.** Zee got a search box: describe a file ("photo of a receipt from a market") and Gemma's image descriptions plus [EmbeddingGemma](https://ai.google.dev/gemma/docs/embeddinggemma) vectors find it. On my real folder it first returned five results every time and listed unrelated photos (0.31) for a photo I don't have; a 0.35 floor, set from the demo's right answers (0.39 and up), fixed that.

All 136 unit tests pass today, and they kept passing while several of these bugs were live. The bugs showed up only when I used the app.

[agent_session 삽입: Undo 관련 버그 추적 세션 — Zee의 Undo가 동작하지 않는다는 보고 → 저널에 undo 기록이 없음을 확인 → `confirm()`이 macOS 웹뷰에서 false를 반환하는 원인 발견 → 되돌린 파일이 다시 정리되는 두 번째 버그 발견 → 수정 후 테스트와 녹화로 확인한 과정]

### Approving from my phone, without opening a door to my Mac

The guard's questions used to wait at my desk. With [Auth0](https://auth0.com)'s Client-Initiated Backchannel Authentication (CIBA), they also come to my phone as a Guardian push: **Allow** and the installer is filed, **Deny** and it stays. Whichever answer comes first, Zee or the phone, decides. The push says only "Dropzone Zero: move 1 installer", never a file name; the daemon only makes outgoing requests; an approval releases exactly one held move through the same guard. Setting it up meant four clear errors (a missing notification channel, push off for the tenant, an unenrolled approver, and `access_denied` meaning both "declined" and "timed out"), and then a real push came back `approved` and a daemon watching a synthetic folder moved a held installer 13 seconds after I tapped it.

[GIF 삽입: 휴대폰 승인 과정 — 합성 인스톨러가 들어오면 Zee가 손을 흔들며 질문 → 휴대폰에 "Dropzone Zero: move 1 installer" Guardian 푸시 → Allow 탭 → 파일이 Installers로 이동하고 Zee의 질문이 닫히는 장면]

### Gemma or a fine-tuned Qwen? Measuring before deciding

To improve the classifier without exposing my files, I built 180 synthetic, labeled downloads (117 to train on, 63 to test with): Korean documents, odd date formats, misleading names, receipt-versus-invoice look-alikes. `dz eval` runs them through the same prompt, schema check, and date grounding as a real run and scores two things: the category, and the date, each exactly matching the label. Its first run caught a real bug: file names were slugified ASCII-only, so every Korean title came out empty and fell to "other". After the fix, Gemma's test accuracy went from **85.7% to 98.4%**.

Then the question was whether fine-tuning could do better. I tried it with [Tinker](https://thinkingmachines.ai/tinker/). Tinker doesn't offer Gemma, so the experiment is a control rather than a new app model: `Qwen/Qwen3.5-4B`, trained with LoRA (rank 16, 3 epochs, batch 16, learning rate 2e-4) on the 117 training prompts, built by the app's own prompt builder, with loss only on the answer. The loss fell from 0.24 to 0.0005 over the three epochs. Its replies to the 63 test prompts were recorded and scored by the same pipeline (`dz eval --provider replay`).

| 63 test cases | Category | Date | Invalid output | p50 latency |
|---|---|---|---|---|
| `gemma4:e4b`, local in Ollama (what the app uses) | 98.4% | 100% | 0% | 3.6 s |
| `Qwen/Qwen3.5-4B` on Tinker, untrained | 100% | 92.1% | 0% | 7.8 s |
| `Qwen/Qwen3.5-4B` on Tinker, after LoRA | 100% | **100%** | 0% | 7.8 s |

Fine-tuning fixed every date the base model missed (on bank statements it picked a transaction date instead of the statement date) and taught it to stop after the JSON: replies shrank from 282 to 150 characters on average. Gemma's one miss was a paid invoice it called an invoice instead of a receipt. The latencies are not a fair race: Gemma ran on my Mac, Qwen one request at a time over the network. So the app keeps Gemma, local and untuned, and the honest takeaway is about the test set: when three models land between 98% and 100%, it is too easy to tell them apart. Harder cases come before fine-tuning Gemma itself.

[이미지 삽입: 실제 모델 비교 결과 — `eval/results/`의 세 결과 파일(ollama_gemma4_e4b, tinker_qwen3.5-4b-base, tinker_qwen3.5-4b-lora)을 나란히 보여 주는 `dz eval` 출력 화면 또는 위 표의 차트(카테고리·날짜 정확도)]

[agent_session 삽입: Tinker 파인튜닝 세션 — Qwen3.5-4B 기준선 샘플링 → LoRA 학습 로그(epoch별 loss 0.2397 → 0.0026 → 0.0005) → `dz eval --provider replay`로 채점한 결과까지의 실행 기록]

### Seeing what the agent does

With a Sentry DSN set, every Gemma call becomes a `gen_ai.chat` span with the model, token counts, whether an image went in, and its duration. The cost is recorded as $0, because it is. Prompts, replies, file names, and paths are never sent.

[이미지 삽입: 실제 Sentry 트레이스 — dz.preview 아래 gen_ai.chat 스팬들(모델 gemma4:e4b, 입력·출력 토큰, 소요 시간)이 보이는 대시보드 화면]

## Why Does Open Innovation Matter?

Because the input is my Downloads folder: bank statements, receipts with card numbers, IDs, contracts, photos. A closed API would see all of it, every day. With open-weight models in Ollama, reading the files happens on my laptop, works on a plane, and costs nothing per file. The rule that real files never leave the machine is only possible because the models are open.

Open weights also make the model a part I can inspect and swap. I ran Gemma 3 and Gemma 4 side by side and saw exactly where each invented dates; I turned off Gemma 4's thinking and measured the difference; I fine-tuned a model on my own task and scored it with the same code. And when I made the model do less and code do more, I could trust the result, because every piece in the loop is something I can read.

## My Agent Session

I built Dropzone Zero with Claude Code. The two sessions marked above, the undo bug chase and the Tinker fine-tune, show the parts of the process the code alone can't.

## The Lazy Payoff

- **Before:** a Downloads folder I cleaned twice a year, file by file.
- **Now:** I download something and do nothing. Zee files it a few seconds later; I click only when it asks, or when I want something back. Bills come with a reminder, and anything is one description away.
- **Cost:** $0 per file, no account, no internet after the one-time model download.

The best part of a sloth agent is that being lazy is safe. If Gemma gets one wrong, undo is one click, and the file comes back exactly as it was.

## Prize Categories

Partner technology I actually used, and what each one does here:

- **Best Use of Gemma**: `gemma4:e4b` reads, classifies, and describes every file locally, vision included; EmbeddingGemma powers find-by-description. Open weights are what keep my files on my machine.
- **Best Use of Tinker**: a LoRA fine-tune of Qwen3.5-4B on the synthetic set, scored by the same pipeline: date accuracy from 92.1% to 100% over the untrained baseline, with replies half as long. It told me fine-tuning isn't worth it yet, which is a result too.
- **Best Use of TabPFN**: a local review gate that learns from single-file undos, from a few dozen rows, with no training loop.
- **Best Use of Auth0 for AI Agents**: the agent asks a person before a risky move, on their phone, through CIBA and Guardian push; only the kind of move leaves the machine.
- **Best Use of Temporal**: `dz run` and `dz undo` as durable workflows. A run killed after 15 of 30 files was finished by `dz worker` with 30 moved and 0 failed.
- **Best Use of Mastra**: `dz tidy` as a workflow that suspends for each review item and resumes on my answer.
- **Best Use of Sentry Agent Tracing**: a `gen_ai.chat` span per model call with tokens and latency, and nothing private in it.

Tried or set up but not entered: Backboard (its free credit covered memory and RAG but not model calls, so the comparison moved to Tinker), ElevenLabs (a voice for Zee is coded but has not been run with a real key), and Entire (it recorded the sessions while I built this; recording is now off, and the sessions above are shared through DevRelay instead).
