import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { PlanItem } from "./plan.js";

// The guardrail engine. The model proposes; this module decides. Every planned
// item gets a verdict:
//   allow  - runs with the batch
//   review - waits until the user approves this exact move (`dz approve`)
//   block  - never runs, whatever anyone approves
// The executor asks again right before each move (checkBeforeMove), because a
// plan file can be edited and the disk can change between preview and run.
// Nothing here trusts file names or contents: they are data, never instructions.

export type Verdict = "allow" | "review" | "block";

export interface Judgement {
  verdict: Verdict;
  /** Why the item is not "allow". Empty when it is. */
  checks: string[];
}

/** Below this, a classification is a guess and a person should look first. */
export const MIN_CONFIDENCE = 0.5;
/** Larger batches of allowed moves need one explicit approval for the batch. */
export const DEFAULT_BULK_LIMIT = 20;

// Programs and installers: moving them can break an install or an app's updater.
const EXECUTABLE_EXTENSIONS = new Set([
  ".app", ".apk", ".appimage", ".bat", ".bin", ".cmd", ".com", ".command", ".deb", ".dmg",
  ".exe", ".jar", ".msi", ".pkg", ".ps1", ".rpm", ".run", ".scpt", ".sh", ".workflow",
]);

export function isExecutable(name: string, modeExecutable = false): boolean {
  return modeExecutable || EXECUTABLE_EXTENSIONS.has(extname(name).toLowerCase());
}

/** Binds an approval to one exact move: same content, same action, same target. */
export function fingerprint(item: Pick<PlanItem, "sha256" | "action" | "target">): string {
  return createHash("sha256").update(`${item.sha256}\n${item.action}\n${item.target}`).digest("hex");
}

/** True when a plan path stays inside the folder by its text alone (no "..", not absolute). */
function staysInside(path: string): boolean {
  if (!path || path.includes("\0") || isAbsolute(path)) return false;
  const normal = normalize(path);
  return normal !== ".." && !normal.startsWith(`..${sep}`) && !normal.split(sep).includes("..");
}

/** Plan-time verdict, from the item alone. Pure, so the executor can repeat it. */
export function judge(item: PlanItem): Judgement {
  const block = (check: string): Judgement => ({ verdict: "block", checks: [check] });
  if (item.action === "skip") return block(item.reason);
  if (item.action !== "move" && item.action !== "quarantine") return block(`Unsupported action: ${String(item.action)}`);
  if (!item.target) return block("No target");
  if (!staysInside(item.name) || item.name.includes("/") || item.name.includes("\\")) return block("Source is not a file in this folder");
  if (!staysInside(item.target)) return block("Target leaves the folder");
  if (extname(item.target).toLowerCase() !== extname(item.name).toLowerCase()) return block("Would change the file type");
  // Quarantine lives in .dropzone; a move (by the model or a filing rule) never goes into a hidden folder.
  if (item.action === "move" && normalize(item.target).split(sep).some((part) => part.startsWith("."))) return block("Target is in a hidden folder");

  const checks = [...(item.checks ?? [])];
  if (item.action === "move") {
    if (item.source === "fallback") checks.push("The model could not classify this file");
    else if (item.confidence < MIN_CONFIDENCE) checks.push(`Low confidence (${item.confidence.toFixed(2)})`);
    // Re-derived from the name too, so an edited flag cannot let a program through.
    if (item.executable || isExecutable(item.name)) checks.push("Program or installer");
  }
  return { verdict: checks.length ? "review" : "allow", checks: [...new Set(checks)] };
}

/** Applies judge() to an item in place, keeping any extra checks (such as the review gate's). */
export function applyJudgement(item: PlanItem): PlanItem {
  const { verdict, checks } = judge(item);
  item.verdict = verdict;
  item.checks = checks;
  return item;
}

/** Adds a reason to look first. Blocked items stay blocked. */
export function requireReview(item: PlanItem, check: string): void {
  item.checks = [...(item.checks ?? []), check];
  applyJudgement(item);
}

/** Allowed items, plus review items whose approval still matches this exact move. */
export function isRunnable(item: PlanItem): boolean {
  const { verdict } = judge(item);
  if (verdict === "allow") return true;
  return verdict === "review" && item.approval?.fingerprint === fingerprint(item);
}

export function batchNeedsApproval(items: PlanItem[], limit = Number(process.env.DZ_BULK_LIMIT ?? DEFAULT_BULK_LIMIT)): boolean {
  return items.filter(isRunnable).length > limit;
}

export class GuardError extends Error {
  override name = "GuardError";
}

/** Throws unless `path` (or its deepest existing ancestor) really sits inside the folder, with no symlinks on the way. */
async function assertRealPathInside(inbox: string, path: string): Promise<void> {
  const root = await realpath(inbox);
  let existing = path;
  while (!existsSync(existing)) existing = dirname(existing);
  // Every component between the folder and the target must be a real directory, not a link.
  const steps = relative(resolve(inbox), existing).split(sep).filter(Boolean);
  let current = resolve(inbox);
  for (const step of steps) {
    current = join(current, step);
    if ((await lstat(current)).isSymbolicLink()) throw new GuardError(`Blocked: ${relative(inbox, current)} is a symbolic link`);
  }
  const real = await realpath(existing);
  if (real !== root && !real.startsWith(root + sep)) throw new GuardError("Blocked: target leaves the folder");
}

/**
 * The executor's last check, run right before a rename. It repeats the plan-time
 * verdict and then looks at the disk: the source must be a regular file (not a
 * link), the destination must not exist, and both must really be inside the
 * folder after resolving symlinks.
 */
export async function checkBeforeMove(inbox: string, item: PlanItem): Promise<{ source: string; destination: string }> {
  const { verdict, checks } = judge(item);
  if (verdict === "block") throw new GuardError(`Blocked: ${checks[0]}`);
  if (!isRunnable(item)) throw new GuardError("Waiting for review: approve it with `dz approve`");

  const source = resolve(inbox, item.name);
  const destination = resolve(inbox, item.target!);
  const info = await lstat(source).catch(() => null);
  if (!info) throw new GuardError("File is gone");
  if (info.isSymbolicLink() || !info.isFile()) throw new GuardError("Blocked: source is not a regular file");
  await assertRealPathInside(inbox, source);
  await assertRealPathInside(inbox, destination);
  if (existsSync(destination)) throw new GuardError("Target already exists");
  return { source, destination };
}

/** The same disk checks for undo: the file being moved back and its old place must both be inside the folder. */
export async function checkBeforeRestore(inbox: string, from: string, to: string): Promise<void> {
  const source = resolve(inbox, from);
  const info = await lstat(source);
  if (info.isSymbolicLink() || !info.isFile()) throw new GuardError("Blocked: not a regular file");
  await assertRealPathInside(inbox, source);
  await assertRealPathInside(inbox, resolve(inbox, to));
}
