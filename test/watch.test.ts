import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import type { ClassifyResult } from "../src/classify.js";
import { approveItems, loadPlan } from "../src/execute.js";
import type { ScannedFile } from "../src/scan.js";
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
    await arrive("a.pdf");
    await arrive("setup.pkg");
    const result = await watchCycle(newWatchState(), options({ auto: true }));
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
      for (const name of ["a.pdf", "b.pdf", "c.pdf"]) await arrive(name);
      const result = await watchCycle(newWatchState(), options({ auto: true }));
      assert.match(result.held ?? "", /bulk change/);
      assert.ok(existsSync(join(inbox, "a.pdf")));
    } finally {
      delete process.env.DZ_BULK_LIMIT;
    }
  });

  it("keeps approvals across cycles and runs them with --auto", async () => {
    const state = newWatchState();
    await arrive("setup.pkg");
    await watchCycle(state, options());
    await approveItems(inbox, ["setup.pkg"]);
    await arrive("b.pdf");
    const result = await watchCycle(state, options({ auto: true }));
    assert.equal(result.run?.moved, 2);
    assert.ok(existsSync(join(inbox, "Installers/setup.pkg")));
  });
});
