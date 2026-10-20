import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAmountWritten, parseReceipt, toCsv, type ReceiptRow } from "../src/receipts.js";

const TEXT = "Northwind Hardware\nReceipt 2026-10-03\nCordless drill 89.00\nDrill bits (set) 14.99\nTotal USD 103.99";

describe("isAmountWritten", () => {
  it("finds amounts in the ways they are printed", () => {
    assert.ok(isAmountWritten(103.99, TEXT));
    assert.ok(isAmountWritten(1234.5, "Total: 1,234.50"));
    assert.ok(isAmountWritten(1234.5, "Summe 1.234,50 EUR"));
    assert.ok(isAmountWritten(12000, "합계 12,000원"));
    assert.ok(isAmountWritten(340, "Total USD 340.00"));
  });

  it("does not match parts of other numbers", () => {
    assert.ok(!isAmountWritten(3.99, TEXT));
    assert.ok(!isAmountWritten(103.9, TEXT));
    assert.ok(!isAmountWritten(89, "Order 2289.00"));
  });
});

describe("parseReceipt", () => {
  const answer = (patch: Record<string, unknown> = {}) =>
    JSON.stringify({
      vendor: "Northwind Hardware",
      date: "2026-10-03",
      total: 103.99,
      currency: "USD",
      documentNumber: null,
      visibleText: "",
      ...patch,
    });

  it("keeps values that are printed in the document", () => {
    assert.deepEqual(parseReceipt(answer(), TEXT), {
      date: "2026-10-03",
      vendor: "Northwind Hardware",
      total: 103.99,
      currency: "USD",
      documentNumber: null,
      status: "ok",
    });
  });

  it("blanks invented values and asks for a check", () => {
    const row = parseReceipt(answer({ vendor: "Northwind Tools", date: "2026-10-04", total: 104 }), TEXT);
    assert.equal(row?.vendor, null);
    assert.equal(row?.date, null);
    assert.equal(row?.total, null);
    assert.equal(row?.status, "check: date, vendor, total");
  });

  it("rejects document numbers without digits", () => {
    assert.equal(parseReceipt(answer({ documentNumber: "Receipt" }), TEXT)?.documentNumber, null);
    assert.equal(parseReceipt(answer({ documentNumber: "2026-10-03" }), TEXT)?.documentNumber, "2026-10-03");
  });

  it("trusts text the model transcribed from an image", () => {
    const row = parseReceipt(answer({ vendor: "Juniper Market", date: "2026-10-11", total: 23.35, visibleText: "JUNIPER MARKET 2026-10-11 TOTAL USD 23.35" }), "IMG_2041.jpg\n");
    assert.equal(row?.status, "ok");
  });

  it("returns null for output that is not a JSON object", () => {
    assert.equal(parseReceipt("[]", TEXT), null);
    assert.equal(parseReceipt("sure!", TEXT), null);
  });
});

describe("toCsv", () => {
  it("quotes cells and defuses formulas", () => {
    const row: ReceiptRow = {
      date: "2026-10-03",
      vendor: '=HYPERLINK("x")',
      kind: "receipt",
      total: 8.3,
      currency: "USD",
      documentNumber: null,
      file: "Finance/Receipts/a, b.pdf",
      status: "ok",
    };
    assert.equal(
      toCsv([row]),
      'date,vendor,kind,total,currency,document_number,file,status\r\n2026-10-03,"\'=HYPERLINK(""x"")",receipt,8.30,USD,,"Finance/Receipts/a, b.pdf",ok\r\n',
    );
  });
});
