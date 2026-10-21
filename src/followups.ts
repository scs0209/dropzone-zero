// Follow-ups: after a document is filed, the next thing it asks of you becomes a
// calendar event (.ics) in Calendar/Follow-ups. An invoice's due date, a booking's
// date, a warranty's end. Nothing is added to a calendar on its own: Zee offers
// "Add to calendar", and the Calendar app asks before importing.
//
// Dates are read from the document's text next to a label ("Due date", "Valid
// until", ...) and kept only if they are really written there, like every other
// date in Dropzone Zero. A booking uses the date in its filed name, which was
// grounded the same way when it was classified. Everything stays on this machine.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { categoryOfTarget, isDateWritten, normalizeDate, type Category } from "./classify.js";
import { contentKindOf, extractContent } from "./extract.js";
import type { PlanItem } from "./plan.js";

export const FOLLOW_UP_DIR = "Calendar/Follow-ups";

export interface FollowUp {
  /** The .ics file, relative to the folder. */
  file: string;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** The filed document it came from, relative to the folder. */
  from: string;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");

function iso(y: number, m: number, d: number): string | null {
  return normalizeDate(`${y}-${pad(m)}-${pad(d)}`);
}

/** The first date written in `text`, in the forms isDateWritten accepts. */
export function firstDate(text: string): string | null {
  const forms: [RegExp, (m: RegExpMatchArray) => string | null][] = [
    [/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/, (m) => iso(+m[1]!, +m[2]!, +m[3]!)],
    [/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/, (m) => iso(+m[1]!, +m[2]!, +m[3]!)],
    [/([a-z]{3})[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})/i, (m) => monthName(m[1]!, +m[2]!, +m[3]!)],
    [/(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3})[a-z]*\.?,? (\d{4})/i, (m) => monthName(m[2]!, +m[1]!, +m[3]!)],
    // 10/31/2026 is read month first; 31/10/2026 can only be day first.
    [/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/, (m) => (+m[1]! > 12 ? iso(+m[3]!, +m[2]!, +m[1]!) : iso(+m[3]!, +m[1]!, +m[2]!))],
  ];
  let best: { at: number; date: string } | null = null;
  for (const [pattern, toDate] of forms) {
    const match = text.match(pattern);
    const date = match ? toDate(match) : null;
    if (match && date && (!best || match.index! < best.at)) best = { at: match.index!, date };
  }
  return best && isDateWritten(best.date, text) ? best.date : null;
}

function monthName(name: string, day: number, year: number): string | null {
  const month = MONTHS.indexOf(name.toLowerCase().slice(0, 3));
  return month < 0 ? null : iso(year, month + 1, day);
}

/** The date written right after one of the labels, e.g. "Due date 2026-10-31". */
export function labeledDate(text: string, labels: RegExp): string | null {
  for (const match of text.matchAll(new RegExp(labels.source, "gi"))) {
    const date = firstDate(text.slice(match.index! + match[0].length, match.index! + match[0].length + 40));
    if (date) return date;
  }
  return null;
}

const DUE = /due date|payment due|due by|due on|pay by|due|납부\s*기한|결제\s*기한|납기/;
const VALID_UNTIL = /valid until|valid thru|expires on|expires|expiry date|expiry|warranty until|warranty ends|보증\s*기간|만료일?/;

/** "2026-10-31-pixelwave-hosting-invoice.pdf" -> "Pixelwave hosting invoice" */
export function subjectOf(target: string): string {
  const words = basename(target, extname(target))
    .replace(/^\d{4}-\d{2}-\d{2}-?/, "")
    .replace(/-\d+$/, "")
    .replace(/-/g, " ")
    .trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Document";
}

/** What to remember for a filed document, or null when it asks nothing of you. */
export function followUpFor(category: Category | null, target: string, text: string, today = new Date()): Omit<FollowUp, "file" | "from"> | null {
  const subject = subjectOf(target);
  let event: { title: string; date: string | null } | null = null;
  if (category === "invoice") event = { title: `Pay: ${subject}`, date: labeledDate(text, DUE) };
  if (category === "warranty") event = { title: `Warranty ends: ${subject}`, date: labeledDate(text, VALID_UNTIL) };
  if (category === "booking") event = { title: subject, date: basename(target).match(/^(\d{4}-\d{2}-\d{2})-/)?.[1] ?? null };
  if (!event?.date) return null;
  // Only what is still ahead is worth a reminder.
  if (event.date < today.toISOString().slice(0, 10)) return null;
  return { title: event.title, date: event.date };
}

const ALARM: Partial<Record<Category, string>> = { invoice: "-P1D", booking: "-P1D", warranty: "-P30D" };

const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** An all-day event with a reminder, as an .ics file the Calendar app can import. */
export function toIcs(event: Omit<FollowUp, "file">, category: Category, now = new Date()): string {
  const day = event.date.replace(/-/g, "");
  const next = new Date(`${event.date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const uid = createHash("sha256").update(`${event.from}\n${event.date}`).digest("hex").slice(0, 24);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Dropzone Zero//Follow-ups//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}@dropzone-zero`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${day}`,
    `DTEND;VALUE=DATE:${next.toISOString().slice(0, 10).replace(/-/g, "")}`,
    `SUMMARY:${icsText(event.title)}`,
    `DESCRIPTION:${icsText(`Filed by Dropzone Zero as ${event.from}`)}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsText(event.title)}`,
    `TRIGGER:${ALARM[category] ?? "-P1D"}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

/** Writes a follow-up for each filed invoice, booking, or warranty that has a date ahead. */
export async function writeFollowUps(
  inbox: string,
  moves: { from: string; to: string }[],
  items: Pick<PlanItem, "name" | "category">[] = [],
  today = new Date(),
): Promise<FollowUp[]> {
  const written: FollowUp[] = [];
  for (const move of moves) {
    const category = items.find((item) => item.name === move.from)?.category ?? categoryOfTarget(move.to);
    if (category !== "invoice" && category !== "booking" && category !== "warranty") continue;
    const path = join(inbox, move.to);
    const ext = extname(move.to).toLowerCase();
    let text = "";
    try {
      const size = (await stat(path)).size;
      // Text only: a photographed invoice has no text to find a due date in.
      if (contentKindOf(ext) !== "image") {
        text = (await extractContent({ name: basename(move.to), path, ext, size, modifiedAt: new Date(), ageDays: 0, sha256: "", partial: false, executable: false })).text;
      }
    } catch {
      continue;
    }
    const event = followUpFor(category, move.to, text, today);
    if (!event) continue;
    const file = `${FOLLOW_UP_DIR}/${event.date}-${basename(move.to, extname(move.to)).replace(/^\d{4}-\d{2}-\d{2}-/, "")}.ics`;
    const followUp = { ...event, file, from: move.to };
    if (!existsSync(join(inbox, file))) {
      await mkdir(join(inbox, FOLLOW_UP_DIR), { recursive: true });
      await writeFile(join(inbox, file), toIcs(followUp, category, today));
    }
    written.push(followUp);
  }
  return written;
}
