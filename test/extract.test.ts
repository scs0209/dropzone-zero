import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { classifyFile, isDateWritten, parseClassification, type ModelClient } from "../src/classify.js";
import { contentKindOf, officeText } from "../src/extract.js";
import type { ScannedFile } from "../src/scan.js";
import { listZipEntries } from "../src/zip.js";

/** Writes a ZIP with deflated entries, the way Office saves documents. */
function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe("officeText", () => {
  it("reads paragraphs from a .docx", () => {
    const docx = makeZip({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml":
        '<w:document><w:body><w:p><w:r><w:t>Lease renewal</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Rent &amp; deposit</w:t></w:r></w:p></w:body></w:document>',
    });
    assert.equal(officeText(docx).trim(), "Lease renewal\nRent & deposit");
  });

  it("reads sheet names and cell strings from a .xlsx", () => {
    const xlsx = makeZip({
      "xl/workbook.xml": '<workbook><sheets><sheet name="Transactions" sheetId="1"/></sheets></workbook>',
      "xl/sharedStrings.xml": "<sst><si><t>Date</t></si><si><t>Merchant</t></si></sst>",
      "xl/worksheets/sheet1.xml": "<worksheet><sheetData/></worksheet>",
    });
    const text = officeText(xlsx);
    assert.match(text, /Sheet: Transactions/);
    assert.match(text, /Date\nMerchant/);
  });

  it("rejects files that are not ZIP archives", () => {
    assert.throws(() => listZipEntries(Buffer.from("not a zip at all, just some text padding")));
  });

  it("maps extensions to content kinds", () => {
    assert.equal(contentKindOf(".xlsx"), "office");
    assert.equal(contentKindOf(".jpg"), "image");
    assert.equal(contentKindOf(".dmg"), "binary");
  });
});

describe("isDateWritten", () => {
  it("accepts the common ways a date is printed", () => {
    for (const text of [
      "Date: 2026-10-14",
      "DTSTART:20261014T090000Z",
      "2026/10/14",
      "2026.10.14",
      "10/14/2026",
      "14.10.2026",
      "Oct 14, 2026",
      "October 14th 2026",
      "14 Oct. 2026",
      "2026년 10월 14일",
    ]) {
      assert.ok(isDateWritten("2026-10-14", text), text);
    }
  });

  it("does not match other dates or longer numbers", () => {
    assert.ok(!isDateWritten("2026-10-14", "2026-10-15"));
    assert.ok(!isDateWritten("2026-10-14", "Order 1202610141"));
    assert.ok(!isDateWritten("2034-01-01", "IMG_2034.png"));
  });
});

describe("vision", () => {
  const photo: ScannedFile = {
    name: "IMG_2041.jpg",
    path: "/inbox/IMG_2041.jpg",
    ext: ".jpg",
    size: 46_911,
    modifiedAt: new Date("2026-10-11T18:00:00Z"),
    ageDays: 9,
    sha256: "0".repeat(64),
    partial: false,
  };
  const answer = JSON.stringify({
    category: "receipt",
    date: "2026-10-11",
    title: "Juniper Market receipt",
    visibleText: "JUNIPER MARKET 2026-10-11 17:42 TOTAL USD 23.35",
    confidence: 0.95,
    reason: "A photographed grocery receipt.",
  });

  it("sends the image and trusts dates the model transcribed from it", async () => {
    let sent: string[] | undefined;
    const client: ModelClient = {
      async generate(_prompt, images) {
        sent = images;
        return answer;
      },
    };
    const result = await classifyFile(client, photo, { kind: "image", text: "", truncated: false, image: "aGVsbG8=" });
    assert.deepEqual(sent, ["aGVsbG8="]);
    assert.equal(result.newName, "2026-10-11-juniper-market-receipt.jpg");
    assert.equal(result.folder, "Finance/Receipts/2026-10");
  });

  it("drops a date the model did not claim to read", () => {
    const silent = JSON.stringify({ ...JSON.parse(answer), visibleText: "" });
    assert.equal(parseClassification(silent, photo, photo.name)?.date, null);
  });
});

describe("vision fallback", () => {
  it("classifies from metadata when the model cannot decode the image", async () => {
    const calls: (string[] | undefined)[] = [];
    const client: ModelClient = {
      async generate(_prompt, images) {
        calls.push(images);
        if (images) throw new Error("Ollama returned HTTP 400: Failed to load image");
        return JSON.stringify({ category: "photo", date: null, title: "IMG 9001 photo", visibleText: "", confidence: 0.6, reason: "Camera file name." });
      },
    };
    const file: ScannedFile = {
      name: "IMG_9001.jpg", path: "/inbox/IMG_9001.jpg", ext: ".jpg", size: 10, modifiedAt: new Date("2026-10-01T00:00:00Z"),
      ageDays: 19, sha256: "0".repeat(64), partial: false,
    };
    const result = await classifyFile(client, file, { kind: "image", text: "", truncated: false, image: "eA==" });
    assert.deepEqual(calls, [["eA=="], undefined]);
    assert.equal(result.newName, "img-9001-photo.jpg");
  });
});
