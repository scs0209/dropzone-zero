import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { checkBeforeMove, checkBeforeRestore, fingerprint, isRunnable } from "./guard.js";
import { Journal, newRunId, readJournal } from "./journal.js";
import { PlanItemSchema, QUARANTINE_DIR, STATE_DIR, type PlanItem } from "./plan.js";
import { hashFile } from "./scan.js";

export const SavedPlanSchema = z.object({
  inbox: z.string(),
  createdAt: z.string(),
  model: z.string(),
  items: z.array(PlanItemSchema),
  /** SHA-256 of the items as Dropzone Zero wrote them; any other edit invalidates the plan. */
  digest: z.string(),
});

export type SavedPlan = z.infer<typeof SavedPlanSchema>;

function planDigest(items: PlanItem[]): string {
  return createHash("sha256").update(JSON.stringify(items)).digest("hex");
}

export class PlanTamperedError extends Error {
  override name = "PlanTamperedError";
}

export function planPath(inbox: string): string {
  return join(inbox, STATE_DIR, "plan.json");
}

/** `dz preview` saves its plan so `dz run` executes exactly what the user saw, without asking the model again. */
export async function savePlan(inbox: string, model: string, items: PlanItem[], createdAt = new Date().toISOString()): Promise<void> {
  const plan: SavedPlan = { inbox, createdAt, model, items, digest: planDigest(items) };
  await mkdir(join(inbox, STATE_DIR), { recursive: true });
  await writeFile(planPath(inbox), JSON.stringify(plan, null, 2) + "\n");
}

/**
 * The saved plan, or null if there is none. Throws if the file was edited by
 * anything but Dropzone Zero: what runs must be what the user previewed and approved.
 */
export async function loadPlan(inbox: string): Promise<SavedPlan | null> {
  let text: string;
  try {
    text = await readFile(planPath(inbox), "utf8");
  } catch {
    return null;
  }
  // The digest covers the items exactly as written, so check it before parsing reorders anything.
  const raw = JSON.parse(text) as { digest?: unknown; items?: PlanItem[] };
  if (!Array.isArray(raw.items) || raw.digest !== planDigest(raw.items)) {
    throw new PlanTamperedError("The saved plan was changed outside Dropzone Zero. Run `dz preview` again.");
  }
  const parsed = SavedPlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PlanTamperedError("The saved plan is not in the expected format. Run `dz preview` again.");
  }
  return parsed.data;
}

/** Approves review items for this exact move (content, action, target). Returns the names approved. */
export async function approveItems(inbox: string, names: string[] | "all"): Promise<{ approved: string[]; unmatched: string[] }> {
  const plan = await loadPlan(inbox);
  if (!plan) throw new Error("No saved plan. Run `dz preview` first.");
  const approved: string[] = [];
  const at = new Date().toISOString();
  for (const item of plan.items) {
    const wanted = names === "all" || names.includes(item.name) || (item.target !== null && names.includes(item.target));
    if (!wanted || item.verdict !== "review") continue;
    item.approval = { at, fingerprint: fingerprint(item) };
    approved.push(item.name);
  }
  const unmatched = names === "all" ? [] : names.filter((n) => !approved.includes(n) && !plan.items.some((i) => i.target === n && approved.includes(i.name)));
  await savePlan(inbox, plan.model, plan.items, plan.createdAt);
  return { approved, unmatched };
}

/** Resolves a plan path and refuses anything that would escape the inbox (the plan file is editable). */
function inside(inbox: string, path: string): string {
  const absolute = resolve(inbox, path);
  if (!absolute.startsWith(resolve(inbox) + sep)) throw new Error(`Path leaves the folder: ${path}`);
  return absolute;
}

/** Creates the target's parent folders one level at a time, journaling each new one so undo can remove it. */
async function ensureDir(inbox: string, dir: string, journal: Journal): Promise<void> {
  const missing: string[] = [];
  for (let current = dir; !existsSync(current); current = dirname(current)) missing.unshift(current);
  for (const path of missing) {
    await mkdir(path);
    await journal.write({ op: "mkdir", dir: relative(inbox, path) });
  }
}

export interface StepResult {
  name: string;
  ok: boolean;
  error?: string;
}

function failure(name: string, error: unknown): StepResult {
  return { name, ok: false, error: error instanceof Error ? error.message : String(error) };
}

/**
 * Moves one planned file. The source must still have the hash it had at preview
 * time, and the destination must have it afterwards. Targets live inside the
 * inbox, so a move is a rename on one filesystem: no copy, no delete, and the file
 * is never in two places or none.
 *
 * Safe to repeat: if a previous attempt already moved the file (a crash between
 * the rename and the journal line, or a retried Temporal activity), it reports
 * success instead of failing on the missing source.
 */
