# Your own filing rules

[← Back to the README](../../README.md)

## Choose where files go and how they are named

The built-in layout (`Finance/Receipts/2026-10/2026-10-14-bluebird-coffee-receipt.pdf` and so on) is a default. To change it, put a `.dropzonerules.json` file in the folder and list only the kinds you want to change:

```json
{
  "receipt":    { "folder": "Money/Receipts/{year}", "name": "{title}-{date}" },
  "screenshot": { "folder": "Screens/{year}-{month}" },
  "photo":      { "name": "{date}-{original}" }
}
```

- **Kinds:** `receipt`, `invoice`, `statement`, `booking`, `photo`, `screenshot`, `image`, `manual`, `warranty`, `note`, `document`, `spreadsheet`, `presentation`, `calendar`, `installer`, `other`. Temp files always go to quarantine.
- **`folder`:** a path inside the folder. `{year}` and `{month}` come from the date printed in the document, or from the file's own date when none is printed.
- **`name`:** `{date}` (the printed date, or nothing), `{title}` (what the model read, as a slug), `{category}`, and `{original}` (the name the file arrived with). It must contain `{title}` or `{original}`. The extension is always kept, and a dash left by an empty `{date}` is dropped.

A rule only chooses a path; it does not get past the guard. A rule that points outside the folder, into a hidden folder (including `.dropzone`), or uses `..` is refused when the file is read, and the run stops with a message naming the kind and setting, rather than quietly filing by the defaults. Every move it produces is still judged like any other: an installer still waits for review, a low-confidence guess still waits, and a type change is still blocked. The file is read again on every pass, so an edit applies to the next download without a restart. Calendar follow-ups, receipts to CSV, and Zee's spoken summaries find files by the same rules.
