---
title: Dropzone Zero: a local Gemma agent files every download, asks before anything risky, and undoes it all in one click
published: false
tags: devchallenge, hf26challenge, ai, opensource
cover_image: https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/cover.png
---

*This is a submission for the [Hacktoberfest Open-Source AI Challenge Week 3: Slow and Steady](https://dev.to/challenges/hacktoberfest-week3-2026-10-19)*

Confession: I don't tidy my desktop. I don't tidy my folders either. Files land, and they stay. Every now and then I decide to clean up. Open the first file, figure out what it is, rename it, drag it somewhere, open the next one... It always takes way longer than I expect, so I give up and put it off again.

So what I wanted wasn't a better way to clean up. I wanted to never clean up again, by rules I set once, and without handing my files to something I can't see inside.

That became **Dropzone Zero**. A few seconds after a download finishes, a small robot in the corner of my screen eats it 🤖, and the file shows up in the right folder with a name I can actually search for. Gemma 4 does the reading, locally on my Mac. If anything looks risky, it asks me first. And if I don't like what it did, **Undo last** puts it back exactly as it was.

## What I Built

Here's the kind of stuff that piles up in my Downloads: receipts I'll need at tax time, a hotel confirmation for next month, three copies of the same PDF, an installer I already ran, `scan0001.pdf`, `export (1).csv`. Then one day I need that one invoice, and I can't find it. Or I forget to pay it.

Dropzone Zero reads each new file with `gemma4:e4b` in Ollama, figures out what it is, names it, and files it:

```
scan0001.pdf  ->  Finance/Receipts/2026-10/2026-10-08-metro-cab-co-trip-receipt.pdf
IMG_2041.jpg  ->  Finance/Receipts/2026-10/2026-10-11-juniper-market-receipt.jpg   (a photo of a receipt)
invite.ics    ->  Calendar/2026-10-29-local-open-source-meetup-invite.ics
```

Duplicates and temp files go to a quarantine folder that only I empty, because nothing ever gets deleted. Invoices get a "pay by" reminder. And I can find anything later just by describing it.

The "slow and steady" part is how I think about any agent that touches my files: slow to act, quick to undo.

## Demo

First the CLI, on nine synthetic downloads. Gemma plans every file, the installer is held for review, the duplicate and the temp file go to quarantine, the half-finished download is left alone, and one `dz undo` puts the whole folder back.

![Dropzone Zero in the terminal: preview, run, and undo on nine synthetic downloads](https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/demo.gif)

And this is how I actually use it. That's Zee, the real app talking to a real daemon. It reads a receipt, files it (the open mouth is it eating the page 😄), asks before touching an installer, and puts the receipt back when I click **Undo last**. No terminal anywhere.

![Zee reading a new receipt, filing it, and then asking about an installer](https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/zee.gif)

## Code

{% github scs0209/dropzone-zero %}

## How I Built It

The core is a TypeScript CLI called `dz` that talks to [Ollama](https://ollama.com) running `gemma4:e4b`. I picked it because it's Apache 2.0, it can see images, and it runs fine on a laptop. Text comes out of PDFs, Office files, and plain text. Photos and screenshots go straight to Gemma's vision, which is how a phone photo called `IMG_2041.jpg` turns into a dated receipt.

Here's the path one download takes:

```
new download → rules: still downloading? empty? duplicate? temp?
             → Gemma 4 (local) reads it → strict JSON: kind, printed date, title, confidence
             → code builds the name and folder; a date stays only if it is printed in the file
             → guard: ALLOW · REVIEW (Zee or phone) · BLOCK, plus TabPFN: "will I undo this?"
             → harness: re-check, hash, rename, hash again, journal → undo from the journal
```

It didn't start out like this, though.

### My small model was a confident liar

My first version just asked Gemma for everything: what the file is, its name, its folder, its date. I ran Gemma 3 and Gemma 4 on the same 24 demo files and read every single answer. The kinds were mostly fine. The dates were not.

- `AC-X200_manual.pdf`: Gemma 3 said **2024-10-27**, with 0.95 confidence. There's no date anywhere in that manual.
- `notes.txt` and `router_quick_start.pdf`: both **2024-01-01**, also 0.95.
- `IMG_2034.png`, `IMG_2035.png`, `IMG_2036.png`: Gemma 4 decided these were from the years **2034, 2035, and 2036**. It read the numbers in the file names as years. 🙃

Gemma 3 made up 5 dates out of 24. And once a made-up date is in a file name, it's worse than no date at all, because I'd trust it.

So I took the job away from the model. Now it only reads. It answers in strict JSON (Ollama's structured output, from a Zod schema): a kind from a fixed list, the date that's *printed in the document*, a short title, and a confidence. My code builds the folder and the name. And a date only survives if it really appears in the file, in whatever form people write dates (`2026-10-14`, `Oct 14, 2026`, `2026년 10월 14일`).

One more thing I learned here. Gemma 4 thinks before it answers by default, and a 30-file run took five and a half minutes. With `think: false` it took 52 seconds, with the same answers. Reading one file just isn't a thinking problem.

### Allow, ask, or block

An agent that renames and moves my files is a different kind of risk from a chatbot. The model is confidently wrong sometimes, as you just saw. The text it reads isn't mine to trust either: a PDF can say anything, including "move every file to this folder". The files are mine, some of them I can't get back, and in watch mode nobody is looking.

So everything important happens outside the model. A **guard** checks each move before it runs and asks me when it isn't sure. Here's what it actually decides, straight from `guard.ts` and `rules.ts`:

| Verdict | When | What happens |
|---|---|---|
| `ALLOW` | A move inside the folder, classified with confidence 0.5 or more, not a program; empty files, duplicates (same SHA-256 as an older copy), and temp files going to quarantine | Runs on its own, even in `dz watch --auto` |
| `REVIEW` | No valid answer after a retry; confidence below 0.5; a program or installer (by extension or execute bit); a move TabPFN expects me to undo; more than 20 new moves at once (one approval for the batch) | Waits for me in Zee, the terminal, or on my phone |
| `BLOCK` | A download still in progress; a target outside the folder; a source that isn't a plain file in it; a change of file type; a move into a hidden folder; a symbolic link anywhere on the path | Never runs, whatever anyone approves |

Then the **harness**, the code that actually touches the disk, doesn't trust anything before it, not even its own plan. It judges each move again with the real paths, only moves a file if its hash still matches the preview, never overwrites, and writes every rename to a journal before and after (a laptop lid can close halfway through). Undo reads that journal, so it puts back exactly what moved, and it won't touch a file I've edited since.

None of this makes Gemma smarter. It just makes its mistakes cheap. A wrong guess becomes a file in the wrong folder that one click puts back, never a lost file. And anything I list in a `.dropzoneignore` file is never read, never shown to a model, and never moved.

There's one more reason to ask, and it learns from me. When I undo a single file, that's a "wrong move". Moves I leave alone count as fine. Once there are enough of those decisions, [TabPFN](https://priorlabs.ai) looks at that small table and predicts, in one forward pass, how likely I am to undo each new move. The likely ones become `REVIEW`. A few dozen personal decisions is way too little data to train a model on, which is exactly why I liked TabPFN for this: no training loop at all. It runs locally, and it only sees metadata (extension, kind, size, age), never names or contents.

### Why a robot, and why Tauri

The first working version was a CLI. Using it every day, I noticed the problem pretty fast: open a terminal, remember `dz watch ~/Downloads --auto`, and once files started moving on their own, I had no idea where they went. A tool for being lazy shouldn't need a terminal.

So everything became one click on **Zee**, a little robot made from [three.js](https://threejs.org) shapes. Its face shows what it's doing. Its speech bubble lists what it filed, and clicking one opens it in Finder. Questions come with **Move it** and **Leave it** buttons, and **Undo last** is always there. Zee is also the only thing I ever launch: it starts Ollama and the background daemon, and stops them when I quit.

When I hide Zee, it doesn't just blink out of existence. It dives into a hole in the ground, and pops back out when I call it:

![Zee diving into a hole in the ground and popping back out](https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/zee-dive.gif)

I went with [Tauri](https://tauri.app) instead of Electron. Zee is a window that never closes, so it has to be light. Electron ships its own Chromium and Node.js inside every app. Tauri uses the WebView macOS already has, so Zee.app is 10 MB. Tauri is also locked down by default, which is what I want for a UI that should never touch files. Zee's page can only call the window functions its capability file lists plus a few commands of its own, and it talks to the daemon on `127.0.0.1` with a token only my user can read. That system WebView came back to bite me later, though.

### What actually broke

Honestly, the unit tests (142 of them now) passed through most of this. Using the app every day is what found the bugs.

**39 of 55 files went to "other".** I previewed my real Downloads folder (counts only) and the category list was just too narrow. Adding documents, spreadsheets, presentations, and images brought "other" down to 8.

**Two watchers fought over one file.** I'd left a `dz watch` running in a terminal. It moved a new download first, then Zee's daemon failed with "File is gone" and never showed the move. Now there's a lock: one watcher per folder.

**Old files blocked new ones.** With more than 20 old files sitting in Downloads, `--auto` hit the bulk limit on every pass and moved nothing, not even the file I'd just downloaded. Now files that were already there are left alone (they're not even sent to the model), and new downloads go through.

**Zee shook while I resized it.** Dragging the speech bubble's corner made the whole robot wobble, because the window was being resized on every move. Now the window stays put while you drag, and only the bubble changes size inside it.

**Undo last did nothing.** I'd click it, and... nothing. The journal had no undo entries at all, which was the clue. The button asked "Are you sure?" with `window.confirm()`, and the macOS WebView that Tauri uses never shows that dialog. `confirm()` just quietly returned `false`. Now the button asks by itself: the first click turns it into "Put back?", the second click does it.

**Then undo undid itself.** Fixed that, clicked Undo, the receipt went back to Downloads... and a few seconds later the watcher filed it again, because it looked like a new download. 😅 Now the watcher remembers what an undo put back. It also forgets once the file leaves, so a real re-download still gets filed. I only found that last part by trying it by hand.

**My rules were stuck in the code.** "Where each kind of file goes" lived in a table in TypeScript, so changing it meant editing code. Now a `.dropzonerules.json` in the folder can set any kind's folder and name, like `{ "receipt": { "folder": "Money/Receipts/{year}", "name": "{title}-{date}" } }`. A rule only picks a path, though. The guard still judges every move, and a rule that points outside the folder or into a hidden one stops the run with a message instead of being quietly ignored.

**I still forgot to pay bills.** Filing an invoice doesn't pay it. So invoices, bookings, and warranties now get a calendar event in `Calendar/Follow-ups` ("Pay: …" a day before it's due). The due date is read from the text next to "Due date" or "Pay by", since the date Gemma picks for an invoice is the day it was issued. Removing an event from the calendar didn't work at first: `removed: 0`. It turns out Calendar gives an imported event a brand new UID. It does keep the notes, though, so every event now carries a "Dropzone Zero ID" line there, and that's how I find it.

**I couldn't find things.** So Zee got a search box. You describe a file ("photo of a receipt from a market"), and Gemma's image descriptions plus [EmbeddingGemma](https://ai.google.dev/gemma/docs/embeddinggemma) vectors find it. On my real folder, though, it gave me five results for everything, and when I searched for a photo I don't even have, it happily showed me unrelated photos (scored 0.31). The right answers on the demo had all scored 0.39 or higher, so a 0.35 floor fixed it.

### Approving from my phone, without opening a door to my Mac

Zee's questions used to wait at my desk. With [Auth0](https://auth0.com)'s Client-Initiated Backchannel Authentication (CIBA), they also come to my phone as a Guardian push. **Allow**, and the installer is filed. **Deny**, and it stays. Whichever answer comes first, Zee or the phone, wins.

I was careful about what leaves the Mac. The push only says "Dropzone Zero: move 1 installer", never a file name. The daemon only makes outgoing requests, so nothing can reach in. And one approval releases exactly one held move, through the same guard.

Setting it up took a few tries. I hit four errors one after another: a missing notification channel, push turned off for the tenant, an approver who wasn't enrolled, and `access_denied`, which turns out to mean both "declined" and "timed out". After that, a daemon watching a synthetic folder moved a held installer 13 seconds after I tapped **Allow**. 🎉

![The Auth0 Guardian approval on my phone: "Dropzone Zero: move 1 installer", with Deny and Approve buttons; the account and tenant are covered](https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/phone-approval.png)

*The real push for a synthetic installer. My phone is in Korean: 거부 is Deny, 승인 is Approve. I covered my account and tenant. I wanted a GIF here, but Guardian blanks the screen while you're screen recording, so it's a screenshot.*

### Gemma or a fine-tuned Qwen?

To improve the classifier without using my real files, I made 180 synthetic, labeled downloads (117 to train on, 63 to test): Korean documents, weird date formats, misleading names, receipts that look like invoices. `dz eval` runs them through the exact same prompt, schema, and date check as a real run, and scores the kind and the date.

The very first eval run caught a real bug. File names were slugified ASCII-only, so every Korean title came out empty and fell into "other". After fixing that, Gemma went from **85.7% to 98.4%**.

Then I wanted to try fine-tuning with [Tinker](https://thinkingmachines.ai/tinker/). Tinker doesn't offer Gemma, so Claude Code went ahead with `Qwen/Qwen3.5-4B` instead... and halfway through I stopped and asked: wait, my app runs Gemma, so why are we fine-tuning Qwen? Fair question. So I turned it into a control experiment: same prompts, same scoring, and the question is just "is fine-tuning worth it for this task at all?"

The setup: LoRA (rank 16, 3 epochs, batch 16, learning rate 2e-4) on the 117 training prompts, built by the app's own prompt code, with loss only on the answer. The loss went from 0.24 to 0.0005. The replies to the 63 test prompts went through the same scoring (`dz eval --provider replay`).

| 63 test cases | Kind | Date | Invalid output | p50 latency |
|---|---|---|---|---|
| `gemma4:e4b`, local in Ollama (what the app uses) | 98.4% | 100% | 0% | 3.6 s |
| `Qwen/Qwen3.5-4B` on Tinker, untrained | 100% | 92.1% | 0% | 7.8 s |
| `Qwen/Qwen3.5-4B` on Tinker, after LoRA | 100% | **100%** | 0% | 7.8 s |

Fine-tuning fixed every date the base model missed (on bank statements, it kept picking a transaction date instead of the statement date). It also taught Qwen to stop after the JSON: untrained, it kept writing, and the average reply shrank from 282 to 150 characters. Gemma's only miss was a paid invoice it called an invoice instead of a receipt. Latency isn't a fair race here, by the way: Gemma ran on my Mac, Qwen one request at a time over the network.

So... the app keeps Gemma, untuned. Reading one document and naming its kind and date is short, well-defined work. That's also why turning thinking off changed nothing. A tuned remote model would buy a point or two, and my files would have to leave my laptop. The real lesson was about my test set: when three models all land between 98% and 100%, it's too easy to tell them apart.

I want to say something about Tinker, though, because it honestly surprised me. Fine-tuning always sounded like a whole project to me: rent GPUs, set up a training stack, babysit a run. Here the whole experiment is one 108-line Python script. Create a LoRA training client, call `forward_backward` and `optim_step` for each batch, save the weights, sample from the tuned model. I never touched a GPU. My first run did hit a 402 until I added credit to my account, but after that it just worked. Writing the evaluation took me longer than writing the training.

Here's the run, as my terminal printed it:

![The Tinker run in a terminal: base sampling, three LoRA epochs with loss 0.2397, 0.0026, 0.0005, then the replay scoring at 100% and 100%](https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/tinker-run.png)

And Tinker's own dashboard shows the same run: one training run on Qwen3.5-4B with LoRA rank 16, and 24 training steps. That checks out: 117 cases in batches of 16 is 8 steps, three times over. The whole session cost an estimated $0.15, 95% of it training, and sampling the untrained baseline in a second session added $0.01. Not bad for my first fine-tune. 😄

![Tinker's session details: $0.15 estimated, 95.3% of it training, one training run on Qwen/Qwen3.5-4B with LoRA rank 16, and a training-steps chart that climbs to 24](https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/tinker-session.png)

![Document type and date accuracy for gemma4:e4b, untrained Qwen3.5-4B, and Qwen3.5-4B after LoRA, on the same 63 synthetic test files](https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/model-compare.png)

### Seeing what the agent does

If I set a Sentry DSN, every Gemma call becomes a `gen_ai.chat` span with the model, token counts, whether an image went in, and how long it took. The cost is recorded as $0, because it is. Prompts, replies, file names, and paths are never sent.

Here's one preview of the 31 demo files: 25 model calls (rules handled the other six), and the Input tab is empty because no prompt is stored.

![A Sentry trace of one dz.preview run on the synthetic demo files: 25 gen_ai.chat spans for gemma4:e4b, one selected with its token counts and no prompt stored](https://raw.githubusercontent.com/scs0209/dropzone-zero/main/docs/media/sentry-trace.png)

### What it can't do yet

A photographed receipt works fine, because Gemma's vision reads it. But a scanned PDF with no text layer only gets classified by its name and size, and a photographed invoice gets no due-date reminder, since the due date is read from text. And as I said above, my test set is too easy. I need messier documents before fine-tuning Gemma itself would make sense.

## Why Does Open Innovation Matter?

For me it comes down to one thing: my files stay mine. The input here is my Downloads folder, so bank statements, receipts with card numbers, IDs, contracts, photos. A closed API would see all of that, every day. With open weights in Ollama, the reading happens on my laptop. It works on a plane, and it costs nothing per file. "Real files never leave the machine" is only possible because the models are open.

It also meant I could open up every part and look inside. I ran Gemma 3 and Gemma 4 side by side and saw exactly which dates each one invented. I turned off Gemma 4's thinking and measured what changed. I fine-tuned a model on my own task and scored it with my own code. When I made the model do less and my code do more, I could trust the result, because every piece in the loop is something I can read.

## My Agent Session

I built Dropzone Zero with Claude Code, and [Entire](https://entire.io) recorded the sessions and linked each one to its commit: 73 of the 92 commits carry an `Entire-Checkpoint:` trailer. The records are in a private repository because they also include local paths and account names.

Two sessions are shared below, because they show what the code alone can't: how each problem was found. Both were long sessions, so I cut each one down to its episode. Tool outputs are removed, so you'll see my prompts, the agent's replies, and the commands it ran. My prompts were in Korean, so each one is shown in English first, then in Korean. I redacted local paths and account names.

### 1. "What does the Undo last button do?", then "It didn't work, though?"

Zee's **Undo last** did nothing when I clicked it. The agent started with the real journal and daemon log (counts only, paths redacted) and found no undo entries at all, so the click never reached the code that moves files. The only dialog in Zee's page was a `window.confirm()`, which the macOS WebView that Tauri uses never shows. It replaced it with a two-click button inside the bubble: "Put back?", then a second click within 4 seconds.

Then it recorded the real UI against a real daemon to check. Undo ran, but the receipt was not back in the folder: the watcher had taken the put-back file for a new download and filed it again. The agent made the watcher remember what an undo put back, added a regression test, ran the whole suite, and recorded again to confirm the receipt stays put.

Commit: [b22e1c1](https://github.com/scs0209/dropzone-zero/commit/b22e1c1) "make Zee's Undo last work, and keep undone files where they are"

<!-- TODO: embed this session with the agent_session tag (file: undo-bug.jsonl) -->

### 2. "Don't either of them have a free tier?", then "We use Gemma, so why fine-tune Qwen?"

The agent checked Backboard and Tinker for a way to run a fine-tuned comparison. Both have free perks, but neither could pay for model calls on my account yet. Backboard's free credit was reserved for memory and RAG, and a test call to a paid Gemma model through it was refused. I put credit into Tinker and told it to go ahead, and I dropped Backboard.

Tinker doesn't offer Gemma, so the agent had picked Qwen3.5-4B without telling me first. When I asked why we were tuning Qwen, it said so, and I made it a control experiment. It sampled the untrained Qwen on the 63 test cases (kind 100%, date 92.1%), trained the LoRA, and added a `replay` provider to `dz eval` so the replies were scored by the app's own pipeline. It also pointed out that models landing near 100% means my test set is too easy to tell them apart. That became the honest finding in the post.

Commit: [5c886f0](https://github.com/scs0209/dropzone-zero/commit/5c886f0) "fine-tune a control model on Tinker; drop Backboard"

<!-- TODO: embed this session with the agent_session tag (file: tinker-finetune.jsonl) -->

## The Lazy Payoff

Before: a Downloads folder I never cleaned.

Now: I download something and do nothing. A few seconds later Zee has filed it. I only click when it asks, or when I want something back. Bills come with a reminder, and anything I need is one description away.

Cost: $0 per file, no account, and no internet after the one-time model download.

And the best part is that being lazy is actually safe here. If Gemma gets one wrong, it's one click to undo, and the file comes back exactly as it was.

## Prize Categories

- **Best Use of Gemma**: `gemma4:e4b` reads, classifies, and describes every file locally, vision included; EmbeddingGemma powers find-by-description.
- **Best Use of Tinker**: a LoRA on Qwen3.5-4B, scored by the app's own pipeline: date accuracy 92.1% → 100%, replies half as long, and the evidence that the app doesn't need it yet.
- **Best Use of TabPFN**: a local review gate that learns from single-file undos, with no training loop.
- **Best Use of Auth0 for AI Agents**: risky moves are approved on my phone through CIBA and Guardian push; only the kind of move leaves the machine.
- **Best Use of Temporal**: durable `dz run` and `dz undo`. A run killed after 15 of 30 files was finished by `dz worker`: 30 moved, 0 failed.
- **Best Use of Mastra**: `dz tidy` as a workflow that suspends for each review item and resumes on my answer.
- **Best Use of Sentry Agent Tracing**: a `gen_ai.chat` span per model call with tokens and latency, and nothing private in it.
- **Best Use of Entire**: Entire recorded the Claude Code sessions I built this with, as checkpoints pushed to a separate repo, so the undo bug chase and the Tinker run above can be traced back to the conversations that produced them.

I also tried a couple of things I didn't enter. Backboard's free credit covered memory and RAG but not model calls, so the model comparison moved to Tinker. And a voice for Zee with ElevenLabs is coded, but I haven't run it with a real key yet.

## Credits

The code is MIT licensed. Zee is drawn in code with [three.js](https://threejs.org) (MIT), and the test files, the receipt photo, and the app icon are generated by scripts in the repo, so there is no borrowed artwork or data. It runs on open models and tools: Gemma 4 and EmbeddingGemma from Google, Qwen3.5-4B from the Qwen team, [Ollama](https://ollama.com), and [Tauri](https://tauri.app).

**Built with PriorLabs-TabPFN.** The review gate uses the TabPFN v2 weights under the [Prior Labs License](https://huggingface.co/Prior-Labs/TabPFN-v2-clf/blob/main/LICENSE.txt), which asks for this notice wherever the work is made available.
