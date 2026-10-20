import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { lastUndoableRun, undoRun } from "./execute.js";
import { fingerprint } from "./guard.js";
import { recentMoves, type RecentMove } from "./recent.js";
import { startWatching, type CycleResult, type WatchControl, type WatchOptions } from "./watch.js";

// `dz daemon`: the watcher plus a small local API, so a desktop UI (the Zee
// character) can show what is happening and pass decisions back with a click.
// The API listens on 127.0.0.1 only and every request needs a random token that
// is written to a file only this user can read. The UI never touches files: it
// asks the daemon, and the daemon goes through the same guard and executor as
// every command.

export const DEFAULT_DAEMON_PORT = 47623;

export function daemonInfoPath(): string {
  return join(homedir(), ".dropzone-zero", "daemon.json");
}

/**
 * Sleeping (watching, nothing to do), thinking (a new download is finishing or
 * being read by the model), eating (just filed something), asking (needs a
 * decision), dizzy (cannot work), or paused.
 */
export type Mood = "sleeping" | "thinking" | "eating" | "asking" | "dizzy" | "paused";

export interface PendingDecision {
  kind: "review" | "batch";
  /** Review items: the move's fingerprint. Batches: the batch key. */
  id: string;
  title: string;
  detail: string;
}

export interface DaemonState {
  folder: string;
  mood: Mood;
  message: string;
  pending: PendingDecision[];
  recent: RecentMove[];
  lastRun: { run: string; moved: number } | null;
}

export interface DaemonOptions extends Omit<WatchOptions, "auto" | "inbox"> {
  folder: string;
  /** 0 picks a free port (tests). */
  port?: number;
  /** Where the port and token are written for the UI; tests pass a temporary path. */
  infoPath?: string;
  debounceMs?: number;
  /** Resolves when the model is reachable; the daemon is "dizzy" until then. */
  waitForModel: () => Promise<void>;
  onEvent?: (result: CycleResult) => void;
}

const DecideBody = z.object({ id: z.string().min(1), approve: z.boolean() });
const RevealBody = z.object({ to: z.string().min(1) });

// The Tauri webview's origins (macOS and Windows/Linux) and its dev server.
const ALLOWED_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420"]);

export class Daemon {
  readonly token = randomBytes(24).toString("hex");
  private server: Server | null = null;
  private control: WatchControl | null = null;
  private eatingUntil = 0;
  private dizzy: string | null = "Waiting for the local model (Ollama)...";
  private paused = false;
  /** Files the model is reading right now, and the latest one, for the bubble. */
  private reading = 0;
  private readingName = "";
  /** New files still being written (downloads in progress). */
  private settling = 0;
  private pending: PendingDecision[] = [];
  private recent: RecentMove[] = [];
  private lastRun: DaemonState["lastRun"] = null;
  private lastMessage = "Watching for new downloads.";

  constructor(private readonly options: DaemonOptions) {}

  state(): DaemonState {
    // Most important first: a question beats news, news beats being busy.
    const [mood, message]: [Mood, string] = this.paused
      ? ["paused", "Paused. New downloads stay where they land."]
      : this.dizzy
        ? ["dizzy", this.dizzy]
        : this.pending.length
          ? ["asking", `${this.pending.length} ${this.pending.length === 1 ? "thing needs" : "things need"} your OK.`]
          : Date.now() < this.eatingUntil
            ? ["eating", this.lastMessage]
            : this.reading
              ? ["thinking", `Reading ${this.readingName}...`]
              : this.settling
                ? ["thinking", `Waiting for ${this.settling === 1 ? "a download" : `${this.settling} downloads`} to finish...`]
                : ["sleeping", this.lastMessage];
    return { folder: this.options.folder, mood, message, pending: this.pending, recent: this.recent, lastRun: this.lastRun };
  }

  /** The port the API listens on, once started. */
  port = 0;

