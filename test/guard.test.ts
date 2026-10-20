import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { approveItems, executePlan, loadPlan, moveOne, planPath, savePlan } from "../src/execute.js";
import { batchNeedsApproval, fingerprint, isRunnable, judge } from "../src/guard.js";
import type { PlanItem } from "../src/plan.js";
import { hashFile } from "../src/scan.js";

let inbox: string;
let outside: string;

beforeEach(async () => {
  inbox = await mkdtemp(join(tmpdir(), "dz-guard-"));
  outside = await mkdtemp(join(tmpdir(), "dz-outside-"));
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

const plain = (overrides: Partial<PlanItem>): PlanItem => ({
  name: "a.pdf",
  sha256: "0".repeat(64),
  size: 1,
  ageDays: 0,
  executable: false,
  verdict: "allow",
  checks: [],
  action: "move",
  category: "document",
  target: "Documents/a.pdf",
  confidence: 0.9,
  reason: "",
  source: "model",
  ...overrides,
});

describe("judge", () => {
  it("allows a clear, contained move", () => {
    assert.deepEqual(judge(plain({})), { verdict: "allow", checks: [] });
  });

  it("blocks anything that leaves the folder or changes the file type", () => {
    for (const target of ["../a.pdf", "/etc/a.pdf", "Documents/../../a.pdf", "Documents/a.exe"]) {
      assert.equal(judge(plain({ target })).verdict, "block", target);
    }
    assert.equal(judge(plain({ name: "../a.pdf" })).verdict, "block");
    assert.equal(judge(plain({ action: "delete" as PlanItem["action"] })).verdict, "block");
  });

  it("sends programs, guesses, and failed classifications to review", () => {
    assert.deepEqual(judge(plain({ name: "setup.pkg", target: "Installers/setup.pkg" })).checks, ["Program or installer"]);
    // An edited flag does not help: the extension alone is enough.
    assert.equal(judge(plain({ name: "tool.sh", target: "Other/tool.sh", executable: false })).verdict, "review");
    assert.equal(judge(plain({ executable: true })).verdict, "review");
    assert.equal(judge(plain({ confidence: 0.2 })).verdict, "review");
    assert.equal(judge(plain({ source: "fallback" })).verdict, "review");
  });

  it("lets quarantine of a duplicate program through, since it stays inside .dropzone", () => {
    assert.equal(judge(plain({ name: "setup.pkg", action: "quarantine", target: ".dropzone/quarantine/setup.pkg" })).verdict, "allow");
  });

  it("flags large batches", () => {
    const items = Array.from({ length: 21 }, (_, i) => plain({ name: `f${i}.pdf`, target: `Documents/f${i}.pdf` }));
    assert.equal(batchNeedsApproval(items, 20), true);
    assert.equal(batchNeedsApproval(items.slice(0, 20), 20), false);
  });
});

describe("approvals", () => {
  it("only cover the exact move that was approved", async () => {
    const review = await item("setup.pkg", "Installers/setup.pkg");
    await savePlan(inbox, "test", [review].map((i) => ({ ...i, verdict: "review" as const })));
    assert.deepEqual((await approveItems(inbox, ["setup.pkg"])).approved, ["setup.pkg"]);

    const approved = (await loadPlan(inbox))!.items[0]!;
    assert.equal(isRunnable(approved), true);
    // Same approval, different target: no longer valid.
    assert.equal(isRunnable({ ...approved, target: "Installers/other.pkg" }), false);
    assert.equal(approved.approval?.fingerprint, fingerprint(approved));
  });

  it("run moves approved reviews and leaves unapproved ones", async () => {
    const a = { ...(await item("a.pkg", "Installers/a.pkg")), verdict: "review" as const };
    const b = { ...(await item("b.pkg", "Installers/b.pkg")), verdict: "review" as const };
    await savePlan(inbox, "test", [a, b]);
    await approveItems(inbox, ["a.pkg"]);
    const result = await executePlan(inbox, (await loadPlan(inbox))!.items);
    assert.equal(result.moved, 1);
    assert.ok(existsSync(join(inbox, "Installers/a.pkg")));
    assert.ok(existsSync(join(inbox, "b.pkg")));
  });
});

describe("saved plan integrity", () => {
  it("refuses a plan edited outside Dropzone Zero", async () => {
    await savePlan(inbox, "test", [await item("a.pdf", "Documents/a.pdf")]);
    const text = await readFile(planPath(inbox), "utf8");
    await writeFile(planPath(inbox), text.replace("Documents/a.pdf", "../stolen.pdf"));
    await assert.rejects(loadPlan(inbox), /changed outside Dropzone Zero/);
  });
});

describe("checks on the real disk", () => {
  it("blocks a move into a folder that is a symlink pointing outside", async () => {
    await symlink(outside, join(inbox, "Documents"));
    const step = await moveOne(inbox, "r1", await item("a.pdf", "Documents/a.pdf"));
    assert.equal(step.ok, false);
    assert.match(step.error ?? "", /symbolic link/);
    assert.ok(existsSync(join(inbox, "a.pdf")));
    assert.ok(!existsSync(join(outside, "a.pdf")));
  });

  it("blocks a symlink nested deeper in the target path", async () => {
    await mkdir(join(inbox, "Finance"));
    await symlink(outside, join(inbox, "Finance", "Receipts"));
    const step = await moveOne(inbox, "r1", await item("r.pdf", "Finance/Receipts/r.pdf"));
    assert.match(step.error ?? "", /symbolic link/);
    assert.ok(!existsSync(join(outside, "r.pdf")));
  });

  it("blocks moving a source that is itself a symlink", async () => {
    await writeFile(join(outside, "secret.pdf"), "secret");
    await symlink(join(outside, "secret.pdf"), join(inbox, "link.pdf"));
    const linked: PlanItem = { ...plain({ name: "link.pdf", target: "Documents/link.pdf" }), sha256: await hashFile(join(outside, "secret.pdf")) };
    const step = await moveOne(inbox, "r1", linked);
    assert.match(step.error ?? "", /not a regular file/);
  });
});
