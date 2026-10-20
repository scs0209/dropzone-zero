import { readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STATE_DIR } from "./plan.js";

// One watcher per folder. Two watchers race for the same new download: one
// moves it, the other fails with "File is gone", and whichever UI is attached to
// the loser never sees the move. A small lock file in the folder's state
// directory prevents that; a lock left by a process that no longer exists is
// taken over.

export interface LockInfo {
  pid: number;
  role: string;
  startedAt: string;
}

export class WatcherRunningError extends Error {
  override name = "WatcherRunningError";
  constructor(readonly holder: LockInfo) {
    super(
      `Another Dropzone Zero watcher is already watching this folder (\`dz ${holder.role}\`, pid ${holder.pid}, since ${new Date(holder.startedAt).toLocaleTimeString()}). ` +
        "Stop it first; if it is the background one, use `dz autostart disable`.",
    );
  }
}

export function lockPath(inbox: string): string {
  return join(inbox, STATE_DIR, "watch.lock");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Takes the folder's watcher lock, or throws WatcherRunningError if a live process holds it. Returns a release function. */
export async function acquireWatchLock(inbox: string, role: string): Promise<() => void> {
  const path = lockPath(inbox);
  await mkdir(join(inbox, STATE_DIR), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    const info: LockInfo = { pid: process.pid, role, startedAt: new Date().toISOString() };
    try {
      await writeFile(path, JSON.stringify(info), { flag: "wx" });
      const release = () => {
        try {
          const holder = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
          if (holder.pid === process.pid) rmSync(path, { force: true });
        } catch {
          // Already gone.
        }
      };
      process.once("exit", release);
      return release;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder: LockInfo | null = null;
      try {
        holder = JSON.parse(await readFile(path, "utf8")) as LockInfo;
      } catch {
        // Unreadable lock: treat as stale.
      }
      if (holder && holder.pid !== process.pid && alive(holder.pid)) throw new WatcherRunningError(holder);
      // Stale: its process is gone. Remove it and try once more.
      await rm(path, { force: true });
    }
  }
  throw new Error(`Could not take the watcher lock at ${path}`);
}