  async start(): Promise<void> {
    const wanted = this.options.port ?? Number(process.env.DZ_DAEMON_PORT ?? DEFAULT_DAEMON_PORT);
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolveListen, rejectListen) => {
      this.server!.once("error", rejectListen);
      this.server!.listen(wanted, "127.0.0.1", () => resolveListen());
    });
    const address = this.server.address();
    this.port = typeof address === "object" && address ? address.port : wanted;
    const infoPath = this.options.infoPath ?? daemonInfoPath();
    await mkdir(dirname(infoPath), { recursive: true, mode: 0o700 });
    await writeFile(infoPath, JSON.stringify({ port: this.port, token: this.token, pid: process.pid, folder: this.options.folder }), { mode: 0o600 });
    this.recent = await recentMoves(this.options.folder, 8);
    await this.options.waitForModel();
    this.dizzy = null;
    this.startWatcher();
  }

  async stop(): Promise<void> {
    this.control?.stop();
    await new Promise<void>((resolveClose) => (this.server ? this.server.close(() => resolveClose()) : resolveClose()));
    await rm(this.options.infoPath ?? daemonInfoPath(), { force: true });
  }

  private startWatcher(): void {
    this.control = startWatching({
      ...this.options,
      inbox: this.options.folder,
      auto: true,
      // Count what the model is reading, so Zee can look busy while it does.
      classify: async (file) => {
        this.reading++;
        this.readingName = file.name;
        try {
          return await this.options.classify(file);
        } finally {
          this.reading--;
        }
      },
      onCycle: (result) => void this.onCycle(result),
      onError: (error) => {
        this.dizzy = `Something went wrong: ${error instanceof Error ? error.message : String(error)}`;
      },
    });
  }

  private async onCycle(result: CycleResult): Promise<void> {
    this.dizzy = null;
    this.settling = result.settling;
    if (result.run?.moved) {
      this.eatingUntil = Date.now() + 4_000;
      this.lastRun = { run: result.run.run, moved: result.run.moved };
      this.lastMessage = `Filed ${result.run.moved} new ${result.run.moved === 1 ? "download" : "downloads"}.`;
    }
    // Every pass, not only after its own moves: the journal is the record, whoever wrote it.
    this.recent = await recentMoves(this.options.folder, 8);
    for (const item of result.needsDecision?.reviews ?? []) {
      this.pending.push({ kind: "review", id: fingerprint(item), title: `${item.name} → ${item.target}`, detail: item.checks.join("; ") });
    }
    const batch = result.needsDecision?.batch;
    if (batch) {
      this.pending.push({ kind: "batch", id: batch.key, title: `Move ${batch.count} new files at once`, detail: "More than the bulk limit arrived together." });
    }
    this.options.onEvent?.(result);
  }

  private authorized(req: IncomingMessage): boolean {
    const given = Buffer.from(String(req.headers["x-dz-token"] ?? ""));
    const expected = Buffer.from(this.token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = String(req.headers.origin ?? "");
    if (ALLOWED_ORIGINS.has(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-allow-headers", "content-type, x-dz-token");
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    }
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    if (!this.authorized(req)) return send(res, 401, { error: "unauthorized" });

    try {
      const route = `${req.method} ${req.url}`;
      if (route === "GET /state") return send(res, 200, this.state());
      if (req.method !== "POST") return send(res, 404, { error: "not found" });
      const body = await readJson(req);

      if (route === "POST /decide") {
        const { id, approve } = DecideBody.parse(body);
        const decision = this.pending.find((p) => p.id === id);
        if (!decision) return send(res, 404, { error: "no such decision" });
        this.pending = this.pending.filter((p) => p !== decision);
        if (approve && decision.kind === "review") this.control?.approveItem(id);
        if (approve && decision.kind === "batch") this.control?.approveBatch(id);
        return send(res, 200, this.state());
      }
      if (route === "POST /reveal") {
        const { to } = RevealBody.parse(body);
        // Only files Dropzone Zero itself put somewhere, never an arbitrary path from the caller.
        if (!this.recent.some((m) => m.to === to && m.present)) return send(res, 404, { error: "not a recent move" });
        await new Promise<void>((ok, fail) => execFile("open", ["-R", join(this.options.folder, to)], (e) => (e ? fail(e) : ok())));
        return send(res, 200, { ok: true });
      }
      if (route === "POST /undo") {
        const run = await lastUndoableRun(this.options.folder);
        if (!run) return send(res, 200, { ...this.state(), message: "Nothing to undo." });
        const result = await undoRun(this.options.folder, run);
        this.recent = await recentMoves(this.options.folder, 8);
        this.lastMessage = `Put back ${result.restored} ${result.restored === 1 ? "file" : "files"}.`;
        return send(res, 200, this.state());
      }
      if (route === "POST /pause") {
        this.paused = true;
        this.control?.stop();
        this.control = null;
        return send(res, 200, this.state());
      }
      if (route === "POST /resume") {
        if (this.paused) {
          this.paused = false;
          this.startWatcher();
        }
        return send(res, 200, this.state());
      }
      return send(res, 404, { error: "not found" });
    } catch (error) {
      return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 10_000) throw new Error("request too large");
  }
  return text ? JSON.parse(text) : {};
}
