import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import type { Category, ClassifyResult } from "./classify.js";
import { applyRules, type Action } from "./rules.js";
import type { ScannedFile } from "./scan.js";

/** Inside the inbox and hidden, so scans skip it. The user empties it; Dropzone Zero never deletes. */
export const QUARANTINE_DIR = ".dropzone/quarantine";
/** Below this, the file stays where it is and the plan says why. */
export const MIN_CONFIDENCE = 0.5;

export interface PlanItem {
  name: string;
  action: Action;
  /** Null when a rule decided without asking the model. */
  category: Category | null;
  /** Destination relative to the inbox; null for skipped files. */
  target: string | null;
  confidence: number;
  reason: string;
  source: "rule" | "model" | "fallback";
}

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

/** Turns scanned files into a read-only plan. Rules run first; the model only sees what is left. */
export async function buildPlan(files: ScannedFile[], options: BuildPlanOptions): Promise<PlanItem[]> {
  const { inbox, classify, onProgress } = options;
  const taken = new Set<string>();
  const plan: PlanItem[] = [];

  for (const [index, file] of files.entries()) {
    const rule = applyRules(file);
    if (rule) {
      plan.push({
        name: file.name,
        action: rule.action,
        category: null,
        target: rule.action === "quarantine" ? uniqueTarget(inbox, `${QUARANTINE_DIR}/${file.name}`, taken) : null,
        confidence: 1,
        reason: rule.reason,
        source: "rule",
      });
    } else {
      const result = await classify(file);
      const base = { name: file.name, category: result.category, confidence: result.confidence, source: result.source };
      if (result.source === "fallback" || result.confidence < MIN_CONFIDENCE) {
        const why = result.source === "fallback" ? result.reason : `Low confidence: ${result.reason}`;
        plan.push({ ...base, action: "skip", target: null, reason: why });
      } else if (result.category === "temp") {
        const target = uniqueTarget(inbox, `${QUARANTINE_DIR}/${file.name}`, taken);
        plan.push({ ...base, action: "quarantine", target, reason: result.reason });
      } else {
        const target = uniqueTarget(inbox, `${result.folder}/${result.newName}`, taken);
        plan.push({ ...base, action: "move", target, reason: result.reason });
      }
    }
    onProgress?.(index + 1, files.length);
  }
  return plan;
}

export function summarize(plan: PlanItem[]): Record<Action, number> {
  const counts: Record<Action, number> = { move: 0, quarantine: 0, skip: 0 };
  for (const item of plan) counts[item.action]++;
  return counts;
}
