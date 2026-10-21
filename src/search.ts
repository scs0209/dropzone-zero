// Find a file by describing it: "the receipt from the coffee shop", "a photo of a
// beach at sunset". Every file gets a short text to search by: its words for a
// document, and for an image a one-sentence description written by Gemma's vision
// plus any text Gemma can read in it. Those texts and the question are turned into
// vectors by EmbeddingGemma, and the nearest files come back. It all runs in Ollama
// on this machine; the index lives in the folder's .dropzone and goes nowhere.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { z } from "zod";
import { readJsonReply, type ModelClient } from "./classify.js";
import { contentKindOf, extractContent } from "./extract.js";
import { loadIgnore } from "./ignore.js";
import { STATE_DIR } from "./plan.js";

export const SEARCH_INDEX = `${STATE_DIR}/search-index.jsonl`;
export const DEFAULT_EMBED_MODEL = "embeddinggemma";

export interface IndexEntry {
  /** Relative to the folder. */
  path: string;
  /** How the vector was made; an older one is re-embedded from the kept text. */
  v?: number;
  /** Size and modified time, so unchanged files are not read again. */
  stamp: string;
  kind: "document" | "image" | "other";
  /** What the vector was made from, kept so results can say why they matched. */
  text: string;
  vector: number[];
}

export interface SearchHit {
  path: string;
  score: number;
  /** A short piece of what the file was indexed by. */
  why: string;
}

/** Turns texts into vectors (Ollama /api/embed); tests pass a fake. */
export type Embed = (texts: string[]) => Promise<number[][]>;

export function ollamaEmbed(host = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434", model = process.env.DZ_EMBED_MODEL ?? DEFAULT_EMBED_MODEL): Embed {
  return async (texts) => {
    const response = await fetch(`${host.replace(/\/+$/, "")}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Kept loaded for a while (Ollama's default is 5 minutes), so the next search does not wait for it.
      body: JSON.stringify({ model, input: texts, keep_alive: "30m" }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      throw new Error(
        response.status === 404
          ? `The embedding model ${model} is not pulled. Run \`ollama pull ${model}\`.`
          : `Ollama returned HTTP ${response.status} for embeddings: ${(await response.text()).slice(0, 200)}`,
      );
    }
    return ((await response.json()) as { embeddings: number[][] }).embeddings;
  };
}

// EmbeddingGemma's own prompt formats for search: one for what is searched, one for the question.
const asDocument = (title: string, text: string) => `title: ${title} | text: ${text}`;

/** Bump when what goes into a vector changes, so old entries are re-embedded (not re-read). */
const INDEX_VERSION = 2;

// What kind of file it is, in words, so "an app", "the slides", or "a zip" can find it
// even when the file has no text of its own.
const KIND_WORDS: Record<string, string> = {
  ".app": "macOS app (application, program)",
  ".dmg": "installer disk image for an app",
  ".pkg": "installer package for an app",
  ".mpkg": "installer package for an app",
  ".exe": "Windows program installer",
  ".msi": "Windows installer",
  ".zip": "zip archive",
  ".tar": "archive",
  ".gz": "compressed archive",
  ".pdf": "PDF document",
  ".doc": "Word document",
  ".docx": "Word document",
  ".pages": "Pages document",
  ".txt": "text note",
  ".md": "text note",
  ".key": "Keynote presentation slides",
  ".ppt": "PowerPoint presentation slides",
  ".pptx": "PowerPoint presentation slides",
  ".numbers": "Numbers spreadsheet",
  ".xls": "Excel spreadsheet",
  ".xlsx": "Excel spreadsheet",
  ".csv": "spreadsheet table (CSV)",
  ".json": "data file (JSON)",
  ".ics": "calendar event",
  ".png": "image",
  ".jpg": "image (photo)",
  ".jpeg": "image (photo)",
  ".heic": "photo",
  ".gif": "animated image",
  ".webp": "image",
  ".svg": "vector graphic",
  ".mp4": "video",
  ".mov": "video",
  ".mp3": "audio",
  ".wav": "audio",
};

