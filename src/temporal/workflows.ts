// Temporal workflows for `dz run --temporal` and `dz undo --temporal`. Temporal
// records every finished step, so if the worker or the machine stops halfway, a
// restarted worker continues with the next file instead of starting over.
// Workflow code must be deterministic: all file access happens in activities.
import { defineQuery, proxyActivities, setHandler } from "@temporalio/workflow";
import type { RunResult, UndoResult } from "../execute.js";
import type { PlanItem } from "../plan.js";
import type * as activities from "./activities.js";

const steps = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  // Steps report expected problems (file changed, target taken) as results, not errors,
  // so retries only cover the unexpected: a busy disk, a killed worker.
  retry: { maximumAttempts: 5, initialInterval: "1 second" },
});

export interface Progress {
  done: number;
  total: number;
}

export const progressQuery = defineQuery<Progress>("progress");

export async function runPlanWorkflow(inbox: string, run: string, items: PlanItem[]): Promise<RunResult> {
  const progress: Progress = { done: 0, total: items.length };
  setHandler(progressQuery, () => progress);

  await steps.beginRun(inbox, run, items.length);
  const result: RunResult = { run, moved: 0, moves: [], failed: [] };
  for (const item of items) {
    const step = await steps.moveOne(inbox, run, item);
    if (step.ok) {
      result.moved++;
      result.moves.push({ from: item.name, to: item.target! });
    }
    else result.failed.push({ name: step.name, error: step.error ?? "Unknown error" });
    progress.done++;
  }
  await steps.endRun(inbox, run, result.moved, result.failed.length);
  return result;
}

export async function undoRunWorkflow(inbox: string, run: string): Promise<UndoResult> {
  await steps.beginUndo(inbox, run);
  const moves = await steps.movesToUndo(inbox, run);
  const progress: Progress = { done: 0, total: moves.length };
  setHandler(progressQuery, () => progress);

  const result: UndoResult = { run, restored: 0, failed: [] };
  for (const move of moves) {
    const step = await steps.restoreOne(inbox, run, move);
    if (step.ok) result.restored++;
    else result.failed.push({ name: step.name, error: step.error ?? "Unknown error" });
    progress.done++;
  }
  await steps.removeCreatedDirs(inbox, run);
  await steps.endUndo(inbox, run, result.restored, result.failed.length);
  return result;
}
