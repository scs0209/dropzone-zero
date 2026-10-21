import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { lastUndoableRun, undoRun } from "./execute.js";
import { fingerprint } from "./guard.js";
import { recentMoves, type RecentMove } from "./recent.js";
import { addedToCalendar, pendingFollowUps, recordCalendarAdd, recordDismissed, removeFromCalendar, takeBackFromCalendar, type FollowUp, type RemoveEvents } from "./followups.js";
import type { ModelClient } from "./classify.js";
import { loadRules } from "./filing-rules.js";
import type { RemoteApprover } from "./remote-approval.js";
import { hitId, search as searchIndex, updateIndex, type Embed, type SearchHit } from "./search.js";
import { spokenQuestion, spokenSummary, type Voice } from "./voice.js";
import { startWatching, type CycleResult, type WatchControl, type WatchOptions } from "./watch.js";

// `dz daemon`: the watcher plus a small local API, so a desktop UI (the Zee
// character) can show what is happening and pass decisions back with a click.
// The API listens on 127.0.0.1 only and every request needs a random token that
// is written to a file only this user can read. The UI never touches files: it
// asks the daemon, and the daemon goes through the same guard and executor as
// every command.

export const DEFAULT_DAEMON_PORT = 47623;
/** Enough history that Zee can still show a full list after some files were deleted or undone. */
const RECENT_LIMIT = 30;

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
  /** Calendar follow-ups for what was filed; `added` once sent to the Calendar app from Zee. */
  followUps: (FollowUp & { added?: boolean })[];
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
  /** Also asks each question on the approver's phone (Auth0 CIBA); whichever answer comes first counts. */
  remoteApprover?: Pick<RemoteApprover, "ask"> | null;
  /** Zee says what it filed and when it needs an OK (ElevenLabs); kinds and counts only. */
  voice?: Pick<Voice, "say"> | null;
  /** Deletes Dropzone Zero's own events (by UID) from the Calendar app; tests pass a fake. */
  removeEvents?: RemoveEvents;
  /** Search by description: the local model for image captions and EmbeddingGemma for vectors. */
  search?: { client: ModelClient; embed: Embed } | null;
}

