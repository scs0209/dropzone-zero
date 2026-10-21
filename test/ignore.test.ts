import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ignoreMatcher } from "../src/ignore.js";
import { scanFolder } from "../src/scan.js";

describe(".dropzoneignore", () => {
  const ignored = ignoreMatcher("# private\n*.key\nTaxes/\nScans/*.pdf\n");

  it("matches names anywhere, folders and what is in them, and paths from the top", () => {
    for (const path of ["deck.key", "Work/deck.key", "Taxes", "Taxes/2025.pdf", "Old/Taxes/2025.pdf", "Scans/a.pdf"]) assert.ok(ignored(path), path);
    for (const path of ["other.pdf", "TaxesNot.pdf", "Scans/Sub/a.pdf", "deck.key.pdf"]) assert.ok(!ignored(path), path);
  });

  it("keeps ignored files out of every scan, so they are never read or moved", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "dz-ignore-"));
    await writeFile(join(inbox, ".dropzoneignore"), "*.key\npassport*\n");
    for (const name of ["deck.key", "passport-scan.pdf", "receipt.pdf"]) await writeFile(join(inbox, name), name);
    assert.deepEqual((await scanFolder(inbox)).map((f) => f.name), ["receipt.pdf"]);
  });
});
