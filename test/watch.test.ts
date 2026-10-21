import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import type { ClassifyResult } from "../src/classify.js";
import { approveItems, lastUndoableRun, loadPlan, undoRun } from "../src/execute.js";
import type { ScannedFile } from "../src/scan.js";
import { fingerprint } from "../src/guard.js";
import { appleScriptString } from "../src/notify.js";
import { newWatchState, watchCycle, type WatchOptions } from "../src/watch.js";

let inbox: string;
let asked: string[];

beforeEach(async () => {
  inbox = await mkdtemp(join(tmpdir(), "dz-watch-"));
  asked = [];
  process.env.DZ_REVIEW_GATE = "off";
});

/** Receipts for .pdf files, installers for .pkg, one model call each. */
async function classify(file: ScannedFile): Promise<ClassifyResult> {
  asked.push(file.name);
  const installer = file.ext === ".pkg";
  return {
    category: installer ? "installer" : "receipt",
    date: null,
    newName: file.name.toLowerCase(),
    folder: installer ? "Installers" : "Finance/Receipts/2026-10",
    confidence: 0.9,
    reason: "Test.",
    source: "model",
    attempts: 1,
  };
}

const options = (overrides: Partial<WatchOptions> = {}): WatchOptions => ({ inbox, model: "test", auto: false, classify, settleMs: 0, ...overrides });

async function arrive(name: string, content = name, secondsAgo = 60): Promise<void> {
  await writeFile(join(inbox, name), content);
  const time = new Date(Date.now() - secondsAgo * 1000);
  await utimes(join(inbox, name), time, time);
}