export async function moveOne(inbox: string, run: string, item: PlanItem): Promise<StepResult> {
  const journal = new Journal(inbox, run);
  const from = item.name;
  const to = item.target!;
  try {
    const source = inside(inbox, from);
    const destination = inside(inbox, to);
    if (!existsSync(source) && existsSync(destination) && (await hashFile(destination)) === item.sha256) {
      await journal.write({ op: "move", from, to, sha256: item.sha256, state: "done" });
      return { name: from, ok: true };
    }
    // The guard decides again here, not just at preview: the plan file or the disk may have changed.
    await checkBeforeMove(inbox, item);
    if ((await hashFile(source)) !== item.sha256) throw new Error("File changed since preview");

    await ensureDir(inbox, dirname(destination), journal);
    // Once more after creating folders, to close the gap in which a folder could be swapped for a link.
    await checkBeforeMove(inbox, item);
    await journal.write({ op: "move", from, to, sha256: item.sha256, state: "started" });
    await rename(source, destination);
    if ((await hashFile(destination)) !== item.sha256) {
      await rename(destination, source);
      throw new Error("Hash mismatch after move; moved back");
    }
    await journal.write({ op: "move", from, to, sha256: item.sha256, state: "done" });
    return { name: from, ok: true };
  } catch (error) {
    const result = failure(from, error);
    await journal.write({ op: "move", from, to, sha256: item.sha256, state: "failed", error: result.error });
    return result;
  }
}

/** Journals the start of a run. Plans carry many items; only the movable ones count. */
export async function beginRun(inbox: string, run: string, files: number): Promise<void> {
  await new Journal(inbox, run).write({ op: "run-begin", files });
}

/** Journals the end of a run and archives the plan next to the journal; a new preview starts fresh. */
export async function endRun(inbox: string, run: string, moved: number, failed: number): Promise<void> {
  await new Journal(inbox, run).write({ op: "run-end", moved, failed });
  if (existsSync(planPath(inbox))) await rename(planPath(inbox), join(inbox, STATE_DIR, `plan-${run}.json`));
}

/** Items the guard lets run now: allowed ones and approved reviews. */
export function movableItems(items: PlanItem[]): PlanItem[] {
  return items.filter(isRunnable);
}

export interface RunResult {
  run: string;
  moved: number;
  /** What went where, paths relative to the folder, so people can see it. */
  moves: { from: string; to: string }[];
  failed: { name: string; error: string }[];
}

/** Runs a whole plan in this process. `dz run --temporal` runs the same steps as a durable workflow. */
export async function executePlan(
  inbox: string,
  items: PlanItem[],
  onProgress?: (done: number, total: number) => void,
  run = newRunId(),
): Promise<RunResult> {
  const work = movableItems(items);
  await beginRun(inbox, run, work.length);
  const result: RunResult = { run, moved: 0, moves: [], failed: [] };
  for (const [index, item] of work.entries()) {
    const step = await moveOne(inbox, run, item);
    if (step.ok) {
      result.moved++;
      result.moves.push({ from: item.name, to: item.target! });
    }
    else result.failed.push({ name: step.name, error: step.error! });
    onProgress?.(index + 1, work.length);
  }
  await endRun(inbox, run, result.moved, result.failed.length);
  return result;
}

export interface UndoResult {
  run: string;
  restored: number;
  failed: { name: string; error: string }[];
}

export type MoveRecord = { from: string; to: string; sha256: string };

/** The most recent run that has not been undone yet. */
export async function lastUndoableRun(inbox: string): Promise<string | null> {
  const entries = await readJournal(inbox);
  const undone = new Set(entries.filter((e) => e.op === "undo-end").map((e) => e.run));
  const runs = entries.filter((e) => e.op === "run-begin" && !undone.has(e.run)).map((e) => e.run);
  return runs.at(-1) ?? null;
}

/**
 * The moves of a run to reverse, newest first. "started" moves count too: a crash
 * between the rename and the "done" line still moved the file.
 */
export async function movesToUndo(inbox: string, run: string): Promise<MoveRecord[]> {
  const moves = new Map<string, MoveRecord>();
  for (const entry of await readJournal(inbox)) {
    if (entry.run !== run || entry.op !== "move") continue;
    if (entry.state === "failed") moves.delete(entry.from);
    else moves.set(entry.from, { from: entry.from, to: entry.to, sha256: entry.sha256 });
  }
  return [...moves.values()].reverse();
}

/**
 * Moves one file back, only if it still has the hash it was moved with and its
 * old place is free. Safe to repeat: a file already back in place counts as restored.
 */
