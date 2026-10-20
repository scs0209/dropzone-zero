// Turns the synthetic eval cases into prompt/reply pairs for fine-tuning
// (ml/finetune.py). Prompts come from the real buildPrompt, so a fine-tuned model
// sees exactly what `dz eval` and the app send. Only synthetic cases are used.
//
//   pnpm tsx scripts/export-sft.ts > ml/data/sft.jsonl

import { join } from "node:path";
import { buildPrompt } from "../src/classify.js";
import { caseFile, loadCases } from "../src/eval.js";
import { contentKindOf } from "../src/extract.js";

const cases = await loadCases(join(import.meta.dirname, "..", "eval", "cases.jsonl"), "all");
for (const c of cases) {
  const file = caseFile(c);
  const prompt = buildPrompt(file, { kind: contentKindOf(file.ext), text: c.text, truncated: false });
  // The cases label category and date only. The title is the document's first line
  // (vendor or subject) plus the category, which is what the prompt asks for.
  const firstLine = c.text.split("\n")[0]?.trim().slice(0, 40) ?? "";
  const reply = {
    category: c.expected.category,
    date: c.expected.date,
    title: `${firstLine} ${c.expected.category}`.trim(),
    visibleText: "",
    confidence: 0.9,
    reason: `The content reads as a ${c.expected.category}.`,
  };
  process.stdout.write(JSON.stringify({ id: c.id, split: c.split, prompt, reply: JSON.stringify(reply) }) + "\n");
}