describe("watchCycle", () => {
  it("plans without moving anything unless --auto", async () => {
    await arrive("a.pdf");
    const result = await watchCycle(newWatchState(), options());
    assert.equal(result.allowed, 1);
    assert.equal(result.run, undefined);
    assert.ok(existsSync(join(inbox, "a.pdf")));
    assert.equal((await loadPlan(inbox))?.items.length, 1);
  });

  it("with --auto runs allowed moves only", async () => {
    const state = newWatchState();
    await watchCycle(state, options({ auto: true }));
    await arrive("a.pdf");
    await arrive("setup.pkg");
    const result = await watchCycle(state, options({ auto: true }));
    assert.equal(result.run?.moved, 1);
    assert.ok(existsSync(join(inbox, "Finance/Receipts/2026-10/a.pdf")));
    assert.ok(existsSync(join(inbox, "setup.pkg")), "programs wait for review");
  });

  it("asks the model about each file once", async () => {
    const state = newWatchState();
    await arrive("setup.pkg");
    await watchCycle(state, options());
    await arrive("b.pdf");
    await watchCycle(state, options());
    assert.deepEqual(asked, ["setup.pkg", "b.pdf"]);
  });

  it("does nothing when nothing changed", async () => {
    const state = newWatchState();
    await arrive("a.pdf");
    await watchCycle(state, options());
    assert.equal((await watchCycle(state, options())).unchanged, true);
  });

  it("waits for files that are still being written", async () => {
    const state = newWatchState();
    await arrive("fresh.pdf", "x", 0);
    const first = await watchCycle(state, options({ settleMs: 5_000 }));
    assert.equal(first.settling, 1);
    assert.equal(first.planned, 0);
    // Later, the same file has settled and gets planned.
    const later = await watchCycle(state, options({ settleMs: 5_000, now: () => Date.now() + 10_000 }));
    assert.equal(later.planned, 1);
  });

  it("holds a bulk change for an explicit dz run", async () => {
    process.env.DZ_BULK_LIMIT = "2";
    try {
      const state = newWatchState();
      await watchCycle(state, options({ auto: true }));
      for (const name of ["a.pdf", "b.pdf", "c.pdf"]) await arrive(name);
      const result = await watchCycle(state, options({ auto: true }));
      assert.match(result.held ?? "", /bulk change/);
      assert.ok(existsSync(join(inbox, "a.pdf")));
    } finally {
      delete process.env.DZ_BULK_LIMIT;
    }
  });

  it("keeps approvals across cycles and runs them with --auto", async () => {
    const state = newWatchState();
    await watchCycle(state, options());
    await arrive("setup.pkg");
    await watchCycle(state, options());
    await approveItems(inbox, ["setup.pkg"]);
    await arrive("b.pdf");
    const result = await watchCycle(state, options({ auto: true }));
    assert.equal(result.run?.moved, 2);
    assert.ok(existsSync(join(inbox, "Installers/setup.pkg")));
  });

  it("leaves files that were there before watching started, and still files new arrivals", async () => {
    await arrive("old.pdf");
    const state = newWatchState();
    const first = await watchCycle(state, options({ auto: true }));
    assert.equal(first.existing, 1);
    assert.equal(first.run, undefined);
    await arrive("new.pdf");
    const second = await watchCycle(state, options({ auto: true }));
    assert.equal(second.run?.moved, 1);
    assert.ok(existsSync(join(inbox, "old.pdf")), "the backlog stays put");
    assert.ok(existsSync(join(inbox, "Finance/Receipts/2026-10/new.pdf")));
  });

  it("does not file a download again after an undo put it back", async () => {
    const state = newWatchState();
    await watchCycle(state, options({ auto: true }));
    await arrive("new.pdf");
    const filed = await watchCycle(state, options({ auto: true }));
    assert.equal(filed.run?.moved, 1);

    await undoRun(inbox, (await lastUndoableRun(inbox))!);
    assert.ok(existsSync(join(inbox, "new.pdf")), "undo put it back");
    const after = await watchCycle(state, options({ auto: true }));
    assert.equal(after.run, undefined);
    assert.ok(existsSync(join(inbox, "new.pdf")), "and it stays put");

    // Deleted and downloaded again, the same file is a new download.
    const { rm } = await import("node:fs/promises");
    await rm(join(inbox, "new.pdf"));
    await watchCycle(state, options({ auto: true }));
    await arrive("new.pdf");
    const again = await watchCycle(state, options({ auto: true }));
    assert.equal(again.run?.moved, 1);
    await undoRun(inbox, (await lastUndoableRun(inbox))!);
    await watchCycle(state, options({ auto: true }));
    assert.ok(existsSync(join(inbox, "new.pdf")), "an undo after that is respected again");

    // A different file that reuses the name is a new download again.
    await arrive("new.pdf", "a different receipt");
    const next = await watchCycle(state, options({ auto: true }));
    assert.equal(next.run?.moved, 1);
  });

  it("a cluttered folder no longer holds up a new download", async () => {
    process.env.DZ_BULK_LIMIT = "2";
    try {
      for (const name of ["a.pdf", "b.pdf", "c.pdf", "d.pdf"]) await arrive(name);
      const state = newWatchState();
      await watchCycle(state, options({ auto: true }));
      await arrive("fresh.pdf");
      const result = await watchCycle(state, options({ auto: true }));
      assert.equal(result.run?.moved, 1);
      assert.equal(result.existing, 4);
    } finally {
      delete process.env.DZ_BULK_LIMIT;
    }
  });

  it("moves the backlog too with --include-existing", async () => {
    await arrive("old.pdf");
    const result = await watchCycle(newWatchState(), options({ auto: true, includeExisting: true }));
    assert.equal(result.run?.moved, 1);
  });

  it("offers a review item for a decision once, and moves it after approval", async () => {
    const state = newWatchState();
    await watchCycle(state, options({ auto: true }));
    await arrive("setup.pkg");
    const asked = await watchCycle(state, options({ auto: true }));
    assert.deepEqual(asked.needsDecision?.reviews.map((i) => i.name), ["setup.pkg"]);
    assert.ok(existsSync(join(inbox, "setup.pkg")));

    // Asked once: a later pass does not ask again.
    state.dirty = true;
    assert.equal((await watchCycle(state, options({ auto: true }))).needsDecision, undefined);

    // The person says yes in the watch terminal.
    state.approved.add(fingerprint(asked.needsDecision!.reviews[0]!));
    state.dirty = true;
    const after = await watchCycle(state, options({ auto: true }));
    assert.equal(after.run?.moved, 1);
    assert.ok(existsSync(join(inbox, "Installers/setup.pkg")));
  });

  it("asks once about a bulk batch and runs it when approved", async () => {
    process.env.DZ_BULK_LIMIT = "2";
    try {
      const state = newWatchState();
      await watchCycle(state, options({ auto: true }));
      for (const name of ["a.pdf", "b.pdf", "c.pdf"]) await arrive(name);
      const held = await watchCycle(state, options({ auto: true }));
      assert.equal(held.needsDecision?.batch?.count, 3);
      state.approvedBatches.add(held.needsDecision!.batch!.key);
      state.dirty = true;
      const after = await watchCycle(state, options({ auto: true }));
      assert.equal(after.run?.moved, 3);
    } finally {
      delete process.env.DZ_BULK_LIMIT;
    }
  });
});

describe("notifications", () => {
  it("escapes text for AppleScript", () => {
    assert.equal(appleScriptString('Say "hi"\\now\nplease'), '"Say \\"hi\\"\\\\now please"');
  });
});

