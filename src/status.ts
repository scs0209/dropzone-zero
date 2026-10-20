import { loadPlan } from "./execute.js";
import { isRunnable } from "./guard.js";
import { readJournal } from "./journal.js";

// Where every file stands. States are derived, never stored twice: the saved
// plan holds the verdicts and approvals, and the append-only journal holds what
// actually happened. Allowed transitions:
//
//   blocked                      (terminal: never runs)
//   needs-review --approve-->    approved
//   planned | approved --run-->  executing --verified--> verified --undo--> restored
//                                executing --error-->    failed
//
// A file left in "executing" means a run stopped between the rename and its
// check; `dz worker` (with --temporal) or `dz undo` resolves it.

export type ItemState = "planned" | "needs-review" | "approved" | "blocked" | "executing" | "verified" | "failed" | "restored";

export interface ItemStatus {
  name: string;
  target: string | null;
  state: ItemState;
  detail?: string;
}

/** States of the items in the saved plan, which has not run yet. */
export async function plannedStates(inbox: string): Promise<ItemStatus[]> {
  const plan = await loadPlan(inbox);
  if (!plan) return [];
  return plan.items.map((item) => {
    const base = { name: item.name, target: item.target };
    if (item.verdict === "block") return { ...base, state: "blocked", detail: item.checks.join("; ") };
    if (item.verdict === "review") {
      return isRunnable(item) ? { ...base, state: "approved" } : { ...base, state: "needs-review", detail: item.checks.join("; ") };
    }
    return { ...base, state: "planned" };
  });
}

export async function latestRun(inbox: string): Promise<string | null> {
  const runs = (await readJournal(inbox)).filter((e) => e.op === "run-begin").map((e) => e.run);
  return runs.at(-1) ?? null;
}

/** States of the files a run touched, replayed from the journal in order. */
export async function runStates(inbox: string, run: string): Promise<ItemStatus[]> {
  const states = new Map<string, ItemStatus>();
  for (const entry of await readJournal(inbox)) {
    if (entry.run !== run) continue;
    if (entry.op === "move") {
      const state: ItemState = entry.state === "started" ? "executing" : entry.state === "done" ? "verified" : "failed";
      states.set(entry.from, { name: entry.from, target: entry.to, state, ...(entry.error ? { detail: entry.error } : {}) });
    } else if (entry.op === "restore") {
      const current = states.get(entry.to);
      if (current && entry.state === "done") states.set(entry.to, { ...current, state: "restored" });
      else if (current) states.set(entry.to, { ...current, detail: `undo failed: ${entry.error}` });
    }
  }
  return [...states.values()];
}

export function countStates(items: ItemStatus[]): Partial<Record<ItemState, number>> {
  const counts: Partial<Record<ItemState, number>> = {};
  for (const item of items) counts[item.state] = (counts[item.state] ?? 0) + 1;
  return counts;
}
