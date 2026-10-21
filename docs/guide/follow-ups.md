# Calendar follow-ups and receipts to CSV

[← Back to the README](../../README.md)

## Calendar follow-ups

Filing a document is half the job; an invoice still has to be paid. When `dz run`, `dz tidy`, or the watcher behind Zee files an invoice, a booking, or a warranty, Dropzone Zero writes a calendar event for what comes next into `Calendar/Follow-ups/`:

| Filed document | Event | Reminder |
|---|---|---|
| Invoice | "Pay: Pixelwave hosting invoice" on the due date | a day before |
| Booking | "Seaside hotel booking" on the date in its name | a day before |
| Warranty | "Warranty ends: Cordless drill warranty" on the end date | 30 days before |

- **Only dates that are written down.** An invoice's due date and a warranty's end are read from the text right after a label ("Due date", "Pay by", "Valid until", "납부기한", ...) and kept only if the date really appears there; the date Gemma reads is the document's main date (for an invoice, the day it was issued), so it is not used for these. A booking uses the date in its filed name, which was grounded the same way. Photos have no text to read, so they get no follow-up.
- **Only what is still ahead.** Past dates get no event.
- **Nothing reaches your calendar on its own.** The `.ics` files just sit in the folder. Zee lists them under **Coming up** with an **Add to calendar** button, and the Calendar app asks again before it imports one. Everything stays on this machine.
- **Undo takes them back too.** Each follow-up is journaled with its run, so `dz undo` (or **Undo last** in Zee) moves that run's follow-ups into `.dropzone/quarantine/follow-ups/`, never deleting them, and removes the folders it made if they are empty; `dz undo --file` does the same for the files it puts back. An event you added from Zee comes back out of the Calendar app as well. **×** next to an item in Zee takes it off the list and leaves the file.
- **Taking an event back out.** After **Add to calendar**, the button turns into **Remove from calendar**. Removing (and undoing a run) asks the Calendar app, through AppleScript, to delete only events sent from Zee, found by what Dropzone Zero wrote in their notes ("Dropzone Zero ID: …@dropzone-zero"); the Calendar app gives an imported event a UID of its own, so the event's UID cannot be used. The first time, macOS asks whether Zee may control Calendar. Events you add by opening an `.ics` file yourself are left to you.

## Receipts to CSV

After a run, `dz receipts` reads everything under `Finance/Receipts` and `Finance/Invoices` (and anything the saved plan marks as a receipt or invoice but has not moved yet), including photographed receipts, and writes `Finance/receipts-YYYY-MM-DD.csv`:

```csv
date,vendor,kind,total,currency,document_number,file,status
2026-10-11,JUNIPER MARKET,receipt,23.35,USD,0417-22,Finance/Receipts/2026-10/2026-10-11-juniper-market-receipt.jpg,ok
,Pixelwave Hosting,invoice,12.00,USD,INV-3391,Finance/Invoices/2026-10/2026-10-31-pixelwave-hosting-invoice-payment.pdf,check: date
```

The same rule as for file dates applies: a value is kept only if it is printed in the document (`103.99`, `1,234.50`, `1.234,50`, and `12,000` all count). Anything the model cannot point to is left blank, and the row says `check:` with what is missing, so a wrong number never slips into your bookkeeping looking like a right one. On the demo, all six receipts and invoices come out right; the two marked for checking really have no purchase date. Exports never overwrite an earlier one, and cells that start with `=`, `+`, `-`, or `@` are escaped so a spreadsheet will not run them as formulas.
