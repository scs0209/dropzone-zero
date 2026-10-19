import type { ScannedFile } from "./scan.js";

export type Action = "move" | "quarantine" | "skip";

export interface RuleDecision {
  action: Exclude<Action, "move">;
  reason: string;
}

// Office lock files (~$report.docx) and generic scratch files.
const TEMP_PATTERN = /^~\$|\.(tmp|temp|swp|bak)$/i;

/**
 * Deterministic checks that run before the model. They cover the cases where a
 * wrong guess would be costly, and save a model call for files that need none.
 * Nothing here deletes: quarantine is a folder the user empties themselves.
 */
export function applyRules(file: ScannedFile): RuleDecision | null {
  if (file.partial) return { action: "skip", reason: "Download still in progress." };
  if (file.size === 0) return { action: "quarantine", reason: "Empty file." };
  if (file.duplicateOf) return { action: "quarantine", reason: `Duplicate of ${file.duplicateOf}.` };
  if (TEMP_PATTERN.test(file.name)) return { action: "quarantine", reason: "Temporary file." };
  return null;
}
