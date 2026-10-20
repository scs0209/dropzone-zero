import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { isDateWritten, normalizeDate, type ModelClient } from "./classify.js";
import { loadPlan } from "./execute.js";
import type { ExtractedContent } from "./extract.js";
import { scanFolder, type ScannedFile } from "./scan.js";

// Receipt-to-CSV: reads the receipts and invoices Dropzone Zero has filed (or
// planned to file) and pulls out vendor, date, and total. As with dates in
// classification, every value must be visible in the document; anything the
// model cannot point to is left blank and the row is marked for checking.

export type ReceiptKind = "receipt" | "invoice";

export const RECEIPT_FOLDERS: Record<ReceiptKind, string> = {
  receipt: "Finance/Receipts",
  invoice: "Finance/Invoices",
};

export interface ReceiptFile {
  file: ScannedFile;
  kind: ReceiptKind;
}

export interface ReceiptRow {
  date: string | null;
  vendor: string | null;
  kind: ReceiptKind;
  total: number | null;
  currency: string | null;
  documentNumber: string | null;
  /** Path relative to the inbox. */
  file: string;
  /** "ok", or "check: ..." naming the values that could not be confirmed in the document. */
  status: string;
}

export const RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    vendor: { type: ["string", "null"] },
    date: { type: ["string", "null"] },
    total: { type: ["number", "null"] },
    currency: { type: ["string", "null"] },
    documentNumber: { type: ["string", "null"] },
    visibleText: { type: "string" },
  },
  required: ["vendor", "date", "total", "currency", "documentNumber", "visibleText"],
} as const;

async function walk(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const dirs = [dir];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) dirs.push(join(entry.parentPath, entry.name));
  }
  return dirs;
}

/**
 * Receipts and invoices in the inbox: files already filed under Finance/ by `dz run`,
 * plus files the saved plan says are receipts or invoices but has not moved yet.
 */
export async function findReceiptFiles(inbox: string): Promise<ReceiptFile[]> {
  const found = new Map<string, ReceiptFile>();
  for (const kind of ["receipt", "invoice"] as const) {
    for (const dir of await walk(join(inbox, RECEIPT_FOLDERS[kind]))) {
      for (const file of await scanFolder(dir)) if (!file.duplicateOf) found.set(file.sha256, { file, kind });
    }
  }
  const plan = await loadPlan(inbox);
  if (plan) {
    const kinds = new Map(plan.items.filter((i) => i.action === "move").map((i) => [i.name, i.category]));
    for (const file of await scanFolder(inbox)) {
      const kind = kinds.get(file.name);
      if ((kind === "receipt" || kind === "invoice") && !found.has(file.sha256)) found.set(file.sha256, { file, kind });
    }
  }
  return [...found.values()].sort((a, b) => a.file.path.localeCompare(b.file.path));
}

export function buildReceiptPrompt(content: ExtractedContent): string {
  const body = content.text
    ? `Document text:\n"""\n${content.text}\n"""`
    : "The document is the attached image.";
  return `Extract bookkeeping fields from one receipt or invoice. Reply with JSON only.
- vendor: the business that issued it, as printed. null if not printed.
- date: purchase or invoice date as YYYY-MM-DD (not a due date or a check-in date). null if not printed.
- total: the final amount paid or due, as a number without currency symbols. null if not printed.
- currency: ISO 4217 code such as USD, EUR, or KRW, only if printed or shown by a symbol. Otherwise null.
- documentNumber: receipt, order, or invoice number, as printed. null if none.
- visibleText: when an image is attached, the vendor, date, and total lines exactly as you read them. Otherwise "".
Never guess: use null for anything not in the document.

${body}`;
}

/** True when the amount appears in the text as printed: 8.30, 1,234.50, 1.234,50, 8,30, or 340 for 340.00. */
export function isAmountWritten(amount: number, evidence: string): boolean {
  const fixed = amount.toFixed(2);
  const [whole, cents] = fixed.split(".") as [string, string];
  const grouped = (sep: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const forms = [`${whole}.${cents}`, `${grouped(",")}.${cents}`, `${grouped(".")},${cents}`, `${whole},${cents}`];
  if (cents === "00") forms.push(whole, grouped(","), grouped("."));
  const escape = (s: string) => s.replace(/[.]/g, "\\.");
  return forms.some((form) => new RegExp(`(?<![\\d.,])${escape(form)}(?![\\d]|[.,]\\d)`).test(evidence));
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim().slice(0, max);
  return text || null;
}

/** Validates the model's answer and keeps only values that appear in the document. */
export function parseReceipt(raw: string, evidence: string): Omit<ReceiptRow, "kind" | "file"> | null {
  let data: unknown;
  try {
    data = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const fields = data as Record<string, unknown>;
  const seen = typeof fields.visibleText === "string" ? `${evidence}\n${fields.visibleText}` : evidence;
  const problems: string[] = [];

  const date = normalizeDate(fields.date);
  const vendor = cleanText(fields.vendor, 80);
  const total = typeof fields.total === "number" && Number.isFinite(fields.total) && fields.total >= 0 ? fields.total : null;
  const documentNumber = cleanText(fields.documentNumber, 40);
  const currency = typeof fields.currency === "string" && /^[A-Z]{3}$/.test(fields.currency) ? fields.currency : null;

  const row = {
    date: date && isDateWritten(date, seen) ? date : null,
    vendor: vendor && seen.toLowerCase().includes(vendor.toLowerCase()) ? vendor : null,
    total: total !== null && isAmountWritten(total, seen) ? total : null,
    currency,
    // A number must contain a digit ("Receipt" alone is a heading, not a number) and be printed.
    documentNumber: documentNumber && /\d/.test(documentNumber) && seen.includes(documentNumber) ? documentNumber : null,
  };
  if (!row.date) problems.push("date");
  if (!row.vendor) problems.push("vendor");
  if (row.total === null) problems.push("total");
  return { ...row, status: problems.length ? `check: ${problems.join(", ")}` : "ok" };
}

export async function extractReceipt(
  client: ModelClient,
  inbox: string,
  { file, kind }: ReceiptFile,
  content: ExtractedContent,
): Promise<ReceiptRow> {
  const prompt = buildReceiptPrompt(content);
  const evidence = `${file.name}\n${content.text}`;
  const base = { kind, file: relative(inbox, file.path) };
  if (!content.text && !content.image) {
    return { ...base, date: null, vendor: null, total: null, currency: null, documentNumber: null, status: "check: no readable content" };
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await client.generate(prompt, content.image ? [content.image] : undefined, RECEIPT_SCHEMA);
    const parsed = parseReceipt(raw, evidence);
    if (parsed) return { ...base, ...parsed };
  }
  return { ...base, date: null, vendor: null, total: null, currency: null, documentNumber: null, status: "check: model output invalid" };
}

/** Quotes per RFC 4180, and defuses cells a spreadsheet would run as a formula. */
function csvCell(value: string | number | null): string {
  if (value === null) return "";
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: ReceiptRow[]): string {
  const header = ["date", "vendor", "kind", "total", "currency", "document_number", "file", "status"];
  const lines = rows.map((r) =>
    [r.date, r.vendor, r.kind, r.total === null ? null : r.total.toFixed(2), r.currency, r.documentNumber, r.file, r.status]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...lines].join("\r\n") + "\r\n";
}
