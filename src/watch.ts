import { watch } from "node:fs";
import type { ClassifyResult } from "./classify.js";
import { executePlan, loadPlan, movableItems, savePlan, type RunResult } from "./execute.js";
import { batchNeedsApproval, fingerprint } from "./guard.js";
import { buildPlan, type PlanItem } from "./plan.js";
import { applyReviewGate, type Predictor } from "./review.js";
import { scanFolder, type ScannedFile } from "./scan.js";

// `dz watch`: keeps planning as files arrive, and with --auto carries out what
// the guard allows for files that arrive while it is watching. Files that were
// already in the folder are planned but left alone (`dz tidy` sorts them), so a
// cluttered folder never holds up a new download. The guard's rules do not
// loosen in watch mode: REVIEW items wait for `dz approve`, BLOCK items never
// run, and a batch larger than the bulk limit waits for an explicit `dz run`.

/** A file modified more recently than this is probably still being written. */
export const DEFAULT_SETTLE_MS = 5_000;
/** Events usually come in bursts (a browser writing a download); wait for quiet. */
export const DEFAULT_DEBOUNCE_MS = 2_000;

export interface WatchOptions {
  inbox: string;
  model: string;
  auto: boolean;
  classify: (file: ScannedFile) => Promise<ClassifyResult>;
  settleMs?: number;
  predictor?: Predictor;
  now?: () => number;
  /** Also auto-move files that were already there when watching started. */
  includeExisting?: boolean;
}

export interface CycleResult {
  /** True when nothing on disk changed since the last cycle, so nothing was planned. */
  unchanged: boolean;
  planned: number;
  newlyClassified: number;
  settling: number;
  allowed: number;
  review: number;
  blocked: number;
  /** Allowed files that were already there when watching started, left for `dz tidy`. */
  existing: number;
  /** Why an --auto cycle did not run, if it did not. */
  held?: string;
  run?: RunResult;
}

export interface WatchState {
  /** Classifications by content hash, so a file is shown to the model once. */
  cache: Map<string, ClassifyResult>;
  /** Names, sizes, and times of the settled files the last cycle saw. */
  signature: string;
  /** Files (name and hash) present when watching started; null until the first cycle. */
  baseline: Set<string> | null;
}

export function newWatchState(): WatchState {
  return { cache: new Map(), signature: "", baseline: null };
}

/** Approvals from the previous plan stay valid if the move they approved is still exactly the same. */
async function carryOverApprovals(inbox: string, plan: PlanItem[]): Promise<void> {
  const previous = await loadPlan(inbox).catch(() => null);
  if (!previous) return;
  const approvals = new Map(previous.items.flatMap((item) => (item.approval ? [[fingerprint(item), item.approval] as const] : [])));
  for (const item of plan) {
    const approval = approvals.get(fingerprint(item));
    if (approval && item.verdict === "review") item.approval = approval;
  }
}

/** One pass: scan, plan what has settled, save the plan, and with --auto run what the guard allows. */
export async function watchCycle(state: WatchState, options: WatchOptions): Promise<CycleResult> {
  const { inbox, settleMs = DEFAULT_SETTLE_MS, now = Date.now } = options;
  const scanned = await scanFolder(inbox);
  state.baseline ??= new Set(scanned.map((f) => `${f.name}\n${f.sha256}`));
  const settled = scanned.filter((f) => now() - f.modifiedAt.getTime() >= settleMs);
  // Which files have settled is part of the signature: a file that finished writing is news.
  const signature = settled.map((f) => `${f.name}\n${f.size}\n${f.modifiedAt.getTime()}`).join("\n") + `\n#${scanned.length}`;
  const empty = { planned: 0, newlyClassified: 0, settling: 0, allowed: 0, review: 0, blocked: 0, existing: 0 };
  if (signature === state.signature) return { unchanged: true, ...empty };
  state.signature = signature;

  // In --auto mode the files that were already here are left alone, so they are not
  // even sent to the model: a new download never waits behind a cluttered folder.
  const isNewFile = (f: { name: string; sha256: string }) => !state.baseline!.has(`${f.name}\n${f.sha256}`);
  const leaveExisting = options.auto && !options.includeExisting;
  const candidates = leaveExisting ? settled.filter(isNewFile) : settled;
  let newlyClassified = 0;
  const plan = await buildPlan(candidates, {
    inbox,
    classify: async (file) => {
      const cached = state.cache.get(file.sha256);
      if (cached) return cached;
      newlyClassified++;
      const result = await options.classify(file);
      state.cache.set(file.sha256, result);
      return result;
    },
  });
  await applyReviewGate(inbox, plan, options.predictor);
  await carryOverApprovals(inbox, plan);
  await savePlan(inbox, options.model, plan);

  const result: CycleResult = {
    unchanged: false,
    planned: plan.length,
    newlyClassified,
    // Files still being written are planned on a later cycle, once they stop changing.
    settling: scanned.length - settled.length,
    allowed: plan.filter((i) => i.verdict === "allow").length,
    review: plan.filter((i) => i.verdict === "review").length,
    blocked: plan.filter((i) => i.verdict === "block").length,
    existing: settled.length - candidates.length,
  };
  if (!options.auto) return result;

  const runnable = movableItems(plan);
  if (runnable.length === 0) {
    return { ...result, held: result.review ? `${result.review} waiting for review (\`dz approve\`)` : "nothing new to move" };
  }
  if (batchNeedsApproval(runnable)) return { ...result, held: `bulk change (${runnable.length} files); confirm with \`dz run\`` };
  // The plan was just written, so this runs exactly what was saved.
  return { ...result, run: await executePlan(inbox, runnable) };
}

/**
 * Watches the folder and runs a cycle after each burst of changes, plus one at
 * start. Returns a function that stops watching.
 */
export function startWatching(
  options: WatchOptions & { debounceMs?: number; onCycle: (result: CycleResult) => void; onError: (error: unknown) => void },
): () => void {
  const state = newWatchState();
  const { debounceMs = DEFAULT_DEBOUNCE_MS, settleMs = DEFAULT_SETTLE_MS } = options;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let again = false;

  const cycle = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const result = await watchCycle(state, options);
      if (!result.unchanged) options.onCycle(result);
      // Files that were still settling need another look once they have had time to finish.
      if (result.settling > 0) schedule(settleMs);
    } catch (error) {
      options.onError(error);
    } finally {
      running = false;
      if (again) {
        again = false;
        schedule(debounceMs);
      }
    }
  };
  const schedule = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(cycle, ms);
  };

  const watcher = watch(options.inbox, (_event, name) => {
    // Our own state folder changes on every save; that is not news.
    if (name && name.startsWith(".dropzone")) return;
    schedule(debounceMs);
  });
  void cycle();
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
