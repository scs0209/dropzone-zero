import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Journal, newRunId, readJournal } from "./journal.js";
import { STATE_DIR, type PlanItem } from "./plan.js";
import { hashFile } from "./scan.js";

export interface SavedPlan {
  inbox: string;
  createdAt: string;
  model: string;
  items: PlanItem[];
}

export function planPath(inbox: string): string {
  return join(inbox, STATE_DIR, "plan.json");
}

/** `dz preview` saves its plan so `dz run` executes exactly what the user saw, without asking the model again. */
export async function savePlan(inbox: string, model: string, items: PlanItem[]): Promise<void> {
  const plan: SavedPlan = { inbox, createdAt: new Date().toISOString(), model, items };
  await mkdir(join(inbox, STATE_DIR), { recursive: true });
  await writeFile(planPath(inbox), JSON.stringify(plan, null, 2) + "\n");
}

export async function loadPlan(inbox: string): Promise<SavedPlan | null> {
  try {
    return JSON.parse(await readFile(planPath(inbox), "utf8")) as SavedPlan;
  } catch {
    return null;
  }
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

export interface RunResult {
  run: string;
  moved: number;
  failed: { name: string; error: string }[];
}

/**
 * Moves files exactly as planned. Each move is checked twice: the source must still
 * have the hash it had at preview time, and the destination must have it afterwards.
 * Targets live inside the inbox, so a move is a rename on one filesystem: no copy,
 * no delete, and the file is never in two places or none.
 */
export async function executePlan(
  inbox: string,
  items: PlanItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<RunResult> {
  const run = newRunId();
  const journal = new Journal(inbox, run);
  const work = items.filter((item) => item.action !== "skip" && item.target);
  const result: RunResult = { run, moved: 0, failed: [] };
  await journal.write({ op: "run-begin", files: work.length });

  for (const [index, item] of work.entries()) {
    const from = item.name;
    const to = item.target!;
    try {
      const source = inside(inbox, from);
      const destination = inside(inbox, to);
      if (!existsSync(source)) throw new Error("File is gone");
      if ((await hashFile(source)) !== item.sha256) throw new Error("File changed since preview");
      if (existsSync(destination)) throw new Error("Target already exists");

      await ensureDir(inbox, dirname(destination), journal);
      await journal.write({ op: "move", from, to, sha256: item.sha256, state: "started" });
      await rename(source, destination);
      if ((await hashFile(destination)) !== item.sha256) {
        await rename(destination, source);
        throw new Error("Hash mismatch after move; moved back");
      }
      await journal.write({ op: "move", from, to, sha256: item.sha256, state: "done" });
      result.moved++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await journal.write({ op: "move", from, to, sha256: item.sha256, state: "failed", error: message });
      result.failed.push({ name: from, error: message });
    }
    onProgress?.(index + 1, work.length);
  }

  await journal.write({ op: "run-end", moved: result.moved, failed: result.failed.length });
  // Keep the executed plan next to the journal for the record; a new preview starts fresh.
  if (existsSync(planPath(inbox))) await rename(planPath(inbox), join(inbox, STATE_DIR, `plan-${run}.json`));
  return result;
}

export interface UndoResult {
  run: string;
  restored: number;
  failed: { name: string; error: string }[];
}

/** The most recent run that has not been undone yet. */
export async function lastUndoableRun(inbox: string): Promise<string | null> {
  const entries = await readJournal(inbox);
  const undone = new Set(entries.filter((e) => e.op === "undo-end").map((e) => e.run));
  const runs = entries.filter((e) => e.op === "run-begin" && !undone.has(e.run)).map((e) => e.run);
  return runs.at(-1) ?? null;
}

/**
 * Puts every file from a run back where it was, newest move first, then removes
 * the folders the run created if they are empty again. A file is only moved back
 * when it still has the hash it was moved with and its old place is free.
 */
export async function undoRun(inbox: string, run: string): Promise<UndoResult> {
  const entries = (await readJournal(inbox)).filter((e) => e.run === run);
  const journal = new Journal(inbox, run);
  const result: UndoResult = { run, restored: 0, failed: [] };
  await journal.write({ op: "undo-begin" });

  // "started" moves count too: a crash between rename and the "done" line still moved the file.
  const moves = new Map<string, Extract<(typeof entries)[number], { op: "move" }>>();
  for (const entry of entries) {
    if (entry.op === "move" && entry.state !== "failed") moves.set(entry.from, entry);
    if (entry.op === "move" && entry.state === "failed") moves.delete(entry.from);
  }

  for (const move of [...moves.values()].reverse()) {
    try {
      const now = inside(inbox, move.to);
      const before = inside(inbox, move.from);
      if (!existsSync(now)) {
        if (existsSync(before) && (await hashFile(before)) === move.sha256) continue; // never moved
        throw new Error("File is no longer at its new place");
      }
      if ((await hashFile(now)) !== move.sha256) throw new Error("File changed since it was moved");
      if (existsSync(before)) throw new Error("Original place is taken");
      await rename(now, before);
      await journal.write({ op: "restore", from: move.to, to: move.from, state: "done" });
      result.restored++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await journal.write({ op: "restore", from: move.to, to: move.from, state: "failed", error: message });
      result.failed.push({ name: move.from, error: message });
    }
  }

  // Deepest folders first. rmdir only removes empty folders, so nothing the user added is lost.
  const dirs = entries.flatMap((e) => (e.op === "mkdir" ? [e.dir] : [])).reverse();
  for (const dir of dirs) {
    try {
      await rmdir(inside(inbox, dir));
      await journal.write({ op: "rmdir", dir });
    } catch {
      // Not empty or already gone: leave it.
    }
  }

  await journal.write({ op: "undo-end", restored: result.restored, failed: result.failed.length });
  return result;
}
