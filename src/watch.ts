import { watch } from "node:fs";
import type { ClassifyResult } from "./classify.js";
import { executePlan, loadPlan, movableItems, savePlan, type RunResult } from "./execute.js";
import { readJournal } from "./journal.js";
import { batchNeedsApproval, fingerprint } from "./guard.js";
import { buildPlan, type PlanItem } from "./plan.js";
import { applyReviewGate, type Predictor } from "./review.js";
import { scanFolder, type ScannedFile } from "./scan.js";

// `dz watch`: keeps planning as files arrive, and with --auto carries out what
// the guard allows for files that arrive while it is watching. Files that were
// already in the folder are planned but left alone (`dz tidy` sorts them), so a
// cluttered folder never holds up a new download. The guard's rules do not
// loosen in watch mode: REVIEW items and batches larger than the bulk limit wait
// for a person (asked right in the watch terminal, or `dz approve` / `dz run`),
// and BLOCK items never run.

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
  /** Things only a person can decide, each offered once. */
  needsDecision?: {
    reviews: PlanItem[];
    /** A bulk batch of new files, identified by the fingerprints of its moves. */
    batch?: { key: string; count: number };
  };
}

export interface WatchState {
  /** Classifications by content hash, so a file is shown to the model once. */
  cache: Map<string, ClassifyResult>;
  /** Names, sizes, and times of the settled files the last cycle saw. */
  signature: string;
  /** Files (name and hash) present when watching started; null until the first cycle. */
  baseline: Set<string> | null;
  /** Fingerprints of review items a person approved while watching. */
  approved: Set<string>;
  /** Keys of bulk batches a person approved while watching. */
  approvedBatches: Set<string>;
  /** Review items and batches already offered for a decision, so nobody is asked twice. */
  offered: Set<string>;
  /** Set after a decision, so the next pass runs even if nothing on disk changed. */
  dirty: boolean;
}

export function newWatchState(): WatchState {
  return { cache: new Map(), signature: "", baseline: null, approved: new Set(), approvedBatches: new Set(), offered: new Set(), dirty: false };
}

function batchKey(items: PlanItem[]): string {
  return items.map(fingerprint).sort().join(",");
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

/**
 * Files an undo put back, as name and hash. They are where the person wants them,
 * so --auto must not take them for new downloads and file them again (which made
 * Undo look like it did nothing). The hash pins the exact file: a new download
 * that reuses the name is still new.
 */
async function putBackByUndo(inbox: string): Promise<Set<string>> {
  const entries = await readJournal(inbox);
  const hashes = new Map<string, string>();
  for (const e of entries) if (e.op === "move") hashes.set(`${e.run}\n${e.to}`, e.sha256);
  const keys = new Set<string>();
  for (const e of entries) {
    if (e.op !== "restore" || e.state !== "done") continue;
    const sha = hashes.get(`${e.run}\n${e.from}`);
    if (sha) keys.add(`${e.to}\n${sha}`);
  }
  return keys;
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
  if (signature === state.signature && !state.dirty) return { unchanged: true, ...empty };
  state.signature = signature;
  state.dirty = false;

  // In --auto mode the files that were already here are left alone, so they are not
  // even sent to the model: a new download never waits behind a cluttered folder.
  const leaveExisting = options.auto && !options.includeExisting;
  const putBack = leaveExisting ? await putBackByUndo(inbox) : new Set<string>();
  const isNewFile = (f: { name: string; sha256: string }) => {
    const key = `${f.name}\n${f.sha256}`;
    return !state.baseline!.has(key) && !putBack.has(key);
  };
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
  const at = new Date().toISOString();
  for (const item of plan) {
    const print = fingerprint(item);
    if (item.verdict === "review" && state.approved.has(print)) item.approval = { at, fingerprint: print };
  }
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
  // Review items nobody has been asked about yet; each is offered once.
  const reviews = plan.filter((item) => item.verdict === "review" && !item.approval && !state.offered.has(fingerprint(item)));
  for (const item of reviews) state.offered.add(fingerprint(item));
  const decide = (batch?: { key: string; count: number }) =>
    reviews.length || batch ? { needsDecision: { reviews, ...(batch ? { batch } : {}) } } : {};

  if (runnable.length === 0) {
    const waiting = plan.filter((item) => item.verdict === "review" && !item.approval).length;
    return { ...result, ...decide(), held: waiting ? `${waiting} waiting for review` : "nothing new to move" };
  }
  const key = batchKey(runnable);
  if (batchNeedsApproval(runnable) && !state.approvedBatches.has(key)) {
    const offer = state.offered.has(key) ? undefined : { key, count: runnable.length };
    state.offered.add(key);
    return { ...result, ...decide(offer), held: `bulk change (${runnable.length} new files) waiting for your OK` };
  }
  // The plan was just written, so this runs exactly what was saved.
  return { ...result, ...decide(), run: await executePlan(inbox, runnable) };
}

export interface WatchControl {
  stop(): void;
  /** Approves one review item (by fingerprint) and runs a pass to carry it out. */
  approveItem(fingerprint: string): void;
  /** Approves a bulk batch (by key) and runs a pass to carry it out. */
  approveBatch(key: string): void;
}

/**
 * Watches the folder and runs a cycle after each burst of changes, plus one at
 * start. Decisions come back through the returned control, and are applied by
 * the next pass, so every change to the folder still goes through one cycle at a time.
 */
export function startWatching(
  options: WatchOptions & {
    debounceMs?: number;
    onCycle: (result: CycleResult) => void;
    onError: (error: unknown) => void;
  },
): WatchControl {
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
  return {
    stop() {
      clearTimeout(timer);
      watcher.close();
    },
    approveItem(print) {
      state.approved.add(print);
      state.dirty = true;
      schedule(0);
    },
    approveBatch(key) {
      state.approvedBatches.add(key);
      state.dirty = true;
      schedule(0);
    },
  };
}
