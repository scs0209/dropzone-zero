# Find a file by describing it

[← Back to the README](../../README.md)

```bash
pnpm dz find "photo of a receipt from a market"
pnpm dz find "the manual for the air conditioner" --reveal
```

Or type the same into the box at the top of Zee's bubble and click a result to see it in Finder.

Every file in the folder gets a short text to search by: a document's own words, and for an image a one- or two-sentence description written by Gemma's vision ("A scan or photo of a simple, printed receipt from a market…") plus any text Gemma can read in it. [EmbeddingGemma](https://ai.google.dev/gemma/docs/embeddinggemma) turns those texts, and your question, into vectors, and the nearest files come back, so "how much I spent on coffee" finds the Bluebird Coffee receipt without either word in its name. On the demo folder, seven test questions each put the right file first.

- **All local.** Captions and vectors come from Ollama on this machine; the index is `.dropzone/search-index.jsonl` in the folder and is never sent anywhere. Needs `ollama pull embeddinggemma` (about 0.6 GB) once.
- **Kept current.** `dz index` reads the folder (first time: about a second per document and a few per image); after that only new or changed files are read, and files that are gone drop out. Zee's daemon does this in the background, at start and after each run.
- **Only good matches.** Results close to the best match come back (a clear winner comes back alone), and nothing when even the best is a poor match (below 0.35; right answers on the demo scored 0.39 to 0.70). A search takes about 15 ms; it does not wait for indexing under way, and says so when one is.
- **Opens only what it found.** Zee asks the daemon to reveal a result by an id from the last search, never by a path.
