# Safety: the guard, the harness, and what each part can touch

[← Back to the README](../../README.md)

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

## How a run stays safe

- `dz run` executes exactly the plan you previewed. The model is not asked again, so what you saw is what happens.
- A file is skipped, not moved, if it changed since the preview, if its target already exists, or if the guard says no.
- Every move is a rename inside the same folder tree: no copy, no delete, and the file is never in two places or none. The journal records each move as "started" before the rename and "done" after the new location is hashed, so even a run interrupted mid-move can be undone.
- `dz undo` moves a file back only if it still has the hash it was moved with and its old place is free. If you edited a file after the run, undo leaves it where it is and tells you.

## What each part can touch

Every feature is limited to what it needs. Moves of your files always go through the guard and the hash-checked, journaled executor; the rest is listed here.

| Part | Reads | Changes | Leaves the machine |
|---|---|---|---|
| Filing (`dz run`, `dz watch --auto`, Zee) | New files in the folder (text, images to local Gemma) | Moves files inside the folder; duplicates and temp files go to quarantine, nothing is deleted | Nothing |
| Calendar follow-ups | Filed invoices, bookings, warranties | Writes `.ics` files to `Calendar/Follow-ups`; undo moves them to quarantine | Nothing |
| Calendar removal | Your Calendar, only events whose notes carry a Dropzone Zero ID and that you added from Zee | Deletes those events (AppleScript; macOS asks once) | Nothing |
| Search (`dz find`, Zee) | Every file in the folder (images described by local Gemma) | Writes `.dropzone/search-index.jsonl` | Nothing |
| Phone approval (Auth0, optional) | Nothing | Releases exactly one held move | A short label such as "move 1 installer" |
| Voice (ElevenLabs, optional) | Nothing | Nothing | A sentence of kinds and counts, such as "Filed two receipts" |
| Telemetry (Sentry, optional) | Nothing | Nothing | Counts, timings, token counts, scrubbed errors |

**Keeping files out entirely.** List them in a `.dropzoneignore` file in the folder, and Dropzone Zero never reads them, never shows them to a model, never indexes them for search, and never moves them:

```
# .dropzoneignore
*.key          # by name, in any folder
passport*      # names starting with "passport"
Taxes/         # a folder and everything in it
Scans/*.pdf    # a path from the top of the folder
```

`DZ_SEARCH=off` turns search off altogether: nothing is read or described for it.

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
