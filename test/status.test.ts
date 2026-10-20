import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { approveItems, executePlan, loadPlan, savePlan, undoFiles } from "../src/execute.js";
import type { PlanItem } from "../src/plan.js";
import { hashFile } from "../src/scan.js";
import { latestRun, plannedStates, runStates } from "../src/status.js";

let inbox: string;

beforeEach(async () => {
  inbox = await mkdtemp(join(tmpdir(), "dz-status-"));
});

async function item(name: string, target: string, overrides: Partial<PlanItem> = {}): Promise<PlanItem> {
  await writeFile(join(inbox, name), `content of ${name}`);
  return {
    name,
    sha256: await hashFile(join(inbox, name)),
    size: 10,
    ageDays: 1,
    executable: false,
    verdict: "allow",
    checks: [],
    action: "move",
    category: "document",
    target,
    confidence: 0.9,
    reason: "Test.",
    source: "model",
    ...overrides,
  };
}

const states = (items: { name: string; state: string }[]) => Object.fromEntries(items.map((i) => [i.name, i.state]));

describe("item states", () => {
  it("follow a file from plan to verified to restored", async () => {
    const items = [
      await item("a.pdf", "Documents/a.pdf"),
      await item("b.pkg", "Installers/b.pkg", { verdict: "review", checks: ["Program or installer"] }),
      await item("c.pkg", "Installers/c.pkg", { verdict: "review", checks: ["Program or installer"] }),
      await item("d.part", "", { action: "skip", target: null, verdict: "block", checks: ["Download still in progress."] }),
    ];
    await savePlan(inbox, "test", items);
    await approveItems(inbox, ["b.pkg"]);
    assert.deepEqual(states(await plannedStates(inbox)), {
      "a.pdf": "planned",
      "b.pkg": "approved",
      "c.pkg": "needs-review",
      "d.part": "blocked",
    });

    const { run } = await executePlan(inbox, (await loadPlan(inbox))!.items);
    assert.equal(await latestRun(inbox), run);
    assert.deepEqual(states(await runStates(inbox, run)), { "a.pdf": "verified", "b.pkg": "verified" });

    await undoFiles(inbox, run, ["a.pdf"]);
    assert.deepEqual(states(await runStates(inbox, run)), { "a.pdf": "restored", "b.pkg": "verified" });
  });

  it("shows a move that stopped halfway as executing", async () => {
    const a = await item("a.pdf", "Documents/a.pdf");
    const { run } = await executePlan(inbox, [a]);
    const path = join(inbox, ".dropzone/journal.jsonl");
    const lines = (await readFile(path, "utf8")).trim().split("\n").filter((l) => !l.includes('"state":"done"'));
    await writeFile(path, lines.join("\n") + "\n");
    assert.deepEqual(states(await runStates(inbox, run)), { "a.pdf": "executing" });
  });

  it("records failures with their reason", async () => {
    const a = await item("a.pdf", "Documents/a.pdf");
    await writeFile(join(inbox, "a.pdf"), "changed after preview");
    const { run } = await executePlan(inbox, [a]);
    const [status] = await runStates(inbox, run);
    assert.equal(status?.state, "failed");
    assert.equal(status?.detail, "File changed since preview");
  });
});
