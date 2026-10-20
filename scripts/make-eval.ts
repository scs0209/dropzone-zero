// Builds eval/cases.jsonl: synthetic, labeled downloads for measuring and
// improving the classifier. Every vendor, name, and amount is made up, so the
// set can be sent to cloud services (Backboard, Tinker) without exposing anyone's
// files. It aims at what the demo folder made too easy: Korean documents,
// different date formats, misleading file names, and look-alike categories
// (receipt vs invoice, statement vs spreadsheet, note vs document).
// Usage: pnpm eval:make
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Category } from "../src/classify.js";

export interface EvalCase {
  id: string;
  split: "train" | "test";
  name: string;
  text: string;
  expected: { category: Category; date: string | null };
  tags: string[];
}

let seed = 20261021;
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
  return seed / 2 ** 31;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const int = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
const money = (lo: number, hi: number) => (lo + random() * (hi - lo)).toFixed(2);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function randomDate(): { iso: string; y: number; m: number; d: number } {
  const y = pick([2025, 2026, 2026, 2026]);
  const m = int(1, 12);
  const d = int(1, 28);
  return { iso: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, y, m, d };
}

/** The same date, printed the way different documents print it. */
function printed(date: ReturnType<typeof randomDate>, korean = false): string {
  const { y, m, d, iso } = date;
  if (korean) return pick([`${y}년 ${m}월 ${d}일`, `${y}.${String(m).padStart(2, "0")}.${String(d).padStart(2, "0")}`, iso]);
  return pick([
    iso,
    `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`,
    `${MONTHS[m - 1]} ${d}, ${y}`,
    `${MONTHS[m - 1]!.slice(0, 3)} ${d}, ${y}`,
    `${d} ${MONTHS[m - 1]} ${y}`,
  ]);
}

/** Sometimes the file name says nothing useful, as with real downloads. */
function name(good: string, ext: string): string {
  return random() < 0.4 ? `${pick(["scan", "document", "download", "file", "doc"])}${pick(["", "0001", " (3)", "_final", "-1"])}${ext}` : good + ext;
}

type Maker = () => Omit<EvalCase, "id" | "split">;

const shops = ["Bluebird Coffee", "Northwind Hardware", "Juniper Market", "Lumen Books", "Corner Pharmacy", "Pine & Thread"];
const koShops = ["한빛마트", "솔향베이커리", "다온약국", "푸른서점", "바른택시"];

