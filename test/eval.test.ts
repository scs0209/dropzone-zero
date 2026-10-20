import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPrompt } from "../src/classify.js";
import { caseFile, ReplayClient, runEval, type EvalCase } from "../src/eval.js";

const CASE: EvalCase = {
  id: "receipt-1",
  split: "test",
  name: "download.pdf",
  text: "Juniper Market\nReceipt #7790\nDecember 3, 2026 20:02\nTotal USD 37.18",
  expected: { category: "receipt", date: "2026-12-03" },
  tags: ["receipt"],
};
const PROMPT = buildPrompt(caseFile(CASE), { kind: "pdf", text: CASE.text, truncated: false });

describe("ReplayClient", () => {
  it("scores recorded replies through the real pipeline", async () => {
    const raw = JSON.stringify({ category: "receipt", date: "2026-12-03", title: "Juniper Market receipt", confidence: 0.9, reason: "Paid." });
    const report = await runEval(new ReplayClient([{ id: CASE.id, prompt: PROMPT, raw, ms: 812 }]), "replay", [CASE], "test");
    assert.equal(report.categoryAccuracy, 1);
    assert.equal(report.dateAccuracy, 1);
    assert.equal(report.invalidRate, 0);
  });

  it("drops a date the document does not show, like any model reply", async () => {
    const raw = JSON.stringify({ category: "receipt", date: "2026-10-20", title: "Juniper Market receipt", confidence: 0.9, reason: "Paid." });
    const report = await runEval(new ReplayClient([{ id: CASE.id, prompt: PROMPT, raw, ms: 812 }]), "replay", [CASE], "test");
    assert.equal(report.results[0]?.got.date, null);
  });

  it("scores a prompt with no recording as invalid", async () => {
    const report = await runEval(new ReplayClient([]), "replay", [CASE], "test");
    assert.equal(report.invalidRate, 1);
  });

  it("keeps the latency measured at recording time", () => {
    assert.equal(new ReplayClient([{ id: CASE.id, prompt: PROMPT, raw: "{}", ms: 812 }]).recordedMs(CASE.id), 812);
  });
});
