import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { executePlan, undoFiles } from "../src/execute.js";
import type { PlanItem } from "../src/plan.js";
import { describeMoves, destinationFolder, recentMoves } from "../src/recent.js";
import { hashFile } from "../src/scan.js";

async function item(inbox: string, name: string, target: string): Promise<PlanItem> {
  await writeFile(join(inbox, name), `content of ${name}`);
  return {
    name,
    sha256: await hashFile(join(inbox, name)),
    size: 10,
    ageDays: 0,
    executable: false,
    verdict: "allow",
    checks: [],
    action: "move",
    category: "receipt",
    target,
    confidence: 0.9,
    reason: "Test.",
    source: "model",
  };
}

describe("recentMoves", () => {
  it("lists what moved where, newest first, and notes undone or missing files", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "dz-recent-"));
    const items = [
      await item(inbox, "a.pdf", "Finance/Receipts/2026-10/a.pdf"),
      await item(inbox, "b.pdf", "Documents/b.pdf"),
      await item(inbox, "c.pdf", "Documents/c.pdf"),
    ];
    const { run, moves } = await executePlan(inbox, items);
    assert.deepEqual(moves.map((m) => m.to), ["Finance/Receipts/2026-10/a.pdf", "Documents/b.pdf", "Documents/c.pdf"]);

    await undoFiles(inbox, run, ["b.pdf"]);
    await rm(join(inbox, "Documents/c.pdf"));
    const recent = await recentMoves(inbox);
    assert.deepEqual(
      recent.map((m) => [m.from, m.current, m.present]),
      [
        ["c.pdf", true, false],
        ["b.pdf", false, false],
        ["a.pdf", true, true],
      ],
    );
  });
});

describe("move descriptions", () => {
  it("names the first file and its folder, then counts the rest", () => {
    assert.equal(describeMoves([{ from: "IMG_5120.jpg", to: "Finance/Receipts/2026-10/2026-10-11-juniper.jpg" }]), "IMG_5120.jpg → Finance/Receipts/2026-10");
    assert.equal(
      describeMoves([
        { from: "a.pdf", to: "Documents/a.pdf" },
        { from: "b.pdf", to: "Documents/b.pdf" },
      ]),
      "a.pdf → Documents and 1 more",
    );
  });

  it("calls the quarantine folder by name", () => {
    assert.equal(destinationFolder(".dropzone/quarantine/copy (1).pdf"), "quarantine");
  });
});
