import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ModelClient } from "../src/classify.js";
import { loadIndex, search, updateIndex, type Embed } from "../src/search.js";

// A toy embedding: one dimension per topic word, enough to rank by meaning in tests.
const TOPICS = ["receipt", "coffee", "beach", "hotel", "invoice"];
const embed: Embed = async (texts) => texts.map((t) => TOPICS.map((w) => (t.toLowerCase().includes(w) ? 1 : 0)));

function vision(caption: string): ModelClient & { calls: number } {
  return {
    calls: 0,
    async generate() {
      this.calls++;
      return JSON.stringify({ caption, visibleText: "" });
    },
  };
}

async function folder(): Promise<string> {
  const inbox = await mkdtemp(join(tmpdir(), "dz-search-"));
  await mkdir(join(inbox, "Finance/Receipts"), { recursive: true });
  await writeFile(join(inbox, "Finance/Receipts/bluebird.txt"), "Bluebird Coffee receipt, total 8.30");
  await writeFile(join(inbox, "hotel.txt"), "Seaside hotel booking confirmation");
  // A tiny PNG: the vision model is asked to describe it.
  await writeFile(join(inbox, "IMG_0001.png"), Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex"));
  await mkdir(join(inbox, ".dropzone"), { recursive: true });
  await writeFile(join(inbox, ".dropzone/journal.jsonl"), "");
  return inbox;
}

describe("find by description", () => {
  it("indexes documents by their text and images by a description, then finds by meaning", async () => {
    const inbox = await folder();
    const client = vision("A photo of a sunny beach with blue water.");
    const result = await updateIndex(inbox, { client, embed });
    assert.equal(result.total, 3, "Dropzone Zero's own state is not indexed");
    assert.equal(client.calls, 1, "only the image goes to the vision model");
    assert.equal((await search(inbox, "that beach picture", embed, 1))[0]!.path, "IMG_0001.png");
    assert.equal((await search(inbox, "coffee receipt", embed, 1))[0]!.path, "Finance/Receipts/bluebird.txt");
    assert.equal((await search(inbox, "hotel", embed, 1))[0]!.path, "hotel.txt");
  });

  it("reads only new or changed files, and forgets files that are gone", async () => {
    const inbox = await folder();
    const client = vision("A photo of a sunny beach.");
    await updateIndex(inbox, { client, embed });
    const again = await updateIndex(inbox, { client, embed });
    assert.equal(again.indexed, 0);
    assert.equal(client.calls, 1, "the image is not described twice");
    await rm(join(inbox, "hotel.txt"));
    await writeFile(join(inbox, "invoice.txt"), "Pixelwave invoice");
    const after = await updateIndex(inbox, { client, embed });
    assert.equal(after.indexed, 1);
    assert.deepEqual((await loadIndex(inbox)).map((e) => e.path).sort(), ["Finance/Receipts/bluebird.txt", "IMG_0001.png", "invoice.txt"]);
  });
});