function kindWords(path: string): string {
  const ext = extname(path).toLowerCase();
  return KIND_WORDS[ext] ?? (ext ? `${ext.slice(1)} file` : "file");
}

/** The text a file's vector is made from: its name, what kind of file it is, where it is, and what it says. */
function documentFor(path: string, text: string): string {
  const where = dirname(path) === "." ? "" : ` in ${dirname(path)}`;
  return asDocument(titleOf(path), `${kindWords(path)}${where}. ${text}`.trim());
}
const asQuery = (query: string) => `task: search result | query: ${query}`;

const CaptionReply = z.object({ caption: z.string(), visibleText: z.string().default("") });
const CAPTION_SCHEMA = z.toJSONSchema(CaptionReply);

/** One sentence about an image, for finding it again later, from the local vision model. */
export async function describeImage(client: ModelClient, image: string): Promise<string> {
  const raw = await client.generate(
    `Describe this image so it can be found again by someone describing it from memory.
Reply with JSON only: {"caption", "visibleText"}.
- caption: one or two plain sentences: what it shows, the setting, notable objects, people (without guessing who), colors, and what kind of image it is (photo, screenshot, scan, drawing).
- visibleText: the most important text you can read in it, up to 200 characters, or "".`,
    [image],
    CAPTION_SCHEMA,
  );
  const reply = CaptionReply.safeParse(readJsonReply(raw));
  if (!reply.success) return "";
  return [reply.data.caption, reply.data.visibleText].filter(Boolean).join(" Text: ");
}

/** "2026-11-14-seaside-hotel-booking.pdf" -> "seaside hotel booking" */
function titleOf(path: string): string {
  return basename(path, extname(path)).replace(/^\d{4}-\d{2}-\d{2}-?/, "").replace(/[-_]+/g, " ").trim() || basename(path);
}

const BUNDLE = /\.(app|bundle|framework|pkg|mpkg|photoslibrary|xcodeproj|key|pages|numbers)$/i;

/**
 * Every file worth finding: everything except Dropzone Zero's own state, hidden
 * files, and what .dropzoneignore lists (never read, never shown to a model).
 */
async function filesIn(root: string, dir = root, ignored = loadIgnore(root)): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (ignored(relative(root, full))) continue;
    // An app or other macOS bundle is one thing to find, not hundreds of files inside it.
    if (entry.isDirectory() && BUNDLE.test(entry.name)) found.push(relative(root, full));
    else if (entry.isDirectory()) found.push(...(await filesIn(root, full, ignored)));
    else if (entry.isFile() && extname(entry.name).toLowerCase() !== ".ics") found.push(relative(root, full));
  }
  return found;
}

