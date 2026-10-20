// Temporal activities: the file-system steps of a run or an undo. They are the
// same functions `dz run` uses without Temporal, and each one is safe to retry.
import { setTimeout } from "node:timers/promises";
import * as steps from "../execute.js";
import type { PlanItem } from "../plan.js";

// Slows each move down so a demo can kill the worker mid-run and watch it resume.
const stepDelayMs = Number(process.env.DZ_STEP_DELAY_MS ?? 0);

export async function moveOne(inbox: string, run: string, item: PlanItem): Promise<steps.StepResult> {
  if (stepDelayMs > 0) await setTimeout(stepDelayMs);
  return steps.moveOne(inbox, run, item);
}

export async function restoreOne(inbox: string, run: string, move: steps.MoveRecord): Promise<steps.StepResult> {
  if (stepDelayMs > 0) await setTimeout(stepDelayMs);
  return steps.restoreOne(inbox, run, move);
}

export const { beginRun, endRun, movesToUndo, removeCreatedDirs, beginUndo, endUndo } = steps;
