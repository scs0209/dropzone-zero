import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { classifyFile, fileTarget, type ModelClient } from "../src/classify.js";
import { executePlan } from "../src/execute.js";
import { categoryOfTarget, DEFAULT_RULES, loadRules, parseRules, RULES_FILE, RulesError } from "../src/filing-rules.js";
import { judge } from "../src/guard.js";
import { buildPlan, type PlanItem } from "../src/plan.js";
import { findReceiptFiles } from "../src/receipts.js";
import { scanFolder } from "../src/scan.js";

const PDF = { name: "scan0001.pdf", ext: ".pdf", modifiedAt: new Date("2026-09-30T12:00:00Z") };
const TEXT = "Bluebird Coffee\nReceipt 2026-10-14\nFlat white 4.50\nTotal 4.50";

function reply(category: string, title: string, date: string | null = "2026-10-14"): string {
  return JSON.stringify({ category, date, title, visibleText: "", confidence: 0.9, reason: "Test." });
}

const answering = (raw: string): ModelClient => ({ generate: async () => raw });

describe("filing rules", () => {
  it("files exactly as before when there is no rules file", () => {
    assert.deepEqual(fileTarget("receipt", "2026-10-14", "Bluebird Coffee Receipt", PDF), {
      folder: "Finance/Receipts/2026-10",
      newName: "2026-10-14-bluebird-coffee-receipt.pdf",
    });
    assert.deepEqual(fileTarget("manual", null, "Router quick start", PDF), { folder: "Home/Manuals", newName: "router-quick-start.pdf" });
    // No printed date: the month comes from the file's own date, and no dash is left over.
    assert.deepEqual(fileTarget("photo", null, "Beach", PDF), { folder: "Photos/2026-09", newName: "beach.pdf" });
  });

  it("changes only the kinds the file lists", () => {
    const rules = parseRules(JSON.stringify({
      receipt: { folder: "Money/Receipts/{year}", name: "{title}_{date}" },
      photo: { name: "{date}-{original}" },
    }));
    assert.deepEqual(fileTarget("receipt", "2026-10-14", "Bluebird Coffee", PDF, rules), { folder: "Money/Receipts/2026", newName: "bluebird-coffee_2026-10-14.pdf" });
    assert.deepEqual(fileTarget("photo", "2026-10-14", "Beach", PDF, rules), { folder: "Photos/2026-10", newName: "2026-10-14-scan0001.pdf" });
    assert.equal(rules.invoice, DEFAULT_RULES.invoice);
  });

  it("refuses rules that would leave the folder, hide files, or break names", () => {
    const bad: [object, RegExp][] = [
      [{ receipt: { folder: "../Elsewhere" } }, /cannot use \. or \.\./],
      [{ receipt: { folder: "/Users/me/Receipts" } }, /absolute path/],
      [{ receipt: { folder: "~/Receipts" } }, /absolute path/],
      [{ receipt: { folder: ".dropzone/quarantine" } }, /hidden folder/],
      [{ receipt: { folder: "Finance//Receipts" } }, /empty folder name/],
      [{ receipt: { folder: "Finance\\Receipts" } }, /use \/ between folders/],
      [{ receipt: { folder: "Finance/{day}" } }, /unknown \{day\}/],
      [{ receipt: { name: "{date}" } }, /needs \{title\} or \{original\}/],
      [{ receipt: { name: "x/{title}" } }, /cannot contain/],
      [{ receipt: { name: ".{title}" } }, /cannot start with a dot/],
      [{ receipt: { folder: 5 } }, /must be text/],
      [{ receipt: { where: "Finance" } }, /not a setting/],
      [{ receipts: { folder: "Finance" } }, /not a kind/],
      [{ temp: { folder: "Temp" } }, /always go to quarantine/],
      [["receipt"], /must be an object/],
    ];
    for (const [rules, message] of bad) {
      assert.throws(() => parseRules(JSON.stringify(rules)), (error: Error) => error instanceof RulesError && message.test(error.message), JSON.stringify(rules));
    }
    assert.throws(() => parseRules("{ receipt: }"), /not valid JSON/);
  });

  it("finds the kind of a filed path by the same rules", () => {
    const rules = parseRules(JSON.stringify({ receipt: { folder: "Money/{year}/Receipts" }, invoice: { folder: "Money/{year}/Invoices" } }));
    assert.equal(categoryOfTarget("Money/2026/Receipts/x.pdf", rules), "receipt");
    assert.equal(categoryOfTarget("Money/2026/Invoices/x.pdf", rules), "invoice");
    assert.equal(categoryOfTarget("Finance/Receipts/2026-10/x.pdf"), "receipt");
    assert.equal(categoryOfTarget("Finance/Receipts/x.pdf"), "receipt", "the folder's fixed part still counts");
    assert.equal(categoryOfTarget("Documents/Spreadsheets/x.csv"), "spreadsheet", "the most specific folder wins");
    assert.equal(categoryOfTarget("Somewhere/x.pdf"), null);
  });

  it("files by the folder's rules file, through the same guard", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "dz-rules-"));
    await writeFile(join(inbox, RULES_FILE), JSON.stringify({ receipt: { folder: "Money/Receipts/{year}", name: "{title}-{date}" } }));
    await writeFile(join(inbox, "scan0001.pdf"), TEXT);
    const rules = loadRules(inbox);

    const files = await scanFolder(inbox);
    assert.deepEqual(files.map((f) => f.name), ["scan0001.pdf"], "the rules file itself is never filed");
    const plan = await buildPlan(files, {
      inbox,
      classify: (file) => classifyFile(answering(reply("receipt", "Bluebird Coffee Receipt")), file, { kind: "text", text: TEXT, truncated: false }, undefined, rules),
    });
    assert.equal(plan[0]!.target, "Money/Receipts/2026/bluebird-coffee-receipt-2026-10-14.pdf");
    assert.equal(plan[0]!.verdict, "allow");

    const result = await executePlan(inbox, plan);
    assert.equal(result.moved, 1);
    assert.ok(existsSync(join(inbox, "Money/Receipts/2026/bluebird-coffee-receipt-2026-10-14.pdf")));
    // Bookkeeping export looks where the rules put receipts.
    assert.deepEqual((await findReceiptFiles(inbox)).map((r) => r.kind), ["receipt"]);
  });

  it("does not let a rule skip review or reach a hidden folder", () => {
    const base: PlanItem = {
      name: "setup.dmg", sha256: "0".repeat(64), size: 10, ageDays: 0, action: "move", category: "installer",
      target: "Apps/setup.dmg", confidence: 0.9, reason: "Installer.", source: "model", executable: true, verdict: "allow", checks: [],
    };
    assert.equal(judge(base).verdict, "review", "an installer still waits, wherever a rule sends it");
    const hidden = { ...base, name: "a.pdf", category: "receipt" as const, executable: false, target: "Finance/.secret/a.pdf" };
    assert.deepEqual(judge(hidden), { verdict: "block", checks: ["Target is in a hidden folder"] });
  });
});
