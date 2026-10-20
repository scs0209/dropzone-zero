import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { classifyFile, type Category, type ModelClient } from "./classify.js";
import { contentKindOf } from "./extract.js";
import type { ScannedFile } from "./scan.js";

// `dz eval`: runs the real classification pipeline (prompt, schema, validation,
// date grounding) over the synthetic labeled cases in eval/cases.jsonl, so models
// and prompts are compared on the same footing as what users get.

export interface EvalCase {
  id: string;
  split: "train" | "test";
  name: string;
  text: string;
  expected: { category: Category; date: string | null };
  tags: string[];
}

export interface CaseResult {
  id: string;
  tags: string[];
  expected: EvalCase["expected"];
  got: { category: Category; date: string | null };
  categoryOk: boolean;
  dateOk: boolean;
  /** The model never produced valid output (fallback after a retry). */
  invalid: boolean;
  ms: number;
}

export interface EvalReport {
  model: string;
  split: string;
  cases: number;
  categoryAccuracy: number;
  dateAccuracy: number;
  invalidRate: number;
  latencyMs: { p50: number; p95: number };
  byTag: Record<string, { cases: number; categoryAccuracy: number }>;
  results: CaseResult[];
}

export async function loadCases(path: string, split: "train" | "test" | "all"): Promise<EvalCase[]> {
  const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
  const cases = lines.map((line) => JSON.parse(line) as EvalCase);
  return split === "all" ? cases : cases.filter((c) => c.split === split);
}

/** A ScannedFile stand-in for a case: same name, fixed date, so results do not depend on when they run. */
export function caseFile(c: EvalCase): ScannedFile {
  return {
    name: c.name,
    path: join("/eval", c.name),
    ext: extname(c.name).toLowerCase(),
    size: Buffer.byteLength(c.text),
    modifiedAt: new Date("2026-10-20T12:00:00Z"),
    ageDays: 0,
    sha256: "0".repeat(64),
    partial: false,
    executable: false,
  };
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;

export function summarizeResults(model: string, split: string, results: CaseResult[]): EvalReport {
  const share = (n: number) => (results.length ? n / results.length : 0);
  const byTag: EvalReport["byTag"] = {};
  for (const tag of new Set(results.flatMap((r) => r.tags))) {
    const tagged = results.filter((r) => r.tags.includes(tag));
    byTag[tag] = { cases: tagged.length, categoryAccuracy: tagged.filter((r) => r.categoryOk).length / tagged.length };
  }
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  return {
    model,
    split,
    cases: results.length,
    categoryAccuracy: share(results.filter((r) => r.categoryOk).length),
    dateAccuracy: share(results.filter((r) => r.dateOk).length),
    invalidRate: share(results.filter((r) => r.invalid).length),
    latencyMs: { p50: Math.round(percentile(times, 0.5)), p95: Math.round(percentile(times, 0.95)) },
    byTag,
    results,
  };
}

export async function runEval(
  client: ModelClient,
  model: string,
  cases: EvalCase[],
  split: string,
  onProgress?: (done: number, total: number) => void,
): Promise<EvalReport> {
  const results: CaseResult[] = [];
  const today = new Date("2026-10-20T12:00:00Z");
  for (const [index, c] of cases.entries()) {
    const file = caseFile(c);
    const started = performance.now();
    const result = await classifyFile(client, file, { kind: contentKindOf(file.ext), text: c.text, truncated: false }, today);
    results.push({
      id: c.id,
      tags: c.tags,
      expected: c.expected,
      got: { category: result.category, date: result.date },
      categoryOk: result.category === c.expected.category,
      dateOk: result.date === c.expected.date,
      invalid: result.source === "fallback",
      ms: performance.now() - started,
    });
    onProgress?.(index + 1, cases.length);
  }
  return summarizeResults(model, split, results);
}
