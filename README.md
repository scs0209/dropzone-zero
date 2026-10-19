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

Requires Node.js 22.2 or newer and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm seed            # creates demo/inbox with 30 synthetic files
pnpm dz scan demo/inbox
```

## Commands

| Command | What it does |
|---|---|
| `dz scan [folder]` | Lists files with size, age, hash, and flags (partial download, empty, duplicate) |

More commands (`preview`, `run`, `undo`) are on the way.

## Demo data

`pnpm seed` builds a Downloads-style folder with 30 files: receipts, bookings, photos, manuals, exports, installers, temp files, and duplicates. Every name, company, and amount in it is fictional.

## License

[MIT](LICENSE)