const DecideBody = z.object({ id: z.string().min(1), approve: z.boolean() });
const RevealBody = z.object({ to: z.string().min(1) });
const CalendarBody = z.object({ file: z.string().min(1) });
const SearchBody = z.object({ query: z.string().min(1).max(300) });
const FoundBody = z.object({ id: z.string().min(1) });

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
  private followUps: (FollowUp & { added?: boolean })[] = [];
  /** The last search's hits by id, so Zee can open one without sending a path back. */
  private found = new Map<string, string>();
  private indexing: Promise<void> | null = null;
  private indexAgain = false;
  private lastMessage = "Watching for new downloads.";
  /** Questions also out on the approver's phone, so an answer in Zee can call them off. */
  private remote = new Map<string, AbortController>();
  /** Resolves after the watcher's first pass, which records the files already in the folder. */
  private firstPass!: Promise<void>;
  private firstPassDone: () => void = () => {};

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
    // Re-check that each file is still where it was filed: a person may have deleted or moved
    // it since, and that happens inside subfolders the watcher does not look at.
    const recent = this.recent.map((move) => ({ ...move, present: existsSync(join(this.options.folder, move.to)) }));
    const followUps = this.followUps.filter((f) => existsSync(join(this.options.folder, f.file)));
    return { folder: this.options.folder, mood, message, pending: this.pending, recent, lastRun: this.lastRun, followUps };
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
    this.recent = await recentMoves(this.options.folder, RECENT_LIMIT);
    this.followUps = await pendingFollowUps(this.options.folder);
    await this.options.waitForModel();
    this.dizzy = null;
    this.startWatcher();
    // Read the folder for search in the background; new files are added after each run.
    void this.firstPass.then(() => this.refreshIndex());
  }

  async stop(): Promise<void> {
    for (const asking of this.remote.values()) asking.abort();
    this.remote.clear();
    this.control?.stop();
    await new Promise<void>((resolveClose) => (this.server ? this.server.close(() => resolveClose()) : resolveClose()));
    await rm(this.options.infoPath ?? daemonInfoPath(), { force: true });
  }

  /**
   * Resolves once the first pass has run. Files that land before then count as
   * already there (left for `dz tidy`), so callers that drop files in should wait.
   */
  ready(): Promise<void> {
    return this.firstPass;
  }

  private startWatcher(): void {
    this.firstPass = new Promise((resolveFirst) => (this.firstPassDone = resolveFirst));
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
    this.firstPassDone();
    this.dizzy = null;
    this.settling = result.settling;
    if (result.run?.moved) {
      this.eatingUntil = Date.now() + 4_000;
      this.lastRun = { run: result.run.run, moved: result.run.moved };
      this.lastMessage = `Filed ${result.run.moved} new ${result.run.moved === 1 ? "download" : "downloads"}.`;
    }
    if (result.run?.moves.length) {
      void this.options.voice?.say(spokenSummary(result.run.moves, loadRules(this.options.folder)));
      void this.refreshIndex();
    }
    // Newest first, each offered once.
    for (const f of result.followUps ?? []) {
      if (!this.followUps.some((known) => known.file === f.file)) this.followUps.unshift(f);
    }
    // Every pass, not only after its own moves: the journal is the record, whoever wrote it.
    this.recent = await recentMoves(this.options.folder, RECENT_LIMIT);
    for (const item of result.needsDecision?.reviews ?? []) {
      const id = fingerprint(item);
      this.pending.push({ kind: "review", id, title: `${item.name} → ${item.target}`, detail: item.checks.join("; ") });
      // The phone sees the kind of file only, never its name.
      this.askRemotely(id, `Dropzone Zero: move 1 ${item.category ?? "file"}`);
    }
    const batch = result.needsDecision?.batch;
    if (batch) {
      this.pending.push({ kind: "batch", id: batch.key, title: `Move ${batch.count} new files at once`, detail: "More than the bulk limit arrived together." });
      this.askRemotely(batch.key, `Dropzone Zero: move ${batch.count} new files`);
    }
    const reviews = result.needsDecision?.reviews ?? [];
    if (reviews.length || batch) {
      void this.options.voice?.say(spokenQuestion(batch ? Array(batch.count).fill(null) : reviews.map((item) => item.category)));
    }
    this.options.onEvent?.(result);
  }

  /** Brings the search index up to date, one pass at a time; errors only make search staler. */
  private refreshIndex(): Promise<void> {
    const search = this.options.search;
    if (!search) return Promise.resolve();
    if (this.indexing) {
      this.indexAgain = true;
      return this.indexing;
    }
    this.indexing = (async () => {
      do {
        this.indexAgain = false;
        await updateIndex(this.options.folder, search).catch((error: unknown) => {
          console.error(`Search index: ${error instanceof Error ? error.message : String(error)}`);
        });
      } while (this.indexAgain);
    })().finally(() => (this.indexing = null));
    return this.indexing;
  }

  /** Answers a question, from Zee or from the phone. False if it was already answered. */
  private decide(id: string, approve: boolean): boolean {
    const decision = this.pending.find((p) => p.id === id);
    if (!decision) return false;
    this.pending = this.pending.filter((p) => p !== decision);
    this.remote.get(id)?.abort();
    this.remote.delete(id);
    if (approve && decision.kind === "review") this.control?.approveItem(id);
    if (approve && decision.kind === "batch") this.control?.approveBatch(id);
    return true;
  }

  /** Sends a question to the approver's phone too; an unanswered push leaves it to Zee. */
  private askRemotely(id: string, message: string): void {
    const approver = this.options.remoteApprover;
    if (!approver) return;
    const asking = new AbortController();
    this.remote.set(id, asking);
    approver
      .ask(message, asking.signal)
      .then((answer) => {
        if (asking.signal.aborted) return;
        this.remote.delete(id);
        if (answer === "approved" || answer === "denied") this.decide(id, answer === "approved");
      })
      .catch((error: unknown) => {
        this.remote.delete(id);
        // Zee still asks; the phone was only a second way to answer.
        console.error(`Remote approval failed: ${error instanceof Error ? error.message : String(error)}`);
      });
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
        if (!this.decide(id, approve)) return send(res, 404, { error: "no such decision" });
        return send(res, 200, this.state());
      }
      if (route === "POST /reveal") {
        const { to } = RevealBody.parse(body);
        // Only files Dropzone Zero itself put somewhere, never an arbitrary path from the caller.
        if (!this.recent.some((m) => m.to === to && m.present)) return send(res, 404, { error: "not a recent move" });
        await new Promise<void>((ok, fail) => execFile("open", ["-R", join(this.options.folder, to)], (e) => (e ? fail(e) : ok())));
        return send(res, 200, { ok: true });
      }
      if (route === "POST /calendar") {
        const { file } = CalendarBody.parse(body);
        // Only a follow-up this daemon wrote, never an arbitrary path from the caller.
        if (!this.followUps.some((f) => f.file === file)) return send(res, 404, { error: "not a follow-up" });
        // The Calendar app opens the .ics and asks before adding the event.
        await new Promise<void>((ok, fail) => execFile("open", [join(this.options.folder, file)], (e) => (e ? fail(e) : ok())));
        const followUp = this.followUps.find((f) => f.file === file)!;
        followUp.added = true;
        await recordCalendarAdd(this.options.folder, followUp);
        return send(res, 200, this.state());
      }
      if (route === "POST /calendar/remove") {
        const { file } = CalendarBody.parse(body);
        const followUp = this.followUps.find((f) => f.file === file && f.added);
        if (!followUp) return send(res, 404, { error: "not added to the calendar from Zee" });
        const removed = await takeBackFromCalendar(this.options.folder, [followUp.uid], this.options.removeEvents ?? removeFromCalendar);
        followUp.added = false;
        this.lastMessage = removed ? "Removed it from your calendar." : "It was not in your calendar.";
        return send(res, 200, { ...this.state(), message: this.lastMessage });
      }
      if (route === "POST /dismiss") {
        const { file } = CalendarBody.parse(body);
        // Off the list only; the .ics file stays in Calendar/Follow-ups.
        if (!this.followUps.some((f) => f.file === file)) return send(res, 404, { error: "not a follow-up" });
        this.followUps = this.followUps.filter((f) => f.file !== file);
        await recordDismissed(this.options.folder, file);
        return send(res, 200, this.state());
      }
      if (route === "POST /search") {
        const { query } = SearchBody.parse(body);
        if (!this.options.search) return send(res, 404, { error: "search is off" });
        // Searches what is indexed now, without waiting for a pass under way (a first pass
        // over a big folder takes minutes); the answer says so if one is.
        const hits: SearchHit[] = await searchIndex(this.options.folder, query, this.options.search.embed, 5);
        this.found = new Map(hits.map((hit) => [hitId(hit.path), hit.path]));
        return send(res, 200, {
          hits: hits.map((hit) => ({ id: hitId(hit.path), path: hit.path, why: hit.why, score: hit.score })),
          indexing: this.indexing !== null,
        });
      }
      if (route === "POST /reveal-found") {
        const { id } = FoundBody.parse(body);
        // Only a file from the last search, never an arbitrary path from the caller.
        const path = this.found.get(id);
        if (!path) return send(res, 404, { error: "not a search result" });
        await new Promise<void>((ok, fail) => execFile("open", ["-R", join(this.options.folder, path)], (e) => (e ? fail(e) : ok())));
        return send(res, 200, { ok: true });
      }
      if (route === "POST /undo") {
        const run = await lastUndoableRun(this.options.folder);
        if (!run) return send(res, 200, { ...this.state(), message: "Nothing to undo." });
        const result = await undoRun(this.options.folder, run);
        // Events this run's follow-ups put in the Calendar app come back out too.
        const events = await addedToCalendar(this.options.folder, run);
        const removed = await takeBackFromCalendar(this.options.folder, events, this.options.removeEvents ?? removeFromCalendar).catch(() => 0);
        this.recent = await recentMoves(this.options.folder, RECENT_LIMIT);
        this.lastMessage = `Put back ${result.restored} ${result.restored === 1 ? "file" : "files"}.${removed ? ` Removed ${removed} ${removed === 1 ? "event" : "events"} from your calendar.` : ""}`;
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
