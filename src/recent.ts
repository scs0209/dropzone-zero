import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJournal } from "./journal.js";
import { QUARANTINE_DIR } from "./plan.js";

// Where did my file go? Answered from the journal, which already records every
// move; nothing new is stored.

export interface RecentMove {
  at: string;
  run: string;
  from: string;
  to: string;
  /** False when the file has since been moved back by `dz undo`. */
  current: boolean;
  /** False when the file is no longer at `to` (moved or deleted by hand). */
  present: boolean;
}

/** Moves that finished, newest first. */
export async function recentMoves(inbox: string, limit = 20): Promise<RecentMove[]> {
  const entries = await readJournal(inbox);
  const restored = new Set(entries.flatMap((e) => (e.op === "restore" && e.state === "done" ? [`${e.run}\n${e.to}`] : [])));
  return entries
    .flatMap((e) => (e.op === "move" && e.state === "done" ? [e] : []))
    .reverse()
    .slice(0, limit)
    .map((e) => ({
      at: e.at,
      run: e.run,
      from: e.from,
      to: e.to,
      current: !restored.has(`${e.run}\n${e.from}`),
      present: existsSync(join(inbox, e.to)),
    }));
}

/** "Finance/Receipts/2026-10", or "quarantine" for files set aside. */
export function destinationFolder(to: string): string {
  const folder = dirname(to);
  return folder.startsWith(QUARANTINE_DIR) ? "quarantine" : folder;
}

/** One line for a notification: the first move and how many more. */
export function describeMoves(moves: { from: string; to: string }[]): string {
  const [first] = moves;
  if (!first) return "";
  const more = moves.length > 1 ? ` and ${moves.length - 1} more` : "";
  return `${first.from} → ${destinationFolder(first.to)}${more}`;
}