export async function loadIndex(inbox: string): Promise<IndexEntry[]> {
  try {
    return (await readFile(join(inbox, SEARCH_INDEX), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as IndexEntry);
  } catch {
    return [];
  }
}

async function saveIndex(inbox: string, entries: IndexEntry[]): Promise<void> {
  await mkdir(dirname(join(inbox, SEARCH_INDEX)), { recursive: true });
  await writeFile(join(inbox, SEARCH_INDEX), entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
}

export interface IndexOptions {
  client: ModelClient;
  embed: Embed;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Brings the index up to date: new and changed files are read (images described by
 * Gemma), vanished files are dropped, unchanged ones are kept as they are.
 */
export async function updateIndex(inbox: string, { client, embed, onProgress }: IndexOptions): Promise<{ indexed: number; total: number }> {
  const known = new Map((await loadIndex(inbox)).map((e) => [e.path, e]));
  const paths = await filesIn(inbox);
  const kept: IndexEntry[] = [];
  const stale: IndexEntry[] = [];
  const todo: { path: string; stamp: string }[] = [];
  for (const path of paths) {
    const info = await stat(join(inbox, path));
    if (info.isDirectory()) {
      // A bundle: found by its name and kind.
      const old = known.get(path);
      if (old?.v === INDEX_VERSION) kept.push(old);
      else todo.push({ path, stamp: "bundle" });
      continue;
    }
    const stamp = `${info.size}:${Math.round(info.mtimeMs)}`;
    const old = known.get(path);
    if (old && old.stamp === stamp && old.v === INDEX_VERSION) kept.push(old);
    else if (old && old.stamp === stamp) stale.push(old);
    else todo.push({ path, stamp });
  }
  // Unchanged files from an older index: only the vector is made again, from the kept text.
  if (stale.length) {
    const vectors = await embed(stale.map((e) => documentFor(e.path, e.text === titleOf(e.path) ? "" : e.text)));
    stale.forEach((e, i) => kept.push({ ...e, v: INDEX_VERSION, vector: vectors[i]! }));
  }
  const fresh: IndexEntry[] = [];
  for (const [i, { path, stamp }] of todo.entries()) {
    const full = join(inbox, path);
    const ext = extname(path).toLowerCase();
    const size = stamp === "bundle" ? 0 : (await stat(full)).size;
    const content = stamp === "bundle" ? null : await extractContent({ name: basename(path), path: full, ext, size, modifiedAt: new Date(), ageDays: 0, sha256: "", partial: false, executable: false }).catch(() => null);
    let kind: IndexEntry["kind"] = "other";
    let text = "";
    if (content?.image) {
      kind = "image";
      text = await describeImage(client, content.image).catch(() => "");
    } else if (content?.text) {
      kind = contentKindOf(ext) === "image" ? "image" : "document";
      text = content.text.replace(/\s+/g, " ").slice(0, 1200);
    }
    const [vector] = await embed([documentFor(path, text)]);
    fresh.push({ path, stamp, v: INDEX_VERSION, kind, text: text || titleOf(path), vector: vector! });
    onProgress?.(i + 1, todo.length);
    // Saved as it goes, so a long first index survives an interruption.
    if ((i + 1) % 10 === 0) await saveIndex(inbox, [...kept, ...fresh]);
  }
  await saveIndex(inbox, [...kept, ...fresh]);
  return { indexed: fresh.length, total: kept.length + fresh.length };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** The files that best match a description, best first. */
export async function search(inbox: string, query: string, embed: Embed, limit = 5): Promise<SearchHit[]> {
  const entries = (await loadIndex(inbox)).filter((e) => existsSync(join(inbox, e.path)));
  if (entries.length === 0 || !query.trim()) return [];
  const [q] = await embed([asQuery(query.trim())]);
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const ranked = entries
    .map((e) => {
      // A small nudge when the question's words are in the file's name.
      const name = e.path.toLowerCase();
      const named = words.filter((w) => name.includes(w)).length / Math.max(1, words.length);
      return { path: e.path, score: cosine(q!, e.vector) + 0.05 * named, why: e.text.slice(0, 140) };
    })
    .sort((a, b) => b.score - a.score);
  // Only what is close to the best match, and nothing when even the best is a poor one.
  // Measured: on the demo set the right answers scored 0.37-0.70; on a real Downloads
  // folder with no such file, unrelated photos scored up to 0.31 just for being photos.
  const [best, second] = ranked;
  if (!best) return [];
  if (best.score >= MIN_SCORE) return ranked.filter((hit) => hit.score >= MIN_SCORE && hit.score >= best.score - CLOSE_TO_BEST).slice(0, limit);
  // Files with little text of their own (an app, a scan) score lower; one that still
  // clearly beats everything else is the answer. Measured: an app asked for as "an app
  // I downloaded" scored 0.32 against 0.27 for the next file, while unrelated photos
  // for a missing receipt photo scored 0.31 and 0.29, no clear winner.
  if (best.score >= WINNER_FLOOR && best.score - (second?.score ?? 0) >= WINNER_MARGIN) return [best];
  return [];
}

const MIN_SCORE = 0.35;
const CLOSE_TO_BEST = 0.08;
const WINNER_FLOOR = 0.28;
const WINNER_MARGIN = 0.04;

/** A stable short id for a path, so the UI can ask to reveal a hit without sending a path back. */
export function hitId(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}
