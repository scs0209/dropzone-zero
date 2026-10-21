import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { undoFiles, undoRun } from "../src/execute.js";
import { addedToCalendar, firstDate, markersFor, pendingFollowUps, recordDismissed, followUpFor, labeledDate, recordCalendarAdd, removeFromCalendar, subjectOf, takeBackFromCalendar, toIcs, writeFollowUps } from "../src/followups.js";
import { Journal } from "../src/journal.js";

const TODAY = new Date("2026-10-21T00:00:00Z");

describe("calendar follow-ups", () => {
  it("reads dates in the forms documents use", () => {
    assert.equal(firstDate("Due date 2026-10-31"), "2026-10-31");
    assert.equal(firstDate("due on October 31, 2026"), "2026-10-31");
    assert.equal(firstDate("valid until 3 Oct 2028"), "2028-10-03");
    assert.equal(firstDate("pay by 10/31/2026"), "2026-10-31");
    assert.equal(firstDate("pay by 31/10/2026"), "2026-10-31");
    assert.equal(firstDate("납부기한 2026년 10월 31일"), "2026-10-31");
    assert.equal(firstDate("no date here"), null);
  });

  it("takes the date next to the label, not the first date on the page", () => {
    const invoice = "Invoice INV-3391\nIssued 2026-10-01\nAmount due  USD 12.00\nDue date 2026-10-31";
    assert.equal(labeledDate(invoice, /due date|due/), "2026-10-31");
    assert.equal(labeledDate("Issued 2026-10-01", /due date|due/), null);
  });

  it("makes an event only for what is still ahead and asks something of you", () => {
    const invoice = "Amount due USD 12.00\nDue date 2026-10-31";
    assert.deepEqual(followUpFor("invoice", "Finance/Invoices/2026-10/2026-10-31-pixelwave-hosting-invoice.pdf", invoice, TODAY), {
      title: "Pay: Pixelwave hosting invoice",
      date: "2026-10-31",
    });
    assert.deepEqual(followUpFor("warranty", "Home/Warranties/2028-10-03-cordless-drill-warranty.pdf", "Valid until 2028-10-03", TODAY), {
      title: "Warranty ends: Cordless drill warranty",
      date: "2028-10-03",
    });
    assert.deepEqual(followUpFor("booking", "Travel/Bookings/2026-11/2026-11-14-seaside-hotel-booking.pdf", "", TODAY), {
      title: "Seaside hotel booking",
      date: "2026-11-14",
    });
    assert.equal(followUpFor("invoice", "Finance/Invoices/x.pdf", "Due date 2026-09-30", TODAY), null, "already past");
    assert.equal(followUpFor("receipt", "Finance/Receipts/2026-11-01-x.pdf", "", TODAY), null, "a receipt asks nothing");
    assert.equal(followUpFor("invoice", "Finance/Invoices/x.pdf", "Total USD 12.00", TODAY), null, "no due date written");
  });

  it("writes a valid all-day event with a reminder", () => {
    const ics = toIcs({ title: "Pay: Pixelwave, hosting; invoice", date: "2026-10-31", from: "Finance/Invoices/x.pdf", uid: "0123456789abcdef01234567@dropzone-zero" }, "invoice", TODAY);
    assert.match(ics, /UID:0123456789abcdef01234567@dropzone-zero\r\n/);
    assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
    assert.match(ics, /DTSTART;VALUE=DATE:20261031\r\nDTEND;VALUE=DATE:20261101\r\n/);
    assert.ok(ics.includes("SUMMARY:Pay: Pixelwave\\, hosting\\; invoice\r\n"), "commas and semicolons are escaped");
    assert.match(ics, /TRIGGER:-P1D\r\n/);
    assert.match(ics, /END:VCALENDAR\r\n$/);
    assert.equal(subjectOf("Home/Warranties/2028-10-03-cordless-drill-warranty-2.pdf"), "Cordless drill warranty");
  });

  it("writes follow-ups next to the filed documents, once", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "dz-followups-"));
    await mkdir(join(inbox, "Finance/Invoices/2026-10"), { recursive: true });
    const to = "Finance/Invoices/2026-10/2026-10-01-pixelwave-hosting-invoice.txt";
    await writeFile(join(inbox, to), "Pixelwave Hosting\nInvoice INV-3391\nIssued 2026-10-01\nDue date 2026-10-31\n");
    const moves = [{ from: "invoice.txt", to }, { from: "r.txt", to: "Finance/Receipts/2026-10/r.txt" }];
    const items = [{ name: "invoice.txt", category: "invoice" as const }, { name: "r.txt", category: "receipt" as const }];
    const written = await writeFollowUps(inbox, moves, items, TODAY);
    assert.equal(written.length, 1);
    assert.equal(written[0]!.file, "Calendar/Follow-ups/2026-10-31-pixelwave-hosting-invoice.ics");
    assert.match(await readFile(join(inbox, written[0]!.file), "utf8"), /SUMMARY:Pay: Pixelwave hosting invoice/);
    assert.equal((await writeFollowUps(inbox, moves, items, TODAY)).length, 1, "written again it changes nothing");
    assert.ok(existsSync(join(inbox, written[0]!.file)));
  });

  it("sets a run's follow-ups aside in quarantine when the run is undone", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "dz-followups-undo-"));
    const run = "20261021T000000000Z";
    const docs = [
      { from: "invoice.txt", to: "Finance/Invoices/2026-10/2026-10-01-pixelwave-invoice.txt", text: "Due date 2026-10-31" },
      { from: "warranty.txt", to: "Home/Warranties/2026-01-01-drill-warranty.txt", text: "Valid until 2028-10-03" },
    ];
    const journal = new Journal(inbox, run);
    for (const doc of docs) {
      await mkdir(join(inbox, doc.to, ".."), { recursive: true });
      await writeFile(join(inbox, doc.to), doc.text);
      const sha256 = (await import("node:crypto")).createHash("sha256").update(doc.text).digest("hex");
      await journal.write({ op: "move", from: doc.from, to: doc.to, sha256, state: "done" });
    }
    const items = [{ name: "invoice.txt", category: "invoice" as const }, { name: "warranty.txt", category: "warranty" as const }];
    const written = await writeFollowUps(inbox, docs, items, TODAY, run);
    assert.equal(written.length, 2);

    // Moving back one file sets aside only its follow-up.
    await undoFiles(inbox, run, ["invoice.txt"]);
    assert.ok(!existsSync(join(inbox, written[0]!.file)));
    assert.ok(existsSync(join(inbox, ".dropzone/quarantine/follow-ups", "2026-10-31-pixelwave-invoice.ics")));
    assert.ok(existsSync(join(inbox, written[1]!.file)), "the warranty's follow-up stays");

    // Undoing the whole run sets aside the rest, and deletes nothing.
    await undoRun(inbox, run);
    assert.ok(!existsSync(join(inbox, written[1]!.file)));
    assert.ok(existsSync(join(inbox, ".dropzone/quarantine/follow-ups", "2028-10-03-drill-warranty.ics")));
  });

  it("takes back only the events added from Zee, once, under the run that wrote them", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "dz-followups-cal-"));
    await mkdir(join(inbox, "Finance/Invoices"), { recursive: true });
    const to = "Finance/Invoices/2026-10-01-pixelwave-invoice.txt";
    await writeFile(join(inbox, to), "Due date 2026-10-31");
    const [followUp] = await writeFollowUps(inbox, [{ from: "i.txt", to }], [{ name: "i.txt", category: "invoice" }], TODAY, "run-1");
    assert.match(followUp!.uid, /^[0-9a-f]{24}@dropzone-zero$/);
    const ics = await readFile(join(inbox, followUp!.file), "utf8");
    assert.match(ics, new RegExp(`UID:${followUp!.uid}`));
    assert.ok(ics.includes(`Dropzone Zero ID: ${followUp!.uid}`), "the notes carry our ID, which Calendar keeps");

    assert.deepEqual(await addedToCalendar(inbox, "run-1"), [], "nothing added until the person clicks");
    await recordCalendarAdd(inbox, followUp!);
    assert.deepEqual(await addedToCalendar(inbox, "run-1"), [followUp!.uid]);
    assert.deepEqual(await addedToCalendar(inbox, "run-2"), []);

    const asked: string[][] = [];
    const removed = await takeBackFromCalendar(inbox, [followUp!.uid], async (markers) => (asked.push(markers), 1));
    assert.equal(removed, 1);
    assert.deepEqual(asked, [[`Dropzone Zero ID: ${followUp!.uid}`, `Filed by Dropzone Zero as ${to}`]]);
    assert.deepEqual(await addedToCalendar(inbox, "run-1"), [], "taken back once");

    // What Zee lists after a restart comes from the journal.
    const listed = await pendingFollowUps(inbox);
    assert.deepEqual(listed.map((f) => [f.title, f.date, f.added]), [["Pay: Pixelwave invoice", "2026-10-31", false]]);
    await recordCalendarAdd(inbox, followUp!);
    assert.equal((await pendingFollowUps(inbox))[0]!.added, true);
    await recordDismissed(inbox, followUp!.file);
    assert.deepEqual(await pendingFollowUps(inbox), []);
  });

  it("never asks Calendar about an event it did not make", async () => {
    assert.equal(await removeFromCalendar(["someone-elses-event", 'x" & do shell script "rm -rf ~', "", "Filed by Dropzone Zero as "]), 0);
    assert.deepEqual(markersFor("not-ours", "a.pdf"), []);
  });
});
