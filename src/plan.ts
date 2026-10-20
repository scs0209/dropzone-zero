import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { z } from "zod";
import { CATEGORIES, type ClassifyResult } from "./classify.js";
import { applyJudgement, isExecutable, type Verdict } from "./guard.js";
import { applyRules, type Action } from "./rules.js";
import type { ScannedFile } from "./scan.js";

/** Where Dropzone Zero keeps its own state: the saved plan, the journal, and quarantine. */
export const STATE_DIR = ".dropzone";

/** Inside the inbox and hidden, so scans skip it. The user empties it; Dropzone Zero never deletes. */
export const QUARANTINE_DIR = `${STATE_DIR}/quarantine`;

/** One planned file. The schema validates saved plans on load; the type is inferred from it. */
export const PlanItemSchema = z.object({
  name: z.string().min(1),
  /** Content hash at planning time; `dz run` refuses to move a file that changed since. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
  ageDays: z.number().int(),
  action: z.enum(["move", "quarantine", "skip"]),
  /** Null when a rule decided without asking the model. */
  category: z.enum(CATEGORIES).nullable(),
  /** Destination relative to the inbox; null for skipped files. */
  target: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  source: z.enum(["rule", "model", "fallback"]),
  /** Programs and installers, by extension or execute bit. */
  executable: z.boolean(),
  /** The guardrail engine's decision; see guard.ts. */
  verdict: z.enum(["allow", "review", "block"]),
  /** Why the item needs review or is blocked. */
  checks: z.array(z.string()),
  /** Set by `dz approve`; only valid while the fingerprint matches this exact move. */
  approval: z.object({ at: z.string(), fingerprint: z.string() }).optional(),
});

export type PlanItem = z.infer<typeof PlanItemSchema>;

export interface BuildPlanOptions {
  inbox: string;
  classify: (file: ScannedFile) => Promise<ClassifyResult>;
  onProgress?: (done: number, total: number) => void;
}

/** Appends -2, -3, ... before the extension until the path is free on disk and in this plan. */
function uniqueTarget(inbox: string, target: string, taken: Set<string>): string {
  const ext = extname(target);
  const stem = target.slice(0, target.length - ext.length);
  let candidate = target;
  for (let n = 2; taken.has(candidate) || existsSync(join(inbox, candidate)); n++) {
    candidate = `${stem}-${n}${ext}`;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * Turns scanned files into a read-only plan. Rules run first; the model only sees
 * what is left; the guardrail engine judges every item last.
 */
export async function buildPlan(files: ScannedFile[], options: BuildPlanOptions): Promise<PlanItem[]> {
  const { inbox, classify, onProgress } = options;
  const taken = new Set<string>();
  const plan: PlanItem[] = [];

  for (const [index, file] of files.entries()) {
    const rule = applyRules(file);
    if (rule) {
      plan.push({
        name: file.name,
        sha256: file.sha256,
        size: file.size,
        ageDays: file.ageDays,
        executable: isExecutable(file.name, file.executable),
        verdict: "allow",
        checks: [],
        action: rule.action,
        category: null,
        target: rule.action === "quarantine" ? uniqueTarget(inbox, `${QUARANTINE_DIR}/${file.name}`, taken) : null,
        confidence: 1,
        reason: rule.reason,
        source: "rule",
      });
    } else {
      const result = await classify(file);
      const base = {
        name: file.name,
        sha256: file.sha256,
        size: file.size,
        ageDays: file.ageDays,
        executable: isExecutable(file.name, file.executable),
        verdict: "allow" as Verdict,
        checks: [],
        category: result.category,
        confidence: result.confidence,
        source: result.source,
      };
      // Unsure or failed classifications still get a proposed target; the guard holds them for review.
      if (result.category === "temp") {
        const target = uniqueTarget(inbox, `${QUARANTINE_DIR}/${file.name}`, taken);
        plan.push({ ...base, action: "quarantine", target, reason: result.reason });
      } else {
        const target = uniqueTarget(inbox, `${result.folder}/${result.newName}`, taken);
        plan.push({ ...base, action: "move", target, reason: result.reason });
      }
    }
    applyJudgement(plan.at(-1)!);
    onProgress?.(index + 1, files.length);
  }
  return plan;
}

export function summarize(plan: PlanItem[]): Record<Action, number> {
  const counts: Record<Action, number> = { move: 0, quarantine: 0, skip: 0 };
  for (const item of plan) counts[item.action]++;
  return counts;
}