const makers: Record<string, Maker> = {
  receipt: () => {
    const date = randomDate();
    const shop = pick(shops);
    const items = Array.from({ length: int(1, 4) }, () => `${pick(["Coffee beans", "Notebook", "Batteries", "Bread", "Light bulbs", "Tea"])}  ${money(2, 40)}`);
    return {
      name: name(`receipt_${shop.split(" ")[0]!.toLowerCase()}`, ".pdf"),
      text: `${shop}\nReceipt #${int(1000, 9999)}\n${printed(date)} ${int(8, 21)}:${String(int(0, 59)).padStart(2, "0")}\n${items.join("\n")}\nTotal USD ${money(5, 120)}\nPaid by card ending 0000\nThank you!`,
      expected: { category: "receipt", date: date.iso },
      tags: ["receipt"],
    };
  },
  koReceipt: () => {
    const date = randomDate();
    const shop = pick(koShops);
    return {
      name: name("영수증", ".pdf"),
      text: `${shop}\n영수증\n거래일시: ${printed(date, true)} ${int(9, 21)}:${String(int(0, 59)).padStart(2, "0")}\n${pick(["우유", "식빵", "감기약", "소설책", "택시요금"])}  ${int(2, 40) * 500}원\n합계 ${int(5, 90) * 500}원\n카드승인 완료`,
      expected: { category: "receipt", date: date.iso },
      tags: ["receipt", "korean"],
    };
  },
  paidInvoice: () => {
    const date = randomDate();
    return {
      name: name("invoice", ".pdf"),
      // Says "invoice" but is paid: a receipt.
      text: `Invoice / Receipt\nPixelwave Hosting\nDate: ${printed(date)}\nStarter plan  ${money(5, 30)}\nAmount paid USD ${money(5, 30)}\nStatus: PAID - thank you for your payment`,
      expected: { category: "receipt", date: date.iso },
      tags: ["receipt", "lookalike"],
    };
  },
  invoice: () => {
    const date = randomDate();
    const due = randomDate();
    return {
      name: name(`invoice_INV-${int(1000, 9999)}`, ".pdf"),
      text: `${pick(["Cloudnest Ltd.", "Orbit Design Studio", "Greenleaf Utilities"])}\nINVOICE INV-${int(1000, 9999)}\nInvoice date: ${printed(date)}\nDue date: ${printed(due)}\nServices  ${money(50, 900)}\nAmount due USD ${money(50, 900)}\nPlease pay by bank transfer.`,
      expected: { category: "invoice", date: date.iso },
      tags: ["invoice", "two-dates"],
    };
  },
  koInvoice: () => {
    const date = randomDate();
    return {
      name: name("청구서", ".pdf"),
      text: `청구서\n발행일: ${printed(date, true)}\n공급자: 새봄디자인\n디자인 용역  ${int(10, 90) * 10000}원\n청구 금액 ${int(10, 90) * 10000}원\n입금 기한 내 납부 바랍니다.`,
      expected: { category: "invoice", date: date.iso },
      tags: ["invoice", "korean"],
    };
  },
  statement: () => {
    const date = randomDate();
    const rows = Array.from({ length: int(3, 6) }, () => `${randomDate().iso},${pick(shops)},-${money(3, 90)}`);
    return {
      name: name(`statement_${MONTHS[date.m - 1]!.slice(0, 3).toLowerCase()}`, ".csv"),
      text: `Account statement\nStatement date: ${printed(date)}\ndate,description,amount\n${rows.join("\n")}`,
      expected: { category: "statement", date: date.iso },
      tags: ["statement"],
    };
  },
  spreadsheet: () => ({
    name: name(pick(["budget", "inventory", "export (1)", "grades"]), ".csv"),
    // A table, but not account transactions: a spreadsheet.
    text: pick([
      "category,budget,spent\nGroceries,400,312.50\nTransport,150,96.40\nHome,200,103.99",
      "item,count,location\nChairs,12,Room A\nProjectors,2,Storage\nCables,40,Shelf 3",
      "student,quiz1,quiz2\nA,8,9\nB,7,6\nC,10,9",
    ]),
    expected: { category: "spreadsheet", date: null },
    tags: ["spreadsheet", "lookalike"],
  }),
  booking: () => {
    const date = randomDate();
    return pick<Omit<EvalCase, "id" | "split">[]>([
      {
        name: name("booking", ".pdf"),
        text: `Seaside Hotel\nBooking confirmation SH-${int(10000, 99999)}\nCheck-in ${printed(date)} 15:00\nGuests: ${int(1, 4)}\nTotal USD ${money(100, 600)}`,
        expected: { category: "booking", date: date.iso },
        tags: ["booking"],
      },
      {
        name: name("e-ticket", ".pdf"),
        text: `Skyline Air\nE-ticket ${pick(["ZZ", "QX"])}${int(100, 999)}\nDeparts ${printed(date)} 07:30 City A\nSeat ${int(1, 30)}C`,
        expected: { category: "booking", date: date.iso },
        tags: ["booking"],
      },
      {
        name: name("승차권", ".pdf"),
        text: `한결철도 승차권\n승차일: ${printed(date, true)}\n출발 09:10 가람역 → 도착 11:42 누리역\n좌석 ${int(1, 16)}호차 ${int(1, 40)}A`,
        expected: { category: "booking", date: date.iso },
        tags: ["booking", "korean"],
      },
    ]);
  },
  manual: () => ({
    name: name(pick(["manual", "quick_start", "user_guide"]), ".pdf"),
    text: `${pick(["AC-X200 Air Conditioner", "Mesh Router R3", "Kettle K7"])}\n${pick(["Owner's Manual", "Quick Start Guide", "사용 설명서"])}\n1. Unpack the device\n2. Connect power\nTroubleshooting: if the light blinks red, restart.`,
    expected: { category: "manual", date: null },
    tags: ["manual"],
  }),
  warranty: () => {
    const date = randomDate();
    return {
      name: name("warranty", ".pdf"),
      text: `Warranty Card\nProduct: ${pick(["Cordless drill", "Blender B2", "Monitor 27"])}\nSerial: XX-0000-0000\nPurchase date: ${printed(date)}\nCoverage: 2 years`,
      expected: { category: "warranty", date: date.iso },
      tags: ["warranty"],
    };
  },
  note: () => {
    const date = randomDate();
    const dated = random() < 0.5;
    return {
      name: name(pick(["notes", "todo", "meeting-notes"]), pick([".md", ".txt"])),
      text: `${dated ? `# ${date.iso} ` : "# "}${pick(["Book club", "Weekend plan", "Call list"])}\n- ${pick(["Call the landlord", "Return library books", "Buy a gift"])}\n- ${pick(["Pick a date", "Water the plants", "Fix the bike"])}`,
      expected: { category: "note", date: dated ? date.iso : null },
      tags: ["note"],
    };
  },
  calendar: () => {
    const date = randomDate();
    return {
      name: name("invite", ".ics"),
      text: `BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:${date.iso.replaceAll("-", "")}T180000Z\nSUMMARY:${pick(["Open source meetup", "Dentist", "Team dinner"])}\nEND:VEVENT\nEND:VCALENDAR`,
      expected: { category: "calendar", date: date.iso },
      tags: ["calendar"],
    };
  },
  document: () => {
    const date = randomDate();
    return pick<Omit<EvalCase, "id" | "split">[]>([
      {
        name: name("lease_renewal", ".docx"),
        text: `Lease Renewal Agreement\nDate: ${printed(date)}\nThis agreement renews the lease between the tenant and the landlord for twelve months.\nSignatures:`,
        expected: { category: "document", date: date.iso },
        tags: ["document", "lookalike"],
      },
      {
        name: name("report", ".pdf"),
        text: `Quarterly Volunteer Report\nPrepared ${printed(date)}\nSummary: 42 volunteers, 310 hours.\nNext steps: recruit two coordinators.`,
        expected: { category: "document", date: date.iso },
        tags: ["document"],
      },
      {
        name: name("견적서", ".pdf"),
        // A quote asks for nothing yet: a document, not an invoice.
        text: `견적서\n작성일: ${printed(date, true)}\n품목: 홈페이지 리뉴얼\n견적 금액: 3,200,000원\n본 견적은 30일간 유효합니다.`,
        expected: { category: "document", date: date.iso },
        tags: ["document", "korean", "lookalike"],
      },
    ]);
  },
  presentation: () => ({
    name: name(pick(["slides", "pitch_deck", "talk"]), ".pptx"),
    text: `Slide 1: ${pick(["Community Garden Plan", "Q3 Review", "Intro to Composting"])}\nSlide 2: Goals\nSlide 3: Timeline\nSlide 4: Questions?`,
    expected: { category: "presentation", date: null },
    tags: ["presentation"],
  }),
  installer: () => ({
    name: `${pick(["Notely", "SlothPlayer", "PixelPaint"])}-${int(1, 9)}.${int(0, 9)}.${int(0, 9)}${pick([".dmg", ".pkg", "-setup.exe"])}`,
    text: "",
    expected: { category: "installer", date: null },
    tags: ["installer", "no-content"],
  }),
  screenshot: () => {
    const date = randomDate();
    return {
      name: `Screenshot ${date.iso} at ${int(8, 22)}.${String(int(0, 59)).padStart(2, "0")}.${String(int(0, 59)).padStart(2, "0")}.png`,
      text: "",
      expected: { category: "screenshot", date: date.iso },
      tags: ["screenshot", "no-content"],
    };
  },
  photo: () => ({
    name: `IMG_${int(1000, 9999)}.${pick(["jpg", "heic"])}`,
    text: "",
    expected: { category: "photo", date: null },
    tags: ["photo", "no-content"],
  }),
  other: () => ({
    name: name(pick(["settings", "data", "config"]), ".json"),
    text: JSON.stringify({ app: pick(["Notely", "PixelPaint"]), theme: "dark", syncEnabled: false }, null, 2),
    expected: { category: "other", date: null },
    tags: ["other"],
  }),
};

// How many of each, so the set leans on the hard parts without ignoring the easy ones.
const COUNTS: Record<keyof typeof makers, number> = {
  receipt: 18, koReceipt: 12, paidInvoice: 8, invoice: 14, koInvoice: 8, statement: 12, spreadsheet: 12,
  booking: 18, manual: 8, warranty: 8, note: 10, calendar: 6, document: 16, presentation: 6,
  installer: 6, screenshot: 6, photo: 6, other: 6,
};

const cases: EvalCase[] = [];
for (const [kind, count] of Object.entries(COUNTS)) {
  for (let i = 0; i < count; i++) {
    const made = makers[kind]!();
    // One in three goes to the held-out test set; training never sees it.
    cases.push({ id: `${kind}-${i + 1}`, split: i % 3 === 0 ? "test" : "train", ...made });
  }
}

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "eval", "cases.jsonl");
await mkdir(dirname(out), { recursive: true });
await writeFile(out, cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
const test = cases.filter((c) => c.split === "test").length;
console.log(`Wrote ${cases.length} synthetic cases (${cases.length - test} train, ${test} test) to eval/cases.jsonl`);
