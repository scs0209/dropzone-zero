import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { acquireWatchLock, lockPath, WatcherRunningError } from "../src/lock.js";

async function folderWithLock(pid: number): Promise<string> {
  const inbox = await mkdtemp(join(tmpdir(), "dz-lock-"));
  await mkdir(dirname(lockPath(inbox)), { recursive: true });
  await writeFile(lockPath(inbox), JSON.stringify({ pid, role: "watch --auto", startedAt: new Date().toISOString() }));
  return inbox;
}

describe("watcher lock", () => {
  it("refuses a second watcher while the first is alive", async () => {
    // The parent process (the test runner) is certainly alive and is not us.
    const inbox = await folderWithLock(process.ppid);
    await assert.rejects(acquireWatchLock(inbox, "daemon"), (error: unknown) => {
      assert.ok(error instanceof WatcherRunningError);
      assert.match(error.message, /already watching this folder \(`dz watch --auto`, pid \d+/);
      return true;
    });
  });

  it("takes over a lock left by a process that is gone", async () => {
    const inbox = await folderWithLock(2 ** 22 + 12345);
    const release = await acquireWatchLock(inbox, "daemon");
    assert.equal(JSON.parse(await readFile(lockPath(inbox), "utf8")).pid, process.pid);
    release();
    assert.ok(!existsSync(lockPath(inbox)));
  });

  it("creates the lock in a fresh folder", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "dz-lock-"));
    const release = await acquireWatchLock(inbox, "watch");
    assert.equal(JSON.parse(await readFile(lockPath(inbox), "utf8")).role, "watch");
    release();
  });
});