export async function restoreOne(inbox: string, run: string, move: MoveRecord): Promise<StepResult> {
  const journal = new Journal(inbox, run);
  try {
    const now = inside(inbox, move.to);
    const before = inside(inbox, move.from);
    if (!existsSync(now)) {
      if (existsSync(before) && (await hashFile(before)) === move.sha256) return { name: move.from, ok: true };
      throw new Error("File is no longer at its new place");
    }
    await checkBeforeRestore(inbox, move.to, move.from);
    if ((await hashFile(now)) !== move.sha256) throw new Error("File changed since it was moved");
    if (existsSync(before)) throw new Error("Original place is taken");
    await rename(now, before);
    await journal.write({ op: "restore", from: move.to, to: move.from, state: "done" });
    return { name: move.from, ok: true };
  } catch (error) {
    const result = failure(move.from, error);
    await journal.write({ op: "restore", from: move.to, to: move.from, state: "failed", error: result.error });
    return result;
  }
}

/**
 * Moves a run's calendar follow-ups into quarantine (never deletes them), so an
 * undone filing leaves no reminder behind. With `forFiles` (filed paths), only
 * the follow-ups for those documents.
 */
export async function setAsideFollowUps(inbox: string, run: string, forFiles?: string[]): Promise<void> {
  const journal = new Journal(inbox, run);
  for (const entry of await readJournal(inbox)) {
    if (entry.run !== run || entry.op !== "followup") continue;
    if (forFiles && !forFiles.includes(entry.from)) continue;
    const from = inside(inbox, entry.file);
    if (!existsSync(from)) continue;
    const dir = join(QUARANTINE_DIR, "follow-ups");
    await mkdir(inside(inbox, dir), { recursive: true });
    let to = `${dir}/${basename(entry.file)}`;
    for (let n = 2; existsSync(inside(inbox, to)); n++) to = `${dir}/${basename(entry.file, ".ics")}-${n}.ics`;
    await rename(from, inside(inbox, to));
    await journal.write({ op: "followup-aside", file: entry.file, to });
  }
}

/**
 * Undoes what a run created besides moves: its follow-ups go to quarantine, then
 * its folders are removed, deepest first. rmdir only removes empty folders, so
 * nothing the user added is lost.
 */
export async function removeCreatedDirs(inbox: string, run: string, forFiles?: string[]): Promise<void> {
  await setAsideFollowUps(inbox, run, forFiles);
  const journal = new Journal(inbox, run);
  const dirs = (await readJournal(inbox)).flatMap((e) => (e.run === run && e.op === "mkdir" ? [e.dir] : [])).reverse();
  for (const dir of dirs) {
    try {
      await rmdir(inside(inbox, dir));
      await journal.write({ op: "rmdir", dir });
    } catch {
      // Not empty or already gone: leave it.
    }
  }
}

export async function beginUndo(inbox: string, run: string): Promise<void> {
  await new Journal(inbox, run).write({ op: "undo-begin" });
}

export async function endUndo(inbox: string, run: string, restored: number, failed: number): Promise<void> {
  await new Journal(inbox, run).write({ op: "undo-end", restored, failed });
}

/** Puts every file from a run back where it was, newest move first, then removes the folders it created. */
export async function undoRun(inbox: string, run: string): Promise<UndoResult> {
  const result: UndoResult = { run, restored: 0, failed: [] };
  await beginUndo(inbox, run);
  for (const move of await movesToUndo(inbox, run)) {
    const step = await restoreOne(inbox, run, move);
    if (step.ok) result.restored++;
    else result.failed.push({ name: step.name, error: step.error! });
  }
  await removeCreatedDirs(inbox, run);
  await endUndo(inbox, run, result.restored, result.failed.length);
  return result;
}

/**
 * Moves back only the named files from a run (by old name, new path, or new name)
 * and records each as rejected, which the review gate learns from.
 */
export async function undoFiles(inbox: string, run: string, names: string[]): Promise<UndoResult & { unmatched: string[] }> {
  const journal = new Journal(inbox, run);
  const moves = await movesToUndo(inbox, run);
  const result: UndoResult & { unmatched: string[] } = { run, restored: 0, failed: [], unmatched: [] };
  const putBack: string[] = [];
  for (const name of names) {
    const move = moves.find((m) => m.from === name || m.to === name || m.to.split("/").pop() === name);
    if (!move) {
      result.unmatched.push(name);
      continue;
    }
    await journal.write({ op: "reject", from: move.from });
    const step = await restoreOne(inbox, run, move);
    if (step.ok) {
      result.restored++;
      putBack.push(move.to);
    } else result.failed.push({ name: step.name, error: step.error! });
  }
  await removeCreatedDirs(inbox, run, putBack);
  return result;
}
