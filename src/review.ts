import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contentKindOf } from "./extract.js";
import type { SavedPlan } from "./execute.js";
import { requireReview } from "./guard.js";
import { readJournal } from "./journal.js";
import { STATE_DIR, type PlanItem } from "./plan.js";

// The review gate learns which planned moves this user tends to undo. Every
// `dz undo --file` is a "reject" and every move left alone is a "keep". Once
// there are enough of both, TabPFN (a tabular foundation model that learns from
// a table in one forward pass, no training loop) scores each new move, and
// likely rejects get a REVIEW verdict from the guard instead of moving. Only file metadata goes in,
// never names or contents, and it all runs locally in ml/ through uv.

export const MIN_DECISIONS = 20;
export const MIN_EACH_LABEL = 3;
export const REJECT_THRESHOLD = 0.5;

/** Synthetic past decisions for the demo; real folders never have this file. */
export const SEED_FEEDBACK = "feedback-seed.jsonl";

export interface FeedbackRow {
  item: PlanItem;
  rejected: boolean;
}

const CATEGORICAL = ["ext", "kind", "category", "action", "source"] as const;
const NUMERIC = ["confidence", "logSize", "ageDays", "dated", "depth"] as const;

/** Metadata the gate looks at. No file names, no contents. */
export function features(item: PlanItem): Record<(typeof CATEGORICAL)[number] | (typeof NUMERIC)[number], string | number> {
  const ext = extname(item.name).toLowerCase();
  const target = item.target ?? "";
  return {
    ext: ext || "(none)",
    kind: contentKindOf(ext),
    category: item.category ?? "(rule)",
    action: item.action,
    source: item.source,
    confidence: item.confidence,
    logSize: Math.log10(item.size + 1),
    ageDays: item.ageDays,
    dated: /^\d{4}-\d{2}-\d{2}-/.test(target.split("/").pop() ?? "") ? 1 : 0,
    depth: target.split("/").length,
  };
}

/**
 * Labeled decisions from this folder's history: every move of a run that was not
 * undone as a whole is a keep, unless the user moved that one file back. Runs
 * undone entirely are left out; that usually means "not now", not "wrong place".
 */
export async function feedbackRows(inbox: string): Promise<FeedbackRow[]> {
  const entries = await readJournal(inbox);
  const fullyUndone = new Set(entries.filter((e) => e.op === "undo-end").map((e) => e.run));
  const rejected = new Set(entries.flatMap((e) => (e.op === "reject" ? [`${e.run}\n${e.from}`] : [])));
  const moved = entries.flatMap((e) => (e.op === "move" && e.state === "done" && !fullyUndone.has(e.run) ? [e] : []));

  const rows: FeedbackRow[] = [];
  const plans = new Map<string, Map<string, PlanItem> | null>();
  for (const move of moved) {
    if (!plans.has(move.run)) {
      const path = join(inbox, STATE_DIR, `plan-${move.run}.json`);
      const plan = existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as SavedPlan) : null;
      plans.set(move.run, plan ? new Map(plan.items.map((item) => [item.name, item])) : null);
    }
    const item = plans.get(move.run)?.get(move.from);
    if (item && item.size !== undefined) rows.push({ item, rejected: rejected.has(`${move.run}\n${move.from}`) });
  }

  const seed = join(inbox, STATE_DIR, SEED_FEEDBACK);
  if (existsSync(seed)) {
    for (const line of (await readFile(seed, "utf8")).split("\n").filter(Boolean)) rows.push(JSON.parse(line) as FeedbackRow);
  }
  return rows;
}

/** Turns feature records into a numeric matrix; categorical columns become vocabulary indices. */
export function encode(train: PlanItem[], test: PlanItem[]): { train: number[][]; test: number[][]; categorical: number[] } {
  const vocab = new Map<string, number>();
  const row = (item: PlanItem) => {
    const f = features(item);
    return [
      ...CATEGORICAL.map((key) => {
        const value = `${key}=${f[key]}`;
        if (!vocab.has(value)) vocab.set(value, vocab.size);
        return vocab.get(value)!;
      }),
      ...NUMERIC.map((key) => Number(f[key])),
    ];
  };
  return { train: train.map(row), test: test.map(row), categorical: CATEGORICAL.map((_, i) => i) };
}

export type Predictor = (request: { train: number[][]; labels: number[]; test: number[][]; categorical: number[] }) => Promise<number[]>;

/** Runs ml/review_gate.py through uv. The first call downloads the TabPFN v2 weights (no login needed). */
export const tabpfnPredictor: Predictor = (request) =>
  new Promise((resolvePromise, reject) => {
    const project = fileURLToPath(new URL("../ml", import.meta.url));
    const child = spawn("uv", ["run", "--quiet", "--project", project, "python", join(project, "review_gate.py")], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`review gate exited with ${code}: ${err.trim().split("\n").pop() ?? ""}`));
      try {
        resolvePromise((JSON.parse(out) as { reject: number[] }).reject);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(request));
  });

export interface GateResult {
  status: "on" | "off";
  /** Why the gate is off, or what it did. */
  note: string;
  flagged: number;
}

/**
 * Scores planned moves and sends likely rejects to review. Never
 * throws: if the gate cannot run, the plan is returned unchanged with a note.
 */
export async function applyReviewGate(
  inbox: string,
  plan: PlanItem[],
  predict: Predictor = tabpfnPredictor,
): Promise<GateResult> {
  if (process.env.DZ_REVIEW_GATE === "off") return { status: "off", note: "turned off by DZ_REVIEW_GATE", flagged: 0 };
  const rows = await feedbackRows(inbox);
  const rejects = rows.filter((r) => r.rejected).length;
  const keeps = rows.length - rejects;
  if (rows.length < MIN_DECISIONS || rejects < MIN_EACH_LABEL || keeps < MIN_EACH_LABEL) {
    return {
      status: "off",
      note: `learning (${rows.length} decisions, ${rejects} moved back; needs ${MIN_DECISIONS} with at least ${MIN_EACH_LABEL} of each)`,
      flagged: 0,
    };
  }
  const moves = plan.filter((item) => item.action === "move" && item.verdict !== "block");
  if (moves.length === 0) return { status: "on", note: "nothing to score", flagged: 0 };

  let scores: number[];
  try {
    const encoded = encode(
      rows.map((r) => r.item),
      moves,
    );
    scores = await predict({ ...encoded, labels: rows.map((r) => (r.rejected ? 1 : 0)) });
  } catch (error) {
    return { status: "off", note: `could not run (${error instanceof Error ? error.message : String(error)})`, flagged: 0 };
  }

  let flagged = 0;
  moves.forEach((item, i) => {
    const score = scores[i] ?? 0;
    if (score < REJECT_THRESHOLD) return;
    flagged++;
    requireReview(item, `You moved back similar files before (${Math.round(score * 100)}% likely)`);
  });
  return { status: "on", note: `learned from ${rows.length} decisions (${rejects} moved back)`, flagged };
}
