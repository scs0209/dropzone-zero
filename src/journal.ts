import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { STATE_DIR } from "./plan.js";

// An append-only JSON Lines log of every change Dropzone Zero makes to a folder.
// It doubles as feedback: a "reject" line marks a single file the user moved back.
// Each step is written before it happens ("started") and again after it is
// verified ("done"), so an interrupted run can still be undone.

export type JournalEntry = { run: string; at: string } & (
  | { op: "run-begin"; files: number }
  | { op: "mkdir"; dir: string }
  | { op: "move"; from: string; to: string; sha256: string; state: "started" | "done" | "failed"; error?: string }
  | { op: "run-end"; moved: number; failed: number }
  | { op: "undo-begin" }
  | { op: "reject"; from: string }
  | { op: "restore"; from: string; to: string; state: "done" | "failed"; error?: string }
  | { op: "rmdir"; dir: string }
  /** A calendar follow-up written for a filed document (see followups.ts). */
  | { op: "followup"; file: string; from: string; uid?: string }
  /** An undo set a run's follow-up aside in quarantine. */
  | { op: "followup-aside"; file: string; to: string }
  /** The person sent a follow-up to the Calendar app from Zee. */
  | { op: "calendar-add"; file: string; uid: string }
  /** Dropzone Zero removed its own event (by UID) from the Calendar app. */
  | { op: "calendar-remove"; uid: string; removed: number }
  /** Taken off Zee's "Coming up" list; the .ics file stays. */
  | { op: "followup-dismissed"; file: string }
  | { op: "undo-end"; restored: number; failed: number }
);

/** Distributes Omit over the union so each entry keeps its own fields. */
type EntryBody = JournalEntry extends infer E ? (E extends JournalEntry ? Omit<E, "run" | "at"> : never) : never;

export function journalPath(inbox: string): string {
  return join(inbox, STATE_DIR, "journal.jsonl");
}

export class Journal {
  constructor(
    readonly inbox: string,
    readonly run: string,
  ) {}

  async write(entry: EntryBody): Promise<void> {
    const path = journalPath(this.inbox);
    await mkdir(dirname(path), { recursive: true });
    const line: JournalEntry = { run: this.run, at: new Date().toISOString(), ...entry } as JournalEntry;
    await appendFile(path, JSON.stringify(line) + "\n");
  }
}

export async function readJournal(inbox: string): Promise<JournalEntry[]> {
  let text: string;
  try {
    text = await readFile(journalPath(inbox), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JournalEntry);
}

/** Run ids are sortable timestamps with milliseconds, e.g. 20261020T094512123Z. */
export function newRunId(now = new Date()): string {
  return now.toISOString().replace(/[-:.]/g, "");
}
