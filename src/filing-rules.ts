// .dropzonerules.json: where each kind of file goes and how it is named. Optional;
// without it, the defaults below apply. It sits in the folder being organized, next
// to .dropzoneignore, and lists only what you want to change:
//
//   {
//     "receipt":    { "folder": "Money/Receipts/{year}", "name": "{date}-{title}" },
//     "screenshot": { "folder": "Screens/{year}-{month}" },
//     "photo":      { "name": "{date}-{original}" }
//   }
//
// folder: a path inside the folder, with {year} and {month} (from the date printed in
//   the document, or the file's own date when none is printed).
// name: {date}, {title} (what the model read, as a slug), {category}, {original} (the
//   name it arrived with). It must contain {title} or {original}; the extension is
//   always kept, and dashes left by an empty {date} are dropped.
//
// A rule only chooses a path. The guard still judges every move, so a rule cannot
// send a file out of the folder, into a hidden folder, or change its type, and an
// installer still waits for review. A file that breaks these limits stops the run
// with a message, rather than quietly filing by the defaults.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Category } from "./classify.js";

export const RULES_FILE = ".dropzonerules.json";

export interface FilingRule {
  folder: string;
  name: string;
}

export type FilingRules = Record<Category, FilingRule>;

const monthly = (base: string): FilingRule => ({ folder: `${base}/{year}-{month}`, name: "{date}-{title}" });
const flat = (base: string): FilingRule => ({ folder: base, name: "{date}-{title}" });

export const DEFAULT_RULES: FilingRules = {
  receipt: monthly("Finance/Receipts"),
  invoice: monthly("Finance/Invoices"),
  statement: monthly("Finance/Statements"),
  booking: monthly("Travel/Bookings"),
  photo: monthly("Photos"),
  screenshot: monthly("Screenshots"),
  manual: flat("Home/Manuals"),
  warranty: flat("Home/Warranties"),
  note: flat("Notes"),
  calendar: flat("Calendar"),
  installer: flat("Installers"),
  temp: flat("Temp"),
  document: flat("Documents"),
  spreadsheet: flat("Documents/Spreadsheets"),
  presentation: flat("Documents/Presentations"),
  image: flat("Images"),
  other: flat("Other"),
};

const FOLDER_FIELDS = ["year", "month"];
const NAME_FIELDS = ["date", "title", "category", "original"];

export class RulesError extends Error {
  override name = "RulesError";
}

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!);
}

/** Why a folder template is unsafe or unusable, or null when it is fine. */
function folderProblem(folder: string): string | null {
  const unknown = placeholders(folder).filter((p) => !FOLDER_FIELDS.includes(p));
  if (unknown.length) return `unknown {${unknown[0]}}; folders can use {year} and {month}`;
  if (/[\\\0]/.test(folder)) return "use / between folders";
  if (folder.startsWith("/") || folder.startsWith("~")) return "must be a path inside the folder, not an absolute path";
  const segments = folder.replace(/\/+$/, "").split("/");
  if (segments.some((s) => s.trim() === "")) return "has an empty folder name";
  if (segments.some((s) => s === "." || s === "..")) return "cannot use . or ..";
  if (segments.some((s) => s.startsWith("."))) return "cannot go into a hidden folder";
  return null;
}

/** Why a name template is unusable, or null when it is fine. */
function nameProblem(name: string): string | null {
  const used = placeholders(name);
  const unknown = used.filter((p) => !NAME_FIELDS.includes(p));
  if (unknown.length) return `unknown {${unknown[0]}}; names can use {date}, {title}, {category}, and {original}`;
  if (!used.includes("title") && !used.includes("original")) return "needs {title} or {original}";
  if (/[/\\\0]/.test(name)) return "cannot contain / or \\";
  if (name.startsWith(".")) return "cannot start with a dot";
  return null;
}

