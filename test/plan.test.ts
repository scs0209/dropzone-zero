import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClassifyResult } from "../src/classify.js";
import { buildPlan, QUARANTINE_DIR, summarize } from "../src/plan.js";
import { applyRules } from "../src/rules.js";
import type { ScannedFile } from "../src/scan.js";
import { scrubEvent, scrubText } from "../src/telemetry.js";

function file(name: string, overrides: Partial<ScannedFile> = {}): ScannedFile {
  return {
    name,
    path: `/inbox/${name}`,
    ext: name.slice(name.lastIndexOf(".")).toLowerCase(),
    size: 1200,
    modifiedAt: new Date("2026-10-14T09:00:00Z"),
    ageDays: 6,
    sha256: "0".repeat(64),
    partial: false,
    executable: false,
    ...overrides,
  };
}

function modelResult(overrides: Partial<ClassifyResult> = {}): ClassifyResult {
  return {
    category: "receipt",
    date: "2026-10-14",
    newName: "2026-10-14-bluebird-coffee-receipt.pdf",
    folder: "Finance/Receipts/2026-10",
    confidence: 0.9,
    reason: "Receipt.",
    source: "model",
    attempts: 1,
    ...overrides,
  };
}

describe("applyRules", () => {
  it("skips partial downloads", () => {
    assert.equal(applyRules(file("Unconfirmed 1.crdownload", { partial: true }))?.action, "skip");
  });

  it("quarantines empty files, duplicates, and temp files", () => {
    assert.equal(applyRules(file("Untitled.txt", { size: 0 }))?.action, "quarantine");
    assert.equal(applyRules(file("IMG_1 (1).png", { duplicateOf: "IMG_1.png" }))?.reason, "Duplicate of IMG_1.png.");
    assert.equal(applyRules(file("~$draft.docx"))?.action, "quarantine");
    assert.equal(applyRules(file("cache.tmp"))?.action, "quarantine");
  });

  it("leaves ordinary files to the model", () => {
    assert.equal(applyRules(file("receipt.pdf")), null);
  });

  it("never plans a delete", () => {
    const actions = ["a.part", "b.txt", "c.pdf", "d.tmp"].map(
      (name, i) => applyRules(file(name, { partial: i === 0, size: i === 1 ? 0 : 10, duplicateOf: i === 2 ? "x.pdf" : undefined }))?.action,
    );
    assert.deepEqual(actions, ["skip", "quarantine", "quarantine", "quarantine"]);
  });
});

describe("buildPlan", () => {
  const inbox = "/nonexistent-dz-inbox";

  it("only asks the model about files the rules did not decide", async () => {
    const asked: string[] = [];
    const files = [
      file("Unconfirmed 1.crdownload", { partial: true }),
      file("Untitled.txt", { size: 0 }),
      file("receipt_8d72f1.pdf"),
    ];
    const plan = await buildPlan(files, {
      inbox,
      classify: async (f) => {
        asked.push(f.name);
        return modelResult();
      },
    });
    assert.deepEqual(asked, ["receipt_8d72f1.pdf"]);
    assert.deepEqual(
      plan.map((item) => [item.action, item.target]),
      [
        ["skip", null],
        ["quarantine", `${QUARANTINE_DIR}/Untitled.txt`],
        ["move", "Finance/Receipts/2026-10/2026-10-14-bluebird-coffee-receipt.pdf"],
      ],
    );
  });

  it("holds low-confidence and fallback files for review", async () => {
    const plan = await buildPlan([file("a.pdf"), file("b.pdf")], {
      inbox,
      classify: async (f) =>
        f.name === "a.pdf" ? modelResult({ confidence: 0.3 }) : modelResult({ source: "fallback", confidence: 0.1 }),
    });
    assert.deepEqual(
      plan.map((item) => [item.verdict, item.checks]),
      [
        ["review", ["Low confidence (0.30)"]],
        ["review", ["The model could not classify this file"]],
      ],
    );
  });

  it("holds programs for review and blocks partial downloads", async () => {
    const plan = await buildPlan([file("setup.dmg"), file("run.sh"), file("x.crdownload", { partial: true })], {
      inbox,
      classify: async (f) => modelResult({ category: "installer", folder: "Installers", newName: f.name }),
    });
    assert.deepEqual(
      plan.map((item) => [item.verdict, item.checks[0]]),
      [
        ["review", "Program or installer"],
        ["review", "Program or installer"],
        ["block", "Download still in progress."],
      ],
    );
  });

  it("quarantines files the model calls temp", async () => {
    const plan = await buildPlan([file("scratch.bin")], {
      inbox,
      classify: async () => modelResult({ category: "temp" }),
    });
    assert.equal(plan[0]?.action, "quarantine");
  });

  it("gives colliding targets distinct names", async () => {
    const plan = await buildPlan([file("a.pdf"), file("b.pdf")], { inbox, classify: async () => modelResult() });
    assert.deepEqual(
      plan.map((item) => item.target),
      [
        "Finance/Receipts/2026-10/2026-10-14-bluebird-coffee-receipt.pdf",
        "Finance/Receipts/2026-10/2026-10-14-bluebird-coffee-receipt-2.pdf",
      ],
    );
  });
});

describe("telemetry scrubbing", () => {
  it("removes paths from messages and stack frames", () => {
    assert.equal(
      scrubText("ENOENT: no such file or directory, open '/Users/someone/Downloads/receipt.pdf'"),
      "ENOENT: no such file or directory, open '<path>'",
    );
    const event = scrubEvent({
      type: undefined,
      breadcrumbs: [{ message: "receipt.pdf" }],
      exception: {
        values: [
          {
            type: "Error",
            value: "failed on C:\\Users\\someone\\Downloads\\taxes.pdf",
            stacktrace: { frames: [{ filename: "/Users/someone/dz/src/plan.ts", abs_path: "/Users/someone/dz/src/plan.ts" }] },
          },
        ],
      },
    });
    assert.equal(event.breadcrumbs, undefined);
    assert.equal(event.exception?.values?.[0]?.value, "failed on <path>");
    assert.deepEqual(event.exception?.values?.[0]?.stacktrace?.frames, [{ filename: "plan.ts" }]);
  });
});
