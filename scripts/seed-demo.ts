// Builds a messy, Downloads-style demo folder with 30 synthetic files.
// Every name, company, and amount is fictional. Usage: pnpm seed [folder]
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";

const MARKER = ".dropzone-demo";
const DAY = 86_400_000;

function pdf(lines: string[]): Buffer {
  const escape = (text: string) => text.replace(/[\\()]/g, (c) => `\\${c}`);
  const body = lines.map((line, i) => `${i === 0 ? "" : "0 -18 Td "}(${escape(line)}) Tj`).join("\n");
  const stream = `BT /F1 12 Tf 72 740 Td\n${body}\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out);
}

function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => rgb[i % 3]!)]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function filler(size: number, seed: number): Buffer {
  return Buffer.from(Buffer.alloc(size).map((_, i) => (i * 31 + seed) % 251));
}

const receiptCoffee = pdf(["Bluebird Coffee", "Receipt #8D72F1", "2026-10-14 08:12", "Flat white  4.50", "Almond croissant  3.80", "Total  USD 8.30", "Paid by card ending 0000"]);
const receiptHardware = pdf(["Northwind Hardware", "Receipt 2026-10-03", "Cordless drill  89.00", "Drill bits (set)  14.99", "Total  USD 103.99"]);
const manualAc = pdf(["AC-X200 Split Air Conditioner", "Owner's Manual", "Cleaning the filter: every 2 weeks", "Error code E4: check drain hose", "Warranty: 2 years from purchase"]);
const photo2034 = png(64, 48, [94, 140, 186]);

interface DemoFile {
  name: string;
  content: Buffer;
  ageDays: number;
}

const files: DemoFile[] = [
  // Receipts and invoices
  { name: "receipt_8d72f1.pdf", content: receiptCoffee, ageDays: 6 },
  { name: "Receipt-2026-10-03.pdf", content: receiptHardware, ageDays: 17 },
  { name: "order-confirmation-55102.pdf", content: pdf(["Lumen Books", "Order 55102 confirmed", "The Patient Gardener (paperback)  18.00", "Shipping  4.00", "Total  USD 22.00"]), ageDays: 12 },
  { name: "invoice_INV-3391.pdf", content: pdf(["Pixelwave Hosting", "Invoice INV-3391", "Period: October 2026", "Starter plan  12.00", "Amount due  USD 12.00", "Due date 2026-10-31"]), ageDays: 9 },
  { name: "scan0001.pdf", content: pdf(["Metro Cab Co.", "Trip receipt", "Airport -> Central Station", "Fare  USD 38.40", "2026-10-08 22:47"]), ageDays: 11 },
  // Bookings
  { name: "booking.pdf", content: pdf(["Seaside Hotel", "Booking confirmation SH-77120", "Check-in  2026-11-14 15:00", "Check-out 2026-11-16 11:00", "Guests: 2", "Total  USD 340.00"]), ageDays: 4 },
  { name: "e-ticket_ZZ123.pdf", content: pdf(["Skyline Air", "E-ticket ZZ123", "Departs 2026-11-14 07:30  City A", "Arrives 2026-11-14 09:05  City B", "Seat 14C"]), ageDays: 4 },
  { name: "reservation (2).pdf", content: pdf(["Harbor Bistro", "Table reservation", "2026-10-24 19:30", "Party of 4", "Reference HB-2219"]), ageDays: 2 },
  // Photos and screenshots
  { name: "IMG_2034.png", content: photo2034, ageDays: 20 },
  { name: "IMG_2035.png", content: png(64, 48, [214, 168, 82]), ageDays: 20 },
  { name: "IMG_2036.png", content: png(64, 48, [96, 160, 104]), ageDays: 20 },
  { name: "Screenshot 2026-10-12 at 09.41.22.png", content: png(120, 80, [236, 236, 240]), ageDays: 8 },
  { name: "photo.png", content: png(48, 48, [180, 120, 160]), ageDays: 15 },
  // Manuals and warranties
  { name: "AC-X200_manual.pdf", content: manualAc, ageDays: 30 },
  { name: "router_quick_start.pdf", content: pdf(["Mesh Router R3", "Quick Start Guide", "1. Plug in the router", "2. Scan the QR code on the back", "3. Default network name: MESH-R3"]), ageDays: 25 },
  { name: "warranty_card.pdf", content: pdf(["Warranty Card", "Product: Cordless drill", "Serial: ND-0000-0000", "Valid until 2028-10-03"]), ageDays: 17 },
  // Spreadsheets and data exports
  { name: "statement_oct.csv", content: Buffer.from("date,description,amount\n2026-10-03,Northwind Hardware,-103.99\n2026-10-08,Metro Cab Co.,-38.40\n2026-10-14,Bluebird Coffee,-8.30\n"), ageDays: 3 },
  { name: "export (1).csv", content: Buffer.from("category,budget,spent\nGroceries,400,312.50\nTransport,150,96.40\nHome,200,103.99\n"), ageDays: 5 },
  { name: "data.json", content: Buffer.from(JSON.stringify({ app: "Notely", version: "4.2.1", theme: "dark", syncEnabled: false }, null, 2)), ageDays: 14 },
  // Notes
  { name: "notes.txt", content: Buffer.from("Call the landlord about the heater.\nReturn library books by Friday.\n"), ageDays: 7 },
  { name: "meeting-notes.md", content: Buffer.from("# Book club\n\n- Next pick: The Patient Gardener\n- Host: rotating\n- Date: 2026-11-02\n"), ageDays: 10 },
  // Calendar invite
  { name: "invite.ics", content: Buffer.from("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Demo//EN\r\nBEGIN:VEVENT\r\nUID:demo-meetup-1@example.com\r\nDTSTART:20261029T180000Z\r\nDTEND:20261029T200000Z\r\nSUMMARY:Local open source meetup\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"), ageDays: 6 },
  // Installers that are usually safe to clear after setup
  { name: "Notely-4.2.1.dmg", content: filler(48_000, 7), ageDays: 60 },
  { name: "SlothPlayer-setup.pkg", content: filler(32_000, 11), ageDays: 75 },
  // Temporary and in-progress files
  { name: "Unconfirmed 48211.crdownload", content: filler(9_000, 3), ageDays: 0 },
  { name: "~$draft.tmp", content: filler(512, 5), ageDays: 40 },
  { name: "Untitled.txt", content: Buffer.alloc(0), ageDays: 45 },
  // Duplicates downloaded twice
  { name: "IMG_2034 (1).png", content: photo2034, ageDays: 19 },
  { name: "Receipt-2026-10-03 (1).pdf", content: receiptHardware, ageDays: 16 },
  { name: "AC-X200_manual (1).pdf", content: manualAc, ageDays: 29 },
];

async function prepareFolder(dir: string): Promise<void> {
  if (existsSync(dir)) {
    const entries = await readdir(dir);
    if (entries.length > 0 && !entries.includes(MARKER)) {
      throw new Error(`Refusing to wipe ${dir}: it is not empty and was not created by this script.`);
    }
    await rm(dir, { recursive: true, force: true });
  }
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, MARKER), "Created by scripts/seed-demo.ts. Safe to delete.\n");
}

async function main(): Promise<void> {
  const dir = resolve(process.argv[2] ?? "demo/inbox");
  await prepareFolder(dir);
  const now = Date.now();
  for (const file of files) {
    const path = join(dir, file.name);
    await writeFile(path, file.content);
    const time = new Date(now - file.ageDays * DAY);
    await utimes(path, time, time);
  }
  console.log(`Seeded ${files.length} demo files into ${dir}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
