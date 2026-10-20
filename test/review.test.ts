import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { executePlan, savePlan, undoFiles, undoRun } from "../src/execute.js";
import type { PlanItem } from "../src/plan.js";
import { applyReviewGate, encode, feedbackRows, features, type Predictor } from "../src/review.js";
import { hashFile } from "../src/scan.js";

let inbox: string;

beforeEach(async () => {
  inbox = await mkdtemp(join(tmpdir(), "dz-review-"));
});

async function item(name: string, category: PlanItem["category"], target: string): Promise<PlanItem> {
  await writeFile(join(inbox, name), `content of ${name}`);
  return {
    name,
    sha256: await hashFile(join(inbox, name)),
    size: 20,
    ageDays: 3,
    action: "move",
    category,
    target,
    confidence: 0.9,
    reason: "Test.",
    source: "model",
  };
}

/** Runs a plan the way the CLI does: save, execute (which archives the plan). */
async function run(items: PlanItem[]): Promise<string> {
  await savePlan(inbox, "test", items);
  return (await executePlan(inbox, items)).run;
}

describe("feedbackRows", () => {
  it("labels kept moves and single-file undos", async () => {
    const runId = await run([
      await item("setup.dmg", "installer", "Installers/setup.dmg"),
      await item("receipt.pdf", "receipt", "Finance/Receipts/2026-10/receipt.pdf"),
    ]);
    await undoFiles(inbox, runId, ["setup.dmg"]);
    const rows = await feedbackRows(inbox);
    assert.deepEqual(
      rows.map((r) => [r.item.name, r.rejected]),
      [
        ["setup.dmg", true],
        ["receipt.pdf", false],
      ],
    );
  });

  it("ignores runs that were undone as a whole", async () => {
    const runId = await run([await item("a.pdf", "document", "Documents/a.pdf")]);
    await undoRun(inbox, runId);
    assert.deepEqual(await feedbackRows(inbox), []);
  });
});

describe("features", () => {
  it("uses metadata only, never the file name", () => {
    const f = features({
      name: "Tax return 2026 - Jane.pdf",
      sha256: "",
      size: 999,
      ageDays: 4,
      action: "move",
      category: "document",
      target: "Documents/2026-04-01-tax-return.pdf",
      confidence: 0.8,
      reason: "",
      source: "model",
    });
    assert.ok(!JSON.stringify(f).includes("Jane"));
    assert.equal(f.ext, ".pdf");
    assert.equal(f.dated, 1);
  });

  it("encodes categories consistently across train and test", () => {
    const base = { sha256: "", size: 1, ageDays: 0, action: "move" as const, target: "x/y", confidence: 1, reason: "", source: "model" as const };
    const { train, test, categorical } = encode(
      [{ ...base, name: "a.dmg", category: "installer" }],
      [{ ...base, name: "b.dmg", category: "installer" }],
    );
    assert.deepEqual(train[0]!.slice(0, categorical.length), test[0]!.slice(0, categorical.length));
  });
});

describe("applyReviewGate", () => {
  async function history(rejects: number, keeps: number): Promise<void> {
    const items: PlanItem[] = [];
    for (let i = 0; i < rejects; i++) items.push(await item(`app${i}.dmg`, "installer", `Installers/app${i}.dmg`));
    for (let i = 0; i < keeps; i++) items.push(await item(`r${i}.pdf`, "receipt", `Finance/Receipts/r${i}.pdf`));
    const runId = await run(items);
    await undoFiles(inbox, runId, items.slice(0, rejects).map((i) => i.name));
  }

  it("stays off until there are enough decisions of both kinds", async () => {
    await history(2, 30);
    const plan = [await item("new.dmg", "installer", "Installers/new.dmg")];
    const gate = await applyReviewGate(inbox, plan, async () => assert.fail("should not predict"));
    assert.equal(gate.status, "off");
    assert.match(gate.note, /32 decisions, 2 moved back/);
    assert.equal(plan[0]!.action, "move");
  });

  it("holds likely rejects for review and keeps the rest", async () => {
    await history(5, 20);
    const plan = [
      await item("new.dmg", "installer", "Installers/new.dmg"),
      await item("new.pdf", "receipt", "Finance/Receipts/new.pdf"),
    ];
    const predictor: Predictor = async ({ train, labels, test }) => {
      assert.equal(train.length, 25);
      assert.equal(labels.filter(Boolean).length, 5);
      return test.map((_, i) => (i === 0 ? 0.8 : 0.1));
    };
    const gate = await applyReviewGate(inbox, plan, predictor);
    assert.equal(gate.flagged, 1);
    assert.equal(plan[0]!.action, "skip");
    assert.match(plan[0]!.reason, /^Review: .*80% likely.*Installers\/new\.dmg/);
    assert.equal(plan[1]!.action, "move");
  });

  it("never breaks the preview when the model cannot run", async () => {
    await history(5, 20);
    const plan = [await item("new.dmg", "installer", "Installers/new.dmg")];
    const gate = await applyReviewGate(inbox, plan, async () => {
      throw new Error("uv not found");
    });
    assert.equal(gate.status, "off");
    assert.match(gate.note, /uv not found/);
    assert.equal(plan[0]!.action, "move");
  });
});
