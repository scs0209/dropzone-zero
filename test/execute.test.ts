import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { executePlan, lastUndoableRun, loadPlan, savePlan, undoRun } from "../src/execute.js";
import { readJournal } from "../src/journal.js";
import type { PlanItem } from "../src/plan.js";
import { hashFile } from "../src/scan.js";

let inbox: string;

async function file(name: string, content: string): Promise<PlanItem> {
  await writeFile(join(inbox, name), content);
  return {
    name,
    sha256: await hashFile(join(inbox, name)),
    action: "move",
    category: "receipt",
    target: null,
    confidence: 0.9,
    reason: "Test.",
    source: "model",
  };
}

/** Every file under the inbox except Dropzone Zero's own state, with its content. */
async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(inbox, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isFile() && !path.includes(".dropzone")) out[path.slice(inbox.length + 1)] = await readFile(path, "utf8");
  }
  return out;
}

beforeEach(async () => {
  inbox = await mkdtemp(join(tmpdir(), "dz-test-"));
});

describe("executePlan", () => {
  it("moves files, journals every step, and undo restores the folder exactly", async () => {
    const receipt = { ...(await file("receipt.pdf", "coffee")), target: "Finance/Receipts/2026-10/2026-10-14-coffee.pdf" };
    const empty = { ...(await file("Untitled.txt", "")), action: "quarantine" as const, target: ".dropzone/quarantine/Untitled.txt" };
    const kept = { ...(await file("notes.txt", "keep me")), action: "skip" as const };
    const before = await snapshot();

    const result = await executePlan(inbox, [receipt, empty, kept]);
    assert.equal(result.moved, 2);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(await snapshot(), {
      "Finance/Receipts/2026-10/2026-10-14-coffee.pdf": "coffee",
      "notes.txt": "keep me",
    });
    assert.ok(existsSync(join(inbox, ".dropzone/quarantine/Untitled.txt")));

    const ops = (await readJournal(inbox)).map((e) => (e.op === "move" ? `move:${e.state}` : e.op));
    assert.deepEqual(ops.filter((op) => op.startsWith("move")), ["move:started", "move:done", "move:started", "move:done"]);

    assert.equal(await lastUndoableRun(inbox), result.run);
    const undone = await undoRun(inbox, result.run);
    assert.equal(undone.restored, 2);
    assert.deepEqual(await snapshot(), before);
    // The folders the run created are gone again.
    assert.ok(!existsSync(join(inbox, "Finance")));
    assert.equal(await lastUndoableRun(inbox), null);
  });

  it("refuses to move a file that changed after the preview", async () => {
    const item = { ...(await file("invoice.pdf", "v1")), target: "Finance/Invoices/invoice.pdf" };
    await writeFile(join(inbox, "invoice.pdf"), "v2");
    const result = await executePlan(inbox, [item]);
    assert.equal(result.moved, 0);
    assert.equal(result.failed[0]?.error, "File changed since preview");
    assert.ok(existsSync(join(inbox, "invoice.pdf")));
  });

  it("never overwrites an existing file", async () => {
    const item = { ...(await file("a.pdf", "new")), target: "b.pdf" };
    await writeFile(join(inbox, "b.pdf"), "old");
    const result = await executePlan(inbox, [item]);
    assert.equal(result.failed[0]?.error, "Target already exists");
    assert.equal(await readFile(join(inbox, "b.pdf"), "utf8"), "old");
  });

  it("rejects targets outside the folder", async () => {
    const item = { ...(await file("a.pdf", "x")), target: "../escaped.pdf" };
    const result = await executePlan(inbox, [item]);
    assert.match(result.failed[0]?.error ?? "", /leaves the folder/);
    assert.ok(existsSync(join(inbox, "a.pdf")));
  });

  it("undo leaves a file alone if it was edited after the run", async () => {
    const item = { ...(await file("a.pdf", "x")), target: "Docs/a.pdf" };
    const { run } = await executePlan(inbox, [item]);
    await writeFile(join(inbox, "Docs/a.pdf"), "edited");
    const undone = await undoRun(inbox, run);
    assert.equal(undone.restored, 0);
    assert.equal(undone.failed[0]?.error, "File changed since it was moved");
    assert.equal(await readFile(join(inbox, "Docs/a.pdf"), "utf8"), "edited");
  });
});

describe("saved plans", () => {
  it("round-trips and is archived after a run", async () => {
    const item = { ...(await file("a.pdf", "x")), target: "Docs/a.pdf" };
    await savePlan(inbox, "gemma4:e4b", [item]);
    assert.deepEqual((await loadPlan(inbox))?.items, [item]);
    const { run } = await executePlan(inbox, [item]);
    assert.equal(await loadPlan(inbox), null);
    assert.ok(existsSync(join(inbox, ".dropzone", `plan-${run}.json`)));
  });
});
