// Gives the demo folder a synthetic past: decisions a fictional user made over
// earlier runs, so the review gate has something to learn from on day one. This
// user leaves installers in Downloads until setup is finished, so they keep
// moving them back; anything else they move back only rarely.
// Everything here is generated. Usage: pnpm seed:history [folder]
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Category } from "../src/classify.js";
import type { PlanItem } from "../src/plan.js";
import { SEED_FEEDBACK, type FeedbackRow } from "../src/review.js";

// Deterministic so the demo shows the same result every time.
let state = 2026;
function random(): number {
  state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
  return state / 2 ** 31;
}
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

interface Kind {
  category: Category;
  exts: string[];
  folder: string;
  dated: boolean;
  size: [number, number];
  /** Chance this user moves such a file back. */
  rejectRate: () => number;
}

// Sizes match the demo files (a few hundred bytes to tens of kilobytes), so the
// demo inbox looks like this history; on a real folder, real sizes are learned.
const KINDS: Kind[] = [
  { category: "receipt", exts: [".pdf", ".jpg"], folder: "Finance/Receipts/2026-09", dated: true, size: [600, 50_000], rejectRate: () => 0.03 },
  { category: "invoice", exts: [".pdf"], folder: "Finance/Invoices/2026-09", dated: true, size: [600, 900], rejectRate: () => 0.03 },
  { category: "booking", exts: [".pdf"], folder: "Travel/Bookings/2026-09", dated: true, size: [600, 900], rejectRate: () => 0.05 },
  { category: "photo", exts: [".jpg", ".png"], folder: "Photos/2026-09", dated: false, size: [100, 50_000], rejectRate: () => 0.05 },
  { category: "screenshot", exts: [".png"], folder: "Screenshots/2026-09", dated: true, size: [150, 2_000], rejectRate: () => 0.05 },
  { category: "note", exts: [".txt", ".md"], folder: "Notes", dated: false, size: [50, 2_000], rejectRate: () => 0.05 },
  { category: "spreadsheet", exts: [".xlsx", ".csv"], folder: "Documents/Spreadsheets", dated: false, size: [80, 5_000], rejectRate: () => 0.05 },
  { category: "manual", exts: [".pdf"], folder: "Home/Manuals", dated: false, size: [600, 900], rejectRate: () => 0.03 },
  { category: "installer", exts: [".dmg", ".pkg"], folder: "Installers", dated: false, size: [20_000, 60_000], rejectRate: () => 0.9 },
];

function syntheticRow(n: number, kind: Kind): FeedbackRow {
  const ext = pick(kind.exts);
  const confidence = Math.round((0.55 + random() * 0.45) * 100) / 100;
  // Log-uniform, so small and large files of a kind are equally common.
  const size = Math.round(kind.size[0] * (kind.size[1] / kind.size[0]) ** random());
  const stem = `${kind.dated ? "2026-09-14-" : ""}synthetic-${kind.category}-${n}`;
  const item: PlanItem = {
    name: `synthetic-${n}${ext}`,
    sha256: "0".repeat(64),
    size,
    ageDays: Math.floor(random() * 60),
    action: "move",
    category: kind.category,
    target: `${kind.folder}/${stem}${ext}`,
    confidence,
    reason: "Synthetic history.",
    source: "model",
  };
  return { item, rejected: random() < kind.rejectRate() };
}

async function main(): Promise<void> {
  const inbox = resolve(process.argv[2] ?? "demo/inbox");
  if (!existsSync(join(inbox, ".dropzone-demo"))) {
    throw new Error(`Refusing to write history into ${inbox}: it is not a demo folder (run pnpm seed first).`);
  }
  // Ten past decisions per kind of file, as if from about ten earlier runs.
  const rows = KINDS.flatMap((kind, k) => Array.from({ length: 10 }, (_, n) => syntheticRow(k * 10 + n + 1, kind)));
  await mkdir(join(inbox, ".dropzone"), { recursive: true });
  await writeFile(join(inbox, ".dropzone", SEED_FEEDBACK), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const rejected = rows.filter((row) => row.rejected).length;
  console.log(`Wrote ${rows.length} synthetic past decisions (${rejected} moved back) into ${inbox}/.dropzone/${SEED_FEEDBACK}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
