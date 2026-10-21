// Zee's voice (optional, ElevenLabs). Zee says what it just did, "Filed 2
// downloads: a receipt and a photo.", or that it needs an OK. Only the counts and
// kinds of files are sent to ElevenLabs, never a file name, path, or content.
//
// Each sentence is turned into speech once and kept in ~/.dropzone-zero/voice, so
// the phrases Zee repeats cost nothing after the first time and play offline.
// Off unless DZ_VOICE=on and ELEVENLABS_API_KEY are set.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { categoryOfTarget, type Category } from "./classify.js";
import { QUARANTINE_DIR } from "./plan.js";

// "George", one of ElevenLabs' default voices; ELEVENLABS_VOICE_ID picks another.
const DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb";
// Fast and inexpensive, and short sentences are all Zee says.
const DEFAULT_MODEL = "eleven_flash_v2_5";

const NOUN: Partial<Record<Category, string>> = { temp: "temp file", other: "file", calendar: "calendar invite" };
const noun = (category: Category | null) => (category ? (NOUN[category] ?? category) : "file");
const plural = (word: string) => (word.endsWith("s") ? word : `${word}s`);
const NUMBERS = ["no", "a", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const count = (n: number, word: string) => (n === 1 ? `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}` : `${NUMBERS[n] ?? n} ${plural(word)}`);

function list(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** What Zee says after filing: kinds and counts only. */
export function spokenSummary(moves: { to: string }[]): string {
  if (moves.length === 0) return "";
  const kinds = new Map<string, number>();
  for (const move of moves) {
    const kind = move.to.startsWith(`${QUARANTINE_DIR}/`) ? "duplicate or temp file" : noun(categoryOfTarget(move.to));
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  const what = list([...kinds].sort((a, b) => b[1] - a[1]).map(([kind, n]) => count(n, kind)));
  return moves.length === 1 ? `Filed ${what}.` : `Filed ${count(moves.length, "download")}: ${what}.`;
}

/** What Zee says when it needs an answer. */
export function spokenQuestion(kinds: (Category | null)[]): string {
  return kinds.length === 1 ? `I need your OK on ${count(1, noun(kinds[0] ?? null))}.` : `I need your OK on ${count(kinds.length, "file")}.`;
}

export interface VoiceConfig {
  apiKey: string;
  voiceId?: string;
  modelId?: string;
  cacheDir?: string;
}

export function voiceFromEnv(env: NodeJS.ProcessEnv = process.env): VoiceConfig | null {
  if (env.DZ_VOICE !== "on" || !env.ELEVENLABS_API_KEY?.trim()) return null;
  return { apiKey: env.ELEVENLABS_API_KEY.trim(), voiceId: env.ELEVENLABS_VOICE_ID?.trim() || undefined, modelId: env.ELEVENLABS_MODEL?.trim() || undefined };
}

const afplay = (file: string) =>
  new Promise<void>((resolve, reject) => execFile("afplay", [file], (error) => (error ? reject(error) : resolve())));

export class Voice {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: VoiceConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly play: (file: string) => Promise<void> = afplay,
  ) {}

  /** The speech for `text`, from the cache or from ElevenLabs. */
  async audioFor(text: string): Promise<string> {
    const voice = this.config.voiceId ?? DEFAULT_VOICE;
    const model = this.config.modelId ?? DEFAULT_MODEL;
    const dir = this.config.cacheDir ?? join(homedir(), ".dropzone-zero", "voice");
    const file = join(dir, `${createHash("sha256").update(`${voice}\n${model}\n${text}`).digest("hex").slice(0, 32)}.mp3`);
    if (existsSync(file)) return file;
    const response = await this.fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": this.config.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: model }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`ElevenLabs returned HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    await mkdir(dir, { recursive: true });
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
    return file;
  }

  /** Says `text` after anything already being said. Failures are logged, never thrown: a voice is a nicety. */
  say(text: string): Promise<void> {
    if (!text) return this.queue;
    this.queue = this.queue.then(async () => {
      try {
        await this.play(await this.audioFor(text));
      } catch (error) {
        console.error(`Zee could not speak: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    return this.queue;
  }
}
