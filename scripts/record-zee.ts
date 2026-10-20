// Records docs/media/zee.gif: Zee, the real UI against a real daemon, filing a new
// download in a synthetic folder and then asking about an installer. Zee runs in headless Chrome (the daemon already
// accepts the Tauri dev origin, http://localhost:1420), frames are captured over the
// DevTools protocol, and ffmpeg encodes the GIF. Nothing touches ~/Downloads or the
// daemon Zee.app runs: this daemon uses a free port and a temporary info file.
//
// Needs Ollama with gemma4:e4b, Google Chrome, ffmpeg, and `pnpm seed` first.
//   pnpm media:zee

import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { classifyFile } from "../src/classify.js";
import { Daemon } from "../src/daemon.js";
import { extractContent } from "../src/extract.js";
import { OllamaClient } from "../src/ollama.js";

const repo = resolve(import.meta.dirname, "..");
const seedInbox = join(repo, "demo", "inbox");
const folder = join(repo, "demo", "zee", "Downloads");
const framesDir = join(repo, "demo", "zee", "frames");
const output = join(repo, "docs", "media", "zee.gif");
const chromePath = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const UI_PORT = 1420;
const DEBUG_PORT = 9333;
const VIEW = { width: 340, height: 400 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- a synthetic Downloads folder and a real daemon watching it -------------------
await rm(join(repo, "demo", "zee"), { recursive: true, force: true });
await mkdir(folder, { recursive: true });
await mkdir(framesDir, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), "dz-zee-"));

const client = new OllamaClient();
await client.ensureReady();
const daemon = new Daemon({
  folder,
  model: client.model,
  classify: async (file) => classifyFile(client, file, await extractContent(file)),
  waitForModel: () => client.ensureReady(),
  port: 0,
  infoPath: join(temp, "daemon.json"),
  // Shorter waits than a real Downloads folder needs, so the GIF stays short.
  settleMs: 1_500,
  debounceMs: 500,
});
await daemon.start();
const token = (JSON.parse(await readFile(join(temp, "daemon.json"), "utf8")) as { token: string }).token;

/** Drops a seeded file into the folder as if a download just finished. */
async function download(name: string): Promise<void> {
  const to = join(folder, name);
  await copyFile(join(seedInbox, name), to);
  const now = new Date();
  await utimes(to, now, now);
}

type ZeeState = { mood: string; pending: { id: string }[]; recent: unknown[] };

async function state(): Promise<ZeeState> {
  const res = await fetch(`http://127.0.0.1:${daemon.port}/state`, { headers: { "x-dz-token": token } });
  return (await res.json()) as ZeeState;
}

async function waitFor(check: (s: ZeeState) => boolean, timeoutMs = 90_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (check(await state())) return;
    await sleep(250);
  }
  const last = await state();
  throw new Error(`Timed out waiting for Zee (mood ${last.mood}, ${last.pending.length} pending)`);
}

// --- Zee's UI, served the way the Tauri dev server serves it ----------------------
const ui = join(repo, "app", "ui");
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer(async (req, res) => {
  const path = join(ui, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
  if (!path.startsWith(ui)) return void res.writeHead(403).end();
  try {
    const body = await readFile(path.endsWith("/") ? join(path, "index.html") : path);
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((ok) => server.listen(UI_PORT, "127.0.0.1", ok));

// --- headless Chrome, driven over the DevTools protocol ---------------------------
const profile = await mkdtemp(join(tmpdir(), "dz-chrome-"));
const chrome = spawn(chromePath, [
  "--headless=new",
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--hide-scrollbars",
  "--force-color-profile=srgb",
  "about:blank",
]);
let pageWs = "";
for (let i = 0; i < 50 && !pageWs; i++) {
  await sleep(200);
  try {
    const targets = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    pageWs = targets.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? "";
  } catch {
    // Chrome is still starting.
  }
}
if (!pageWs) throw new Error("Chrome did not start");

const socket = new WebSocket(pageWs);
await new Promise((ok) => socket.addEventListener("open", ok, { once: true }));
let nextId = 0;
const waiting = new Map<number, { ok: (result: unknown) => void; fail: (error: Error) => void }>();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
  if (message.id === undefined) return;
  const call = waiting.get(message.id);
  waiting.delete(message.id);
  if (message.error) call?.fail(new Error(message.error.message));
  else call?.ok(message.result);
});
// One call at a time: a click that lands while a screenshot is in flight can stall
// headless Chrome's renderer for good.
let queue: Promise<unknown> = Promise.resolve();
function cdp<T = unknown>(method: string, params: object = {}): Promise<T> {
  const next = queue.then(() => send<T>(method, params));
  queue = next.catch(() => {});
  return next;
}

/** One DevTools call; fails instead of hanging if Chrome errors or never answers. */
function send<T>(method: string, params: object): Promise<T> {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`${method} timed out`)), 10_000);
    waiting.set(id, {
      ok: (result) => (clearTimeout(timer), ok(result as T)),
      fail: (error) => (clearTimeout(timer), fail(error)),
    });
  });
}
const run = (expression: string) => cdp("Runtime.evaluate", { expression, awaitPromise: true });

