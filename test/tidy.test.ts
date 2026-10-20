import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import type { ClassifyResult } from "../src/classify.js";
import type { ScannedFile } from "../src/scan.js";
import { startTidy, type TidyDeps } from "../src/tidy.js";

let inbox: string;

beforeEach(async () => {
  inbox = await mkdtemp(join(tmpdir(), "dz-tidy-"));
  process.env.DZ_REVIEW_GATE = "off";
  await writeFile(join(inbox, "receipt.pdf"), "coffee");
  await writeFile(join(inbox, "setup.pkg"), "installer");
  await writeFile(join(inbox, "big.iso.part"), "half a download");
});

async function classify(file: ScannedFile): Promise<ClassifyResult> {
  const installer = file.ext === ".pkg";
  return {
    category: installer ? "installer" : "receipt",
    date: null,
    newName: file.name,
    folder: installer ? "Installers" : "Finance/Receipts",
    confidence: 0.9,
    reason: "Test.",
    source: "model",
    attempts: 1,
  };
}

const deps = (): TidyDeps => ({ inbox, model: "test", classify });

describe("dz tidy workflow", () => {
  it("suspends with the plan before anything moves", async () => {
    const tidy = await startTidy(deps());
    assert.deepEqual(
      Object.fromEntries(tidy.items.map((i) => [i.name, i.verdict])),
      { "big.iso.part": "block", "receipt.pdf": "allow", "setup.pkg": "review" },
    );
    assert.ok(existsSync(join(inbox, "receipt.pdf")), "nothing moves while suspended");
  });

  it("resumes with the person's choices and moves only what is allowed or approved", async () => {
    const tidy = await startTidy(deps());
    const { cancelled, result } = await tidy.decide({ approve: ["setup.pkg"], confirmed: true });
    assert.equal(cancelled, false);
    assert.equal(result?.moved, 2);
    assert.ok(existsSync(join(inbox, "Finance/Receipts/receipt.pdf")));
    assert.ok(existsSync(join(inbox, "Installers/setup.pkg")));
  });

  it("leaves unapproved review items where they are", async () => {
    const tidy = await startTidy(deps());
    const { result } = await tidy.decide({ approve: [], confirmed: true });
    assert.equal(result?.moved, 1);
    assert.ok(existsSync(join(inbox, "setup.pkg")));
  });

  it("cannot approve a blocked item into running", async () => {
    const tidy = await startTidy(deps());
    const { result } = await tidy.decide({ approve: ["big.iso.part"], confirmed: true });
    assert.equal(result?.moved, 1);
    assert.ok(existsSync(join(inbox, "big.iso.part")));
  });

  it("moves nothing when the person cancels", async () => {
    const tidy = await startTidy(deps());
    const { cancelled, result } = await tidy.decide({ approve: ["setup.pkg"], confirmed: false });
    assert.equal(cancelled, true);
    assert.equal(result, null);
    assert.ok(existsSync(join(inbox, "receipt.pdf")));
  });

  it("keeps Mastra's usage telemetry off", () => {
    assert.equal(process.env.MASTRA_TELEMETRY_DISABLED, "1");
  });
});
