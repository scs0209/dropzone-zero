import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ClassifyResult } from "../src/classify.js";
import { Daemon, type DaemonState } from "../src/daemon.js";
import type { ScannedFile } from "../src/scan.js";

process.env.DZ_REVIEW_GATE = "off";
process.env.DZ_NOTIFY = "off";

let inbox: string;
let daemon: Daemon;
let base: string;
let listening = true;

async function classify(file: ScannedFile): Promise<ClassifyResult> {
  const installer = file.ext === ".pkg";
  return {
    category: installer ? "installer" : "receipt",
    date: null,
    newName: file.name,
    folder: installer ? "Installers" : "Finance/Receipts",
    confidence: 0.9,
    reason: "Test.",
    source: "model",
    attempts: 1,
  };
}

const call = async (method: string, path: string, body?: unknown, token = daemon.token) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "x-dz-token": token, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as DaemonState & { error?: string } };
};

async function until(check: () => Promise<boolean>, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

before(async () => {
  inbox = await mkdtemp(join(tmpdir(), "dz-daemon-"));
  const infoPath = join(await mkdtemp(join(tmpdir(), "dz-daemon-info-")), "daemon.json");
  daemon = new Daemon({ folder: inbox, model: "test", classify, port: 0, infoPath, settleMs: 0, debounceMs: 50, waitForModel: async () => {} });
  try {
    await daemon.start();
  } catch (error) {
    // Some sandboxes forbid binding a port; the API cannot be exercised there.
    if ((error as NodeJS.ErrnoException).code === "EPERM") listening = false;
    else throw error;
  }
  base = `http://127.0.0.1:${daemon.port}`;
  if (listening) {
    const info = JSON.parse(await readFile(infoPath, "utf8")) as { port: number; token: string };
    assert.equal(info.port, daemon.port);
    assert.equal(info.token, daemon.token);
  }
});

after(async () => {
  if (listening) await daemon.stop();
});

describe("dz daemon API", () => {
  it("refuses requests without the token", async (t) => {
    if (!listening) return t.skip("cannot bind a port here");
    assert.equal((await call("GET", "/state", undefined, "wrong")).status, 401);
  });

  it("answers CORS preflight only for the Zee app's origin", async (t) => {
    if (!listening) return t.skip("cannot bind a port here");
    const ok = await fetch(`${base}/state`, { method: "OPTIONS", headers: { origin: "tauri://localhost" } });
    assert.equal(ok.headers.get("access-control-allow-origin"), "tauri://localhost");
    const other = await fetch(`${base}/state`, { method: "OPTIONS", headers: { origin: "https://example.com" } });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
  });

  it("files a new download, asks about an installer, and acts on the answer", async (t) => {
    if (!listening) return t.skip("cannot bind a port here");
    assert.equal((await call("GET", "/state")).body.mood, "sleeping");

    await writeFile(join(inbox, "receipt.pdf"), "coffee");
    await until(async () => (await call("GET", "/state")).body.recent.length === 1);
    assert.ok(existsSync(join(inbox, "Finance/Receipts/receipt.pdf")));

    await writeFile(join(inbox, "setup.pkg"), "installer");
    await until(async () => (await call("GET", "/state")).body.pending.length === 1);
    const state = (await call("GET", "/state")).body;
    assert.equal(state.mood, "asking");
    const decided = await call("POST", "/decide", { id: state.pending[0]!.id, approve: true });
    assert.equal(decided.body.pending.length, 0);
    await until(async () => existsSync(join(inbox, "Installers/setup.pkg")));
  });

  it("only reveals files it moved itself", async (t) => {
    if (!listening) return t.skip("cannot bind a port here");
    assert.equal((await call("POST", "/reveal", { to: "../../etc/passwd" })).status, 404);
  });

  it("undoes the last run", async (t) => {
    if (!listening) return t.skip("cannot bind a port here");
    const undone = await call("POST", "/undo");
    assert.match(undone.body.message, /Put back 1 file/);
    assert.ok(existsSync(join(inbox, "setup.pkg")));
  });
});

describe("dz daemon moods", () => {
  it("looks busy while the model reads a new download", async (t) => {
    if (!listening) return t.skip("cannot bind a port here");
    const folder = await mkdtemp(join(tmpdir(), "dz-daemon-mood-"));
    const infoPath = join(await mkdtemp(join(tmpdir(), "dz-daemon-info-")), "daemon.json");
    let finishReading!: () => void;
    const reading = new Promise<void>((resolve) => (finishReading = resolve));
    const slow = new Daemon({
      folder,
      model: "test",
      port: 0,
      infoPath,
      settleMs: 0,
      debounceMs: 50,
      waitForModel: async () => {},
      classify: async (file) => {
        await reading;
        return classify(file);
      },
    });
    await slow.start();
    try {
      await writeFile(join(folder, "receipt.pdf"), "coffee");
      await until(async () => slow.state().mood === "thinking");
      assert.equal(slow.state().message, "Reading receipt.pdf...");
      finishReading();
      await until(async () => slow.state().mood === "eating");
      // Deleted by hand inside its new folder: the next state already says it is gone.
      assert.equal(slow.state().recent[0]?.present, true);
      await rm(join(folder, slow.state().recent[0]!.to));
      assert.equal(slow.state().recent[0]?.present, false);
    } finally {
      finishReading();
      await slow.stop();
    }
  });
});
