import { z } from "zod";
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
  "document",
  "spreadsheet",
  "presentation",
  "image",
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
  /** `images` are base64-encoded files for multimodal models; `schema` constrains the JSON reply. */
  generate(prompt: string, images?: string[], schema?: object): Promise<string>;
}

/**
 * The model reads; code files. The model returns what it can see in the document
 * (category, date, a short title), and the folder and final name are built here,
 * so a 4B model cannot invent folder layouts or stamp today's date on a manual.
 */
export const ClassificationReply = z.object({
  category: z.enum(CATEGORIES),
  date: z.string().nullable(),
  title: z.string(),
  visibleText: z.string().default(""),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

/** The same contract as JSON Schema, for Ollama's structured output. One source, so the two cannot drift. */
export const CLASSIFICATION_SCHEMA = z.toJSONSchema(ClassificationReply);

/** Parses a model reply as JSON. Small models sometimes wrap it in a Markdown fence despite instructions. */
export function readJsonReply(raw: string): unknown {
  try {
    return JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return undefined;
  }
}

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
  document: "letter, contract, report, form, article, or paper that fits none of the above",
  spreadsheet: "table or data export (.xlsx, .csv) that is not a bank statement",
  presentation: "slide deck",
  image: "graphic, diagram, logo, design, or illustration (not a camera photo or screenshot)",
  other: "app settings, data files, or anything you cannot identify",
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
  document: { base: "Documents", monthly: false },
  spreadsheet: { base: "Documents/Spreadsheets", monthly: false },
  presentation: { base: "Documents/Presentations", monthly: false },
  image: { base: "Images", monthly: false },
  other: { base: "Other", monthly: false },
};

export function buildPrompt(file: ScannedFile, content: ExtractedContent): string {
  const body = content.text
    ? `Content${content.truncated ? " (truncated)" : ""}:\n"""\n${content.text}\n"""`
    : content.image
      ? `Content: the image is attached. Look at it. If it shows a document (receipt, ticket, invoice, screen), classify the document, not the picture. If it has no readable text, build the title from the file name, keeping identifiers such as IMG_2034, plus a word or two about what it shows.`
      : `Content: not available (${content.kind} file). Classify from the name and size, with confidence 0.6 or lower, and build the title from the file name, keeping identifiers such as IMG_2034.`;
  const guide = CATEGORIES.map((c) => `- ${c}: ${CATEGORY_GUIDE[c]}`).join("\n");
  return `You sort files in a Downloads folder. Read one file and describe it as JSON.

Reply with JSON only: {"category", "date", "title", "confidence", "reason"}.
- category: exactly one of:
${guide}
- date: the main date written in the content or the file name (purchase, invoice, trip, or event date) as YYYY-MM-DD. Use null if no date is written there. Never use today's date or a guess.
- title: 2 to 6 words naming the vendor or subject and the document type, using only words supported by this file. No date, no extension.
- visibleText: when an image is attached, the most important text you can read in it (vendor, date, total), up to 300 characters. Otherwise "".
- confidence: 0 to 1, how sure you are of the category.
- reason: one short sentence.

File name: ${file.name}
Size: ${file.size} bytes
${body}`;
}

/**
 * Lowercase kebab-case that keeps letters in any script. Accents are dropped
 * (café -> cafe), but Korean, Japanese, and other letters stay: an ASCII-only
 * slug turned every Korean title into an empty name, so those files could never
 * be filed (found by `dz eval`).
 */
export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    // Recompose: NFKD splits Hangul syllables into jamo.
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  // Cut by characters, not UTF-16 units, so a syllable is never split in half.
  return Array.from(slug).slice(0, 60).join("").replace(/-+$/, "");
}

/** Accepts a real calendar date between 1990 and two years from now; anything else becomes null. */
export function normalizeDate(value: unknown, today = new Date()): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
  const year = parsed.getUTCFullYear();
  return year >= 1990 && year <= today.getUTCFullYear() + 2 ? value : null;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * True when the date is written in the evidence in a common form: 2026-10-14,
 * 20261014 (.ics), 2026/10/14, 2026.10.14, 10/14/2026, 14.10.2026, Oct 14, 2026,
 * 14 October 2026, or 2026년 10월 14일.
 */
export function isDateWritten(date: string, evidence: string): boolean {
  const [y, m, d] = date.split("-") as [string, string, string];
  const mm = `0?${Number(m)}`;
  const dd = `0?${Number(d)}`;
  const month = `${MONTH_NAMES[Number(m) - 1]}[a-z]*\\.?`;
  const patterns = [
    `${y}-${m}-${d}`,
    `${y}${m}${d}`,
    `${y}[./]${mm}[./]${dd}`,
    `${mm}[/.-]${dd}[/.-]${y}`,
    `${dd}[/.-]${mm}[/.-]${y}`,
    `${month} ${dd}(?:st|nd|rd|th)?,? ${y}`,
    `${dd}(?:st|nd|rd|th)? ${month},? ${y}`,
    `${y}\\s*년\\s*${mm}\\s*월\\s*${dd}\\s*일`,
  ];
  return patterns.some((pattern) => new RegExp(`(?<!\\d)${pattern}(?!\\d)`, "i").test(evidence));
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
 * For images, the model's own transcription (visibleText) counts as evidence: a
 * weaker check, but it still stops dates that the model did not claim to read.
 */
export function parseClassification(
  raw: string,
  file: Pick<ScannedFile, "ext" | "modifiedAt">,
  evidence: string,
  today = new Date(),
): Classification | null {
  const reply = ClassificationReply.safeParse(readJsonReply(raw));
  if (!reply.success) return null;
  const { category, date, title, visibleText, confidence, reason } = reply.data;

  const validDate = normalizeDate(date, today);
  const seen = `${evidence}\n${visibleText}`;
  const cleanDate = validDate && isDateWritten(validDate, seen) ? validDate : null;
  const target = fileTarget(category, cleanDate, title, file);
  if (!target) return null;

  return {
    category,
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
    let raw: string;
    try {
      raw = await client.generate(prompt, content.image ? [content.image] : undefined, CLASSIFICATION_SCHEMA);
    } catch (error) {
      // Some images (CMYK JPEGs, mislabeled files) fail to decode. Classify those from
      // name and size instead; without an image, a failure means the model itself is down.
      if (!content.image) throw error;
      return classifyFile(client, file, { ...content, image: undefined }, today);
    }
    const parsed = parseClassification(raw, file, evidence, today);
    if (parsed) return { ...parsed, source: "model", attempts: attempt };
  }
  return fallbackClassification(file, maxAttempts);
}
