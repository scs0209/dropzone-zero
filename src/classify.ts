import type { ExtractedContent } from "./extract.js";
import type { ScannedFile } from "./scan.js";

export const CATEGORIES = [
  "receipt",
  "invoice",
  "booking",
  "photo",
  "screenshot",
  "manual",
  "warranty",
  "statement",
  "note",
  "calendar",
  "installer",
  "temp",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export interface Classification {
  category: Category;
  /** Date found in the content (YYYY-MM-DD), or null when the model saw none. */
  date: string | null;
  /** Kebab-case file name with the original extension, date first when known. */
  newName: string;
  /** Relative folder such as Finance/Receipts/2026-10. */
  folder: string;
  confidence: number;
  reason: string;
}

export interface ClassifyResult extends Classification {
  /** "fallback" means the model never produced valid output and nothing should be moved. */
  source: "model" | "fallback";
  attempts: number;
}

/** Anything that turns a prompt into raw model output. Ollama in production, a stub in tests. */
export interface ModelClient {
  generate(prompt: string): Promise<string>;
}

/**
 * The model reads; code files. The model returns what it can see in the document
 * (category, date, a short title), and the folder and final name are built here,
 * so a 4B model cannot invent folder layouts or stamp today's date on a manual.
 */
export const CLASSIFICATION_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: CATEGORIES },
    date: { type: ["string", "null"] },
    title: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
  },
  required: ["category", "date", "title", "confidence", "reason"],
} as const;

const CATEGORY_GUIDE: Record<Category, string> = {
  receipt: "proof of a payment already made (shop, taxi, order confirmation)",
  invoice: "a bill asking for payment, usually with a due date",
  booking: "hotel, flight, train, or restaurant reservation",
  photo: "a camera photo",
  screenshot: "a screen capture",
  manual: "user manual or quick start guide",
  warranty: "warranty card or certificate",
  statement: "bank or card statement, or a list of account transactions",
  note: "personal notes or meeting notes",
  calendar: "calendar invite (.ics)",
  installer: "software installer or disk image (.dmg, .pkg, .exe, .msi)",
  temp: "temporary or lock file with no lasting value",
  other: "anything else, including app settings and data exports",
};

const FOLDERS: Record<Category, { base: string; monthly: boolean }> = {
  receipt: { base: "Finance/Receipts", monthly: true },
  invoice: { base: "Finance/Invoices", monthly: true },
  statement: { base: "Finance/Statements", monthly: true },
  booking: { base: "Travel/Bookings", monthly: true },
  photo: { base: "Photos", monthly: true },
  screenshot: { base: "Screenshots", monthly: true },
  manual: { base: "Home/Manuals", monthly: false },
  warranty: { base: "Home/Warranties", monthly: false },
  note: { base: "Notes", monthly: false },
  calendar: { base: "Calendar", monthly: false },
  installer: { base: "Installers", monthly: false },
  temp: { base: "Temp", monthly: false },
  other: { base: "Documents", monthly: false },
};

export function buildPrompt(file: ScannedFile, content: ExtractedContent): string {
  const body = content.text
    ? `Content${content.truncated ? " (truncated)" : ""}:\n"""\n${content.text}\n"""`
    : `Content: not available (${content.kind} file). Classify from the name and size, with confidence 0.6 or lower.`;
  const guide = CATEGORIES.map((c) => `- ${c}: ${CATEGORY_GUIDE[c]}`).join("\n");
  return `You sort files in a Downloads folder. Read one file and describe it as JSON.

Reply with JSON only: {"category", "date", "title", "confidence", "reason"}.
- category: exactly one of:
${guide}
- date: the main date written in the content or the file name (purchase, invoice, trip, or event date) as YYYY-MM-DD. Use null if no date is written there. Never use today's date or a guess.
- title: 2 to 6 words naming the vendor or subject and the document type, using only words supported by this file. No date, no extension.
- confidence: 0 to 1, how sure you are of the category.
- reason: one short sentence.

File name: ${file.name}
Size: ${file.size} bytes
${body}`;
}

/** Lowercase kebab-case, ASCII only. */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

/** Accepts a real calendar date between 1990 and two years from now; anything else becomes null. */
export function normalizeDate(value: unknown, today = new Date()): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
  const year = parsed.getUTCFullYear();
  return year >= 1990 && year <= today.getUTCFullYear() + 2 ? value : null;
}

/** True when the date is literally written in the evidence, as 2026-10-14 or 20261014 (the .ics form). */
export function isDateWritten(date: string, evidence: string): boolean {
  return evidence.includes(date) || evidence.includes(date.replaceAll("-", ""));
}

/** Builds the final name and folder from what the model read. */
export function fileTarget(
  category: Category,
  date: string | null,
  title: string,
  file: Pick<ScannedFile, "ext" | "modifiedAt">,
): { newName: string; folder: string } | null {
  const datePrefix = date ? `${date}-` : "";
  const slug = slugify(title).replace(/^\d{4}-\d{2}-\d{2}-?/, "");
  if (!slug) return null;
  const { base, monthly } = FOLDERS[category];
  const month = (date ?? file.modifiedAt.toISOString()).slice(0, 7);
  return { newName: `${datePrefix}${slug}${file.ext}`, folder: monthly ? `${base}/${month}` : base };
}

/**
 * Returns a clean Classification, or null when the output cannot be trusted.
 * `evidence` is the text the model saw (file name and content); a date that does
 * not appear in it is dropped, because small models fill gaps with plausible dates.
 */
export function parseClassification(
  raw: string,
  file: Pick<ScannedFile, "ext" | "modifiedAt">,
  evidence: string,
  today = new Date(),
): Classification | null {
  let data: unknown;
  try {
    // Small models sometimes wrap JSON in a Markdown fence despite instructions.
    data = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const { category, date, title, confidence, reason } = data as Record<string, unknown>;

  if (typeof category !== "string" || !(CATEGORIES as readonly string[]).includes(category)) return null;
  if (typeof title !== "string" || typeof reason !== "string") return null;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;

  const validDate = normalizeDate(date, today);
  const cleanDate = validDate && isDateWritten(validDate, evidence) ? validDate : null;
  const target = fileTarget(category as Category, cleanDate, title, file);
  if (!target) return null;

  return {
    category: category as Category,
    date: cleanDate,
    ...target,
    confidence,
    reason: reason.trim().split("\n")[0]!.slice(0, 160),
  };
}

export function fallbackClassification(file: ScannedFile, attempts: number): ClassifyResult {
  return {
    category: "other",
    date: null,
    newName: file.name,
    folder: FOLDERS.other.base,
    confidence: 0.1,
    reason: "The model did not return valid JSON; left for manual review.",
    source: "fallback",
    attempts,
  };
}

/** Asks the model once, retries once on invalid output, then falls back to a low-confidence "other". */
export async function classifyFile(
  client: ModelClient,
  file: ScannedFile,
  content: ExtractedContent,
  today = new Date(),
): Promise<ClassifyResult> {
  const prompt = buildPrompt(file, content);
  const evidence = `${file.name}\n${content.text}`;
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const parsed = parseClassification(await client.generate(prompt), file, evidence, today);
    if (parsed) return { ...parsed, source: "model", attempts: attempt };
  }
  return fallbackClassification(file, maxAttempts);
}