/** Parses the rules file's text, filling in the defaults for whatever it leaves out. */
export function parseRules(text: string): FilingRules {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new RulesError(`${RULES_FILE} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new RulesError(`${RULES_FILE} must be an object of kinds, such as { "receipt": { "folder": "..." } }`);
  }
  const rules: FilingRules = { ...DEFAULT_RULES };
  for (const [kind, value] of Object.entries(data)) {
    const where = `${RULES_FILE}: ${kind}`;
    if (!(kind in DEFAULT_RULES)) throw new RulesError(`${where} is not a kind; use one of ${Object.keys(DEFAULT_RULES).join(", ")}`);
    if (kind === "temp") throw new RulesError(`${where}: temp files always go to quarantine`);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RulesError(`${where} must be { "folder": ..., "name": ... }`);
    const extra = Object.keys(value).filter((key) => key !== "folder" && key !== "name");
    if (extra.length) throw new RulesError(`${where}.${extra[0]} is not a setting; use "folder" and "name"`);
    const { folder, name } = value as { folder?: unknown; name?: unknown };
    if (folder !== undefined && typeof folder !== "string") throw new RulesError(`${where}.folder must be text`);
    if (name !== undefined && typeof name !== "string") throw new RulesError(`${where}.name must be text`);
    const folderIssue = folder === undefined ? null : folderProblem(folder);
    if (folderIssue) throw new RulesError(`${where}.folder ${folderIssue}`);
    const nameIssue = name === undefined ? null : nameProblem(name);
    if (nameIssue) throw new RulesError(`${where}.name ${nameIssue}`);
    const base = rules[kind as Category];
    rules[kind as Category] = { folder: folder?.replace(/\/+$/, "") ?? base.folder, name: name ?? base.name };
  }
  return rules;
}

/** The rules for a folder: its .dropzonerules.json over the defaults. Read on every call, so edits apply at once. */
export function loadRules(inbox: string): FilingRules {
  const path = join(inbox, RULES_FILE);
  if (!existsSync(path)) return DEFAULT_RULES;
  return parseRules(readFileSync(path, "utf8"));
}

export interface TargetFields {
  category: Category;
  /** YYYY-MM-DD printed in the document, or null. */
  date: string | null;
  /** The model's title, already a slug. */
  title: string;
  /** The name the file arrived with, without its extension. */
  original: string;
  /** Where {year} and {month} come from when no date is printed. */
  modifiedAt: Date;
  ext: string;
}

/** A rule's folder for one file: {year} and {month} from the printed date, or the file's own date. */
export function resolveFolder(rule: FilingRule, date: string | null, modifiedAt: Date): string {
  const when = date ?? modifiedAt.toISOString();
  return rule.folder.replace(/\{year\}/g, when.slice(0, 4)).replace(/\{month\}/g, when.slice(5, 7));
}

/** Fills a rule in. Null when the name comes out empty. */
export function resolveTarget(rule: FilingRule, fields: TargetFields): { folder: string; newName: string } | null {
  const folder = resolveFolder(rule, fields.date, fields.modifiedAt);
  const values: Record<string, string> = { date: fields.date ?? "", title: fields.title, category: fields.category, original: fields.original };
  const stem = rule.name
    .replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_. ]+|[-_. ]+$/g, "");
  if (!stem) return null;
  return { folder, newName: `${stem}${fields.ext}` };
}

/** A rule's folder as a regular expression source: {year} and {month} match any year and month. */
function folderPattern(folder: string): string {
  return folder
    .split(/(\{year\}|\{month\})/)
    .map((part) => (part === "{year}" ? "\\d{4}" : part === "{month}" ? "\\d{2}" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
}

/**
 * The kind whose folder a path is in, e.g. Finance/Receipts/2026-10/x.pdf -> receipt.
 * A full match on a rule's folder wins (the most specific one); failing that, the
 * folder's fixed part counts too, so Finance/Receipts/x.pdf is still a receipt.
 */
export function categoryOfTarget(target: string, rules: FilingRules = DEFAULT_RULES): Category | null {
  const longest = (toPattern: (rule: FilingRule) => string | null): Category | null => {
    let best: Category | null = null;
    let length = -1;
    for (const [category, rule] of Object.entries(rules) as [Category, FilingRule][]) {
      const pattern = toPattern(rule);
      if (pattern !== null && new RegExp(`^${pattern}(?:/|$)`).test(target) && pattern.length > length) {
        best = category;
        length = pattern.length;
      }
    }
    return best;
  };
  return (
    longest((rule) => folderPattern(rule.folder)) ??
    longest((rule) => (fixedPrefix(rule) ? folderPattern(fixedPrefix(rule)) : null))
  );
}

/** The fixed part of a rule's folder, before any placeholder: where to start looking for its files. */
export function fixedPrefix(rule: FilingRule): string {
  const segments = rule.folder.split("/");
  const firstVariable = segments.findIndex((s) => s.includes("{"));
  return (firstVariable === -1 ? segments : segments.slice(0, firstVariable)).join("/");
}
