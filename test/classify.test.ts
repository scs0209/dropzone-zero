import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyFile, normalizeDate, parseClassification, type ModelClient } from "../src/classify.js";
import type { ExtractedContent } from "../src/extract.js";
import type { ScannedFile } from "../src/scan.js";

const TODAY = new Date("2026-10-20T00:00:00Z");

function file(name: string, overrides: Partial<ScannedFile> = {}): ScannedFile {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";
  return {
    name,
    path: `/inbox/${name}`,
    ext,
    size: 1200,
    modifiedAt: new Date("2026-10-14T09:00:00Z"),
    ageDays: 6,
    sha256: "0".repeat(64),
    partial: false,
    ...overrides,
  };
}

const RECEIPT_TEXT = "Bluebird Coffee\nReceipt #8D72F1\n2026-10-14 08:12\nTotal USD 8.30";
const receipt: ExtractedContent = { kind: "pdf", text: RECEIPT_TEXT, truncated: false };

/** Replays canned responses in order and counts calls; no Ollama needed. */
function stubClient(...responses: string[]): ModelClient & { calls: number } {
  return {
    calls: 0,
    async generate() {
      return responses[this.calls++] ?? "";
    },
  };
}

const valid = JSON.stringify({
  category: "receipt",
  date: "2026-10-14",
  title: "Bluebird Coffee receipt",
  confidence: 0.92,
  reason: "Coffee shop receipt with a total.",
});

describe("parseClassification", () => {
  const pdf = file("receipt_8d72f1.pdf");
  const evidence = `${pdf.name}\n${RECEIPT_TEXT}`;

  it("builds the name and folder from the model's reading", () => {
    assert.deepEqual(parseClassification(valid, pdf, evidence, TODAY), {
      category: "receipt",
      date: "2026-10-14",
      newName: "2026-10-14-bluebird-coffee-receipt.pdf",
      folder: "Finance/Receipts/2026-10",
      confidence: 0.92,
      reason: "Coffee shop receipt with a total.",
    });
  });

  it("accepts JSON wrapped in a Markdown fence", () => {
    assert.equal(parseClassification("```json\n" + valid + "\n```", pdf, evidence, TODAY)?.category, "receipt");
  });

  it("rejects malformed or out-of-range output", () => {
    const bad = (patch: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(valid), ...patch });
    for (const raw of [
      "not json",
      "[]",
      bad({ category: "spreadsheet" }),
      bad({ confidence: 1.4 }),
      bad({ confidence: "high" }),
      bad({ title: "!!!" }),
      bad({ reason: undefined }),
    ]) {
      assert.equal(parseClassification(raw, pdf, evidence, TODAY), null, raw);
    }
  });

  it("drops dates that are not written in the file", () => {
    const invented = JSON.stringify({ ...JSON.parse(valid), date: "2024-01-01" });
    const result = parseClassification(invented, pdf, evidence, TODAY);
    assert.equal(result?.date, null);
    // Without a date, the month folder comes from the file's modified time.
    assert.equal(result?.newName, "bluebird-coffee-receipt.pdf");
    assert.equal(result?.folder, "Finance/Receipts/2026-10");
  });

  it("recognizes compact .ics dates", () => {
    const ics = file("invite.ics");
    const raw = JSON.stringify({ category: "calendar", date: "2026-10-29", title: "Meetup", confidence: 1, reason: "Invite." });
    const result = parseClassification(raw, ics, "invite.ics\nDTSTART:20261029T180000Z", TODAY);
    assert.equal(result?.newName, "2026-10-29-meetup.ics");
    assert.equal(result?.folder, "Calendar");
  });
});

describe("normalizeDate", () => {
  it("accepts only real, plausible calendar dates", () => {
    assert.equal(normalizeDate("2026-10-14", TODAY), "2026-10-14");
    assert.equal(normalizeDate("2026-02-30", TODAY), null);
    assert.equal(normalizeDate("1890-01-01", TODAY), null);
    assert.equal(normalizeDate("14/10/2026", TODAY), null);
    assert.equal(normalizeDate(null, TODAY), null);
  });
});

describe("classifyFile", () => {
  it("returns the first valid answer", async () => {
    const client = stubClient(valid);
    const result = await classifyFile(client, file("receipt_8d72f1.pdf"), receipt, TODAY);
    assert.equal(result.source, "model");
    assert.equal(result.attempts, 1);
    assert.equal(client.calls, 1);
  });

  it("retries once after invalid output", async () => {
    const client = stubClient("Sure! Here is the JSON:", valid);
    const result = await classifyFile(client, file("receipt_8d72f1.pdf"), receipt, TODAY);
    assert.equal(result.source, "model");
    assert.equal(result.attempts, 2);
  });

  it("falls back to low-confidence 'other' after two invalid answers", async () => {
    const client = stubClient("{", "{}", valid);
    const result = await classifyFile(client, file("scan0001.pdf"), receipt, TODAY);
    assert.equal(client.calls, 2);
    assert.equal(result.source, "fallback");
    assert.equal(result.category, "other");
    assert.ok(result.confidence < 0.5);
    assert.equal(result.newName, "scan0001.pdf");
  });
});
