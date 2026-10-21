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
import { STATE_DIR } from "./plan.js";

export const SEARCH_INDEX = `${STATE_DIR}/search-index.jsonl`;
export const DEFAULT_EMBED_MODEL = "embeddinggemma";

export interface IndexEntry {
  /** Relative to the folder. */
  path: string;
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
      body: JSON.stringify({ model, input: texts }),
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

/** Every file worth finding: everything except Dropzone Zero's own state and hidden files. */
async function filesIn(root: string, dir = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesIn(root, full)));
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
  const todo: { path: string; stamp: string }[] = [];
  for (const path of paths) {
    const info = await stat(join(inbox, path));
    const stamp = `${info.size}:${Math.round(info.mtimeMs)}`;
    const old = known.get(path);
    if (old && old.stamp === stamp) kept.push(old);
    else todo.push({ path, stamp });
  }
  const fresh: IndexEntry[] = [];
  for (const [i, { path, stamp }] of todo.entries()) {
    const full = join(inbox, path);
    const ext = extname(path).toLowerCase();
    const size = (await stat(full)).size;
    const content = await extractContent({ name: basename(path), path: full, ext, size, modifiedAt: new Date(), ageDays: 0, sha256: "", partial: false, executable: false }).catch(() => null);
    let kind: IndexEntry["kind"] = "other";
    let text = "";
    if (content?.image) {
      kind = "image";
      text = await describeImage(client, content.image).catch(() => "");
    } else if (content?.text) {
      kind = contentKindOf(ext) === "image" ? "image" : "document";
      text = content.text.replace(/\s+/g, " ").slice(0, 1200);
    }
    const title = titleOf(path);
    const [vector] = await embed([asDocument(title, `${dirname(path)} ${text}`.trim())]);
    fresh.push({ path, stamp, kind, text: text || title, vector: vector! });
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
  return entries
    .map((e) => {
      // A small nudge when the question's words are in the file's name.
      const name = e.path.toLowerCase();
      const named = words.filter((w) => name.includes(w)).length / Math.max(1, words.length);
      return { path: e.path, score: cosine(q!, e.vector) + 0.05 * named, why: e.text.slice(0, 140) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** A stable short id for a path, so the UI can ask to reveal a hit without sending a path back. */
export function hitId(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}