await cdp("Emulation.setDeviceMetricsOverride", { ...VIEW, deviceScaleFactor: 2, mobile: false });
await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
await cdp("Page.enable");
await cdp("Page.navigate", { url: `http://localhost:${UI_PORT}/index.html?port=${daemon.port}&token=${token}` });
await sleep(1_500);
// The real window is transparent over the desktop; give it a quiet desktop to sit on.
await run(`document.documentElement.style.background = "linear-gradient(160deg, #e9edf0, #cfd8de)"`);

// --- capture frames while the scene plays ---------------------------------------
const frames: { file: string; at: number }[] = [];
const started = Date.now();
const log = (step: string) => console.log(`${((Date.now() - started) / 1000).toFixed(1)}s ${step} (${frames.length} frames)`);
let capturing = true;
const capture = (async () => {
  while (capturing) {
    try {
      const { data } = await cdp<{ data: string }>("Page.captureScreenshot", { format: "png" });
      const file = join(framesDir, `f${String(frames.length).padStart(5, "0")}.png`);
      await writeFile(file, Buffer.from(data, "base64"));
      frames.push({ file, at: Date.now() });
    } catch (error) {
      console.error(`Skipped a frame: ${(error as Error).message}`);
    }
    await sleep(60);
  }
})();

const click = (selector: string) => run(`document.querySelector(${JSON.stringify(selector)})?.click()`);

try {
  await waitFor((s) => s.mood === "sleeping");
  await sleep(1_000);
  await click("#zee"); // open the bubble, so what Zee says can be read throughout
  await sleep(2_000);

  // 1. A receipt arrives: Zee reads it, eats it, files it.
  log("receipt arrives");
  await download("receipt_8d72f1.pdf");
  // "Eating" lasts a moment, so wait for the result rather than the mood.
  await waitFor((s) => s.recent.length > 0);
  await sleep(3_500);

  // 2. An installer arrives: the guard holds it and Zee asks, in the same bubble.
  log("installer arrives");
  await download("Notely-4.2.1.dmg");
  await waitFor((s) => s.mood === "asking", 60_000);
  log("asking");
  // End on the question. (Clicking an answer in headless Chrome stalls its
  // renderer; the terminal GIF shows undo.)
  await sleep(4_000);
} catch (error) {
  console.error(`Scene stopped early: ${(error as Error).message}`);
} finally {
  capturing = false;
  await capture;
  socket.close();
  chrome.kill();
  await new Promise((ok) => (chrome.exitCode !== null ? ok(null) : chrome.once("exit", ok)));
  server.close();
  await daemon.stop();
  await rm(temp, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true }).catch(() => {}); // Chrome may still be flushing its cache
}

// --- encode: real frame timings, 1.5x speed, palette per GIF --------------------
const list = frames
  .map((f, i) => `file '${f.file}'\nduration ${(((frames[i + 1]?.at ?? f.at + 100) - f.at) / 1000 / 1.5).toFixed(3)}`)
  .join("\n");
await writeFile(join(framesDir, "list.txt"), list + `\nfile '${frames.at(-1)!.file}'\n`);
await promisify(execFile)("ffmpeg", [
  "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", join(framesDir, "list.txt"),
  "-vf", "fps=15,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
  output,
]);
console.log(`Wrote ${output} from ${frames.length} frames.`);
