#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { classifyFile } from "./classify.js";
import {
  approveItems,
  executePlan,
  lastUndoableRun,
  loadPlan,
  movableItems,
  savePlan,
  undoFiles,
  undoRun,
  type RunResult,
  type UndoResult,
} from "./execute.js";
import { contentKindOf, extractContent } from "./extract.js";
import { batchNeedsApproval, DEFAULT_BULK_LIMIT, isRunnable } from "./guard.js";
import { newRunId } from "./journal.js";
import { OllamaClient, OllamaUnavailableError } from "./ollama.js";
import { buildPlan, summarize, type PlanItem } from "./plan.js";
import { extractReceipt, findReceiptFiles, toCsv, type ReceiptRow } from "./receipts.js";
import { applyReviewGate, type GateResult } from "./review.js";
import { countStates, latestRun, plannedStates, runStates, type ItemStatus } from "./status.js";
import { startWatching, type CycleResult } from "./watch.js";
import { scanFolder, type ScannedFile } from "./scan.js";
import { captureError, flushTelemetry, initTelemetry, recordCounts, recordDuration, withSpan } from "./telemetry.js";

const USAGE = `Dropzone Zero - keeps your Downloads folder tidy, with every move reversible.

Usage:
  dz tidy [folder] [--yes]       Analyze, plan, ask you, then move: the whole routine in one go
  dz scan [folder] [--json]      List files with size, age, hash, and flags
  dz preview [folder] [--json | --summary]
                                 Plan new names and folders with a local model (moves nothing)
  dz run [folder] [--yes] [--temporal]
                                 Carry out the last preview, verifying every move
  dz undo [folder] [--yes] [--temporal]
                                 Put back everything the last run moved
  dz undo [folder] --file <name> [--file <name> ...]
                                 Put back single files; the review gate learns from it
  dz approve [folder] --file <name> | --all
                                 Release items the guard holds for review
  dz watch [folder] [--auto] [--include-existing]
                                 Keep planning as files arrive; --auto moves new files the guard allows
  dz status [folder] [--json]    Show where every file stands: planned, waiting, verified, failed
  dz worker                      Run a Temporal worker that finishes interrupted runs
  dz receipts [folder] [--out file.csv]
                                 Export vendor, date, and total of receipts and invoices to CSV

Options:
  --summary                      Print only counts and timings, no file names
  -y, --yes                      Do not ask for confirmation
  --temporal                     Run as a durable Temporal workflow (needs \`temporal server start-dev\`)
  -h, --help                     Show this help

Environment:
  DZ_INBOX      Folder to organize (default ~/Downloads)
  OLLAMA_HOST   Ollama server (default http://127.0.0.1:11434)
  DZ_MODEL      Ollama model (default gemma4:e4b)
  DZ_REVIEW_GATE  Set to "off" to skip the local TabPFN review gate
  DZ_BULK_LIMIT   Allowed moves above this count as a bulk change (default 20)
  TEMPORAL_ADDRESS  Temporal server for --temporal (default 127.0.0.1:7233)
  SENTRY_DSN    Optional; sends only aggregate counts and timings
`;

function expandHome(path: string): string {
  return path.startsWith("~") ? homedir() + path.slice(1) : path;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function flagsOf(file: ScannedFile): string {
  const flags: string[] = [];
  if (file.partial) flags.push("partial");
  if (file.size === 0) flags.push("empty");
  if (file.duplicateOf) flags.push(`duplicate of ${file.duplicateOf}`);
  return flags.join(", ");
}

const VERDICT_ORDER = { allow: 0, review: 1, block: 2 } as const;
const ACTION_ORDER = { move: 0, quarantine: 1, skip: 2 } as const;

/** What a person needs to know about an item that is not simply allowed. */
function itemNote(item: PlanItem): string {
  if (item.verdict === "allow") return item.action === "quarantine" ? `  (${item.reason})` : "";
  const approved = item.verdict === "review" && isRunnable(item) ? "approved: " : "";
  return `  (${approved}${item.checks.join("; ")})`;
}

function printPlan(plan: PlanItem[], folder: string, gate: GateResult, hints = true): void {
  const counts = summarize(plan);
  console.log(`Plan for ${plan.length} files in ${folder} (preview only, nothing was moved)\n`);
  console.log(["VERDICT", "ACTION".padEnd(10), "CONF", "CATEGORY".padEnd(12), "FILE".padEnd(38), "NEW PATH"].join("  "));
  const sorted = [...plan].sort(
    (a, b) =>
      VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] ||
      ACTION_ORDER[a.action] - ACTION_ORDER[b.action] ||
      a.name.localeCompare(b.name),
  );
  for (const item of sorted) {
    const destination = item.target && item.verdict !== "block" ? `-> ${item.target}` : "";
    const note = itemNote(item);
    console.log(
      [
        item.verdict.toUpperCase().padEnd(7),
        item.action.padEnd(10),
        item.confidence.toFixed(2),
        (item.category ?? "-").padEnd(12),
        item.name.padEnd(38),
        destination + note,
      ].join("  "),
    );
  }
  const verdicts = countVerdicts(plan);
  console.log(`\n${verdicts.allow} allowed, ${verdicts.review} waiting for review, ${verdicts.block} blocked (${counts.move} moves, ${counts.quarantine} to quarantine).`);
  console.log(`Review gate: ${gate.status === "on" ? `${gate.flagged} sent to review, ` : ""}${gate.note}.`);
  if (hints) {
    console.log("`dz run` carries out the allowed items; `dz approve --file <name>` releases a review item; `dz undo` reverses a run.");
  }
}

function countVerdicts(plan: PlanItem[]): Record<"allow" | "review" | "block", number> {
  const counts = { allow: 0, review: 0, block: 0 };
  for (const item of plan) counts[item.verdict]++;
  return counts;
}

function countBy<T>(items: T[], key: (item: T) => string): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name} ${count}`)
    .join(", ");
}

/** Aggregates only, so the output is safe to paste into an issue or a chat about a real folder. */
function printSummary(plan: PlanItem[], seconds: number, gate: GateResult): void {
  const counts = summarize(plan);
  const modelCalls = plan.filter((item) => item.source !== "rule").length;
  const band = (c: number) => (c < 0.5 ? "under 0.5" : c < 0.8 ? "0.5-0.8" : "0.8+");
  console.log(`Plan summary for ${plan.length} files (names hidden, nothing was moved)\n`);
  const verdicts = countVerdicts(plan);
  console.log(`Verdicts:    allow ${verdicts.allow}, review ${verdicts.review}, block ${verdicts.block}`);
  console.log(`Actions:     move ${counts.move}, quarantine ${counts.quarantine}, skip ${counts.skip}`);
  console.log(`Categories:  ${countBy(plan.filter((i) => i.category), (i) => i.category!)}`);
  console.log(`Decided by:  ${countBy(plan, (i) => i.source)}`);
  console.log(`File types:  ${countBy(plan, (i) => contentKindOf(extname(i.name).toLowerCase()))}`);
  console.log(`Confidence:  ${countBy(plan.filter((i) => i.source !== "rule"), (i) => band(i.confidence))}`);
  const held = plan.filter((i) => i.verdict !== "allow").flatMap((i) => i.checks.map((check) => ({ check })));
  // Strip numbers so "Low confidence (0.42)" and "(0.31)" count as one reason.
  console.log(`Why held:    ${held.length ? countBy(held, (h) => h.check.replace(/\s*\(.*\)$/, "").replace(/\.$/, "")) : "nothing held"}`);
  console.log(`Review gate: ${gate.status}, ${gate.flagged} held; ${gate.note}`);
  console.log(`Time:        ${seconds.toFixed(1)} s${modelCalls ? ` (${(seconds / modelCalls).toFixed(1)} s per model call)` : ""}`);
}

async function preview(folder: string, format: "table" | "json" | "summary"): Promise<void> {
  const files = await scanFolder(folder);
  const client = new OllamaClient();
  await client.ensureReady();

  const started = performance.now();
  const plan = await withSpan("dz.preview", () =>
    buildPlan(files, {
      inbox: folder,
      classify: async (file) => {
        const t0 = performance.now();
        const result = await classifyFile(client, file, await extractContent(file));
        recordDuration("dz.classify.duration", performance.now() - t0);
        return result;
      },
      onProgress: (done, total) => {
        if (process.stderr.isTTY) process.stderr.write(`\rPlanning ${done}/${total}...`);
      },
    }),
  );
  if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");

  recordDuration("dz.preview.duration", performance.now() - started);
  recordCounts("dz.preview", {
    files: plan.length,
    ...summarize(plan),
    fallback: plan.filter((item) => item.source === "fallback").length,
  });

  const gate = await withSpan("dz.review_gate", () => applyReviewGate(folder, plan));
  recordCounts("dz.review_gate", { flagged: gate.flagged });
  await savePlan(folder, client.model, plan);

  if (format === "json") process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
  else if (format === "summary") printSummary(plan, (performance.now() - started) / 1000, gate);
  else printPlan(plan, folder, gate);
}

async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    process.stderr.write("Not a terminal; pass --yes to confirm.\n");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/**
 * The whole routine in one command, as a Mastra workflow: analyze, plan, then
 * wait (the workflow suspends) while the person reviews the plan, releases
 * review items one by one, and confirms; then move.
 */
async function tidy(folder: string, yes: boolean): Promise<void> {
  const client = new OllamaClient();
  await client.ensureReady();
  const { startTidy } = await import("./tidy.js");
  const session = await startTidy({
    inbox: folder,
    model: client.model,
    classify: async (file) => classifyFile(client, file, await extractContent(file)),
    onProgress: (done, total) => {
      if (process.stderr.isTTY) process.stderr.write(`\rPlanning ${done}/${total}...`);
    },
  });
  if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
  printPlan(session.items, folder, { status: "off", note: session.gate, flagged: 0 }, false);

  const interactive = process.stdin.isTTY && !yes;
  const approve: string[] = [];
  let confirmed = yes;
  if (interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = async (question: string) => /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
    const reviews = session.items.filter((item) => item.verdict === "review");
    if (reviews.length) console.log(`\n${reviews.length} ${reviews.length === 1 ? "item needs" : "items need"} your decision:`);
    for (const item of reviews) {
      if (await ask(`  Move ${item.name} -> ${item.target}? (${item.checks.join("; ")})`)) approve.push(item.name);
    }
    const runnable = session.items.filter((item) => item.verdict === "allow").length + approve.length;
    confirmed = runnable > 0 && (await ask(`\nMove ${runnable} files now?`));
    rl.close();
  } else if (!yes) {
    process.stderr.write("Not a terminal; pass --yes to run the allowed moves (review items stay).\n");
  }

  const { cancelled, result } = await session.decide({ approve, confirmed });
  if (cancelled || !result) {
    console.log("Nothing was moved. The plan is saved; `dz approve` and `dz run` can pick it up later.");
    return;
  }
  recordCounts("dz.tidy", { moved: result.moved, approved: approve.length, failed: result.failed.length });
  console.log(`Run ${result.run}: moved ${result.moved} files, every one verified by SHA-256. \`dz undo\` puts them back.`);
  printFailures(result.failed);
}

function printFailures(failed: { name: string; error: string }[]): void {
  for (const { name, error } of failed) console.log(`  failed  ${name}: ${error}`);
}

/**
 * Executes a workflow on a worker inside this process. Temporal keeps the workflow's
 * progress, so if this process dies halfway, `dz worker` picks it up where it stopped.
 */
async function runWorkflow<R>(workflow: "runPlanWorkflow" | "undoRunWorkflow", workflowId: string, args: unknown[]): Promise<R> {
  const { connectClient, createWorker, TASK_QUEUE, workflowUrl } = await import("./temporal/worker.js");
  const client = await connectClient();
  const worker = await createWorker();
  console.log(`Temporal workflow ${workflowId}\n  ${workflowUrl(workflowId)}`);
  return (await worker.runUntil(client.workflow.execute(workflow, { taskQueue: TASK_QUEUE, workflowId, args }))) as R;
}

async function startWorker(): Promise<void> {
  const { createWorker, temporalAddress } = await import("./temporal/worker.js");
  const worker = await createWorker();
  console.log(`Worker connected to Temporal at ${temporalAddress()}. Press Ctrl+C to stop.`);
  await worker.run();
}

async function run(folder: string, yes: boolean, temporal: boolean): Promise<void> {
  const plan = await loadPlan(folder);
  if (!plan || plan.inbox !== folder) {
    throw new Error(`No saved plan for ${folder}. Run \`dz preview\` first.`);
  }
  const runnable = movableItems(plan.items);
  const waiting = plan.items.filter((item) => item.verdict === "review" && !isRunnable(item)).length;
  const blocked = plan.items.filter((item) => item.verdict === "block").length;
  const work = runnable.length;
  if (work === 0) {
    console.log(`Nothing is allowed to run yet (${waiting} waiting for review, ${blocked} blocked).`);
    return;
  }
  const moves = runnable.filter((item) => item.action === "move").length;
  const bulk = batchNeedsApproval(plan.items) ? ` This is a bulk change (more than ${process.env.DZ_BULK_LIMIT ?? DEFAULT_BULK_LIMIT} files).` : "";
  const question = `Move ${moves} and quarantine ${work - moves} files, as planned at ${plan.createdAt}? ${waiting} stay for review, ${blocked} are blocked.${bulk}`;
  if (!(await confirm(question, yes))) {
    console.log("Nothing was moved.");
    return;
  }

  const started = performance.now();
  const runId = newRunId();
  const result = await withSpan("dz.run", () =>
    temporal
      ? runWorkflow<RunResult>("runPlanWorkflow", `dz-run-${runId}`, [folder, runId, movableItems(plan.items)])
      : executePlan(
          folder,
          plan.items,
          (done, total) => {
            if (process.stderr.isTTY) process.stderr.write(`\rMoving ${done}/${total}...`);
          },
          runId,
        ),
  );
  if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
  recordDuration("dz.run.duration", performance.now() - started);
  recordCounts("dz.run", { moved: result.moved, failed: result.failed.length });

  console.log(`Run ${result.run}: moved ${result.moved} of ${work} files, every one verified by SHA-256.`);
  printFailures(result.failed);
  console.log("Changed your mind? `dz undo` puts everything back.");
}

function formatCounts(counts: Partial<Record<string, number>>): string {
  return Object.entries(counts).map(([state, n]) => `${state} ${n}`).join(", ") || "nothing";
}

async function status(folder: string, json: boolean): Promise<void> {
  const planned = await plannedStates(folder);
  const run = await latestRun(folder);
  const ran = run ? await runStates(folder, run) : [];
  if (json) {
    process.stdout.write(JSON.stringify({ plan: planned, run: run ? { id: run, items: ran } : null }, null, 2) + "\n");
    return;
  }
  const show = (items: ItemStatus[], states: string[]) => {
    for (const item of items.filter((i) => states.includes(i.state))) {
      console.log(`  ${item.state.padEnd(12)}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
    }
  };
  console.log(`Saved plan:  ${planned.length ? formatCounts(countStates(planned)) : "none (run \`dz preview\`)"}`);
  show(planned, ["needs-review", "approved"]);
  console.log(`Last run:    ${run ? `${run}: ${formatCounts(countStates(ran))}` : "none"}`);
  show(ran, ["executing", "failed"]);
  if (ran.some((i) => i.state === "executing")) {
    console.log("Some moves stopped halfway. `dz worker` finishes a --temporal run; `dz undo` reverses it.");
  }
}

function printCycle(result: CycleResult): void {
  const time = new Date().toTimeString().slice(0, 8);
  const existing = result.existing ? `; ${result.existing} files that were already here are left alone (\`dz tidy\` sorts them)` : "";
  if (result.planned === 0) {
    console.log(`${time}  ${result.settling ? `waiting for ${result.settling} ${result.settling === 1 ? "file" : "files"} to finish writing` : "nothing new"}${existing}`);
    return;
  }
  const settling = result.settling ? `, ${result.settling} still being written` : "";
  console.log(
    `${time}  ${result.planned} planned (${result.newlyClassified} new to the model)${settling}: ` +
      `${result.allowed} allowed, ${result.review} review, ${result.blocked} blocked`,
  );
  if (result.run) {
    const files = result.run.moved === 1 ? "file" : "files";
    console.log(`${time}  moved ${result.run.moved} ${files} (run ${result.run.run}); \`dz undo\` reverses it`);
    printFailures(result.run.failed);
  } else if (result.held) {
    console.log(`${time}  not running: ${result.held}`);
  }
}

async function watchFolder(folder: string, auto: boolean, includeExisting: boolean): Promise<void> {
  const client = new OllamaClient();
  await client.ensureReady();
  console.log(
    `Watching ${folder}. ${
      auto
        ? `New files that the guard allows move on their own${includeExisting ? ", and so do files already here" : "; files already here stay"}. Review and blocked items wait.`
        : "Planning only; pass --auto to move new files."
    } Press Ctrl+C to stop.`,
  );
  const stop = startWatching({
    inbox: folder,
    model: client.model,
    auto,
    includeExisting,
    classify: async (file) => classifyFile(client, file, await extractContent(file)),
    onCycle: (result) => {
      recordCounts("dz.watch", { planned: result.planned, moved: result.run?.moved ?? 0 });
      printCycle(result);
    },
    onError: (error) => {
      captureError(error);
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    },
  });
  await new Promise<void>((resolveStop) => {
    process.once("SIGINT", () => {
      stop();
      console.log("\nStopped watching.");
      resolveStop();
    });
  });
}

async function approve(folder: string, files: string[], all: boolean): Promise<void> {
  if (!all && files.length === 0) throw new Error("Name the files to approve with --file <name>, or pass --all.");
  const { approved, unmatched } = await approveItems(folder, all ? "all" : files);
  console.log(`Approved ${approved.length} ${approved.length === 1 ? "item" : "items"} for the next \`dz run\`.`);
  for (const name of approved) console.log(`  approved  ${name}`);
  for (const name of unmatched) console.log(`  not waiting for review: ${name}`);
}

async function undo(folder: string, yes: boolean, temporal: boolean, files: string[]): Promise<void> {
  const runId = await lastUndoableRun(folder);
  if (!runId) {
    console.log("Nothing to undo.");
    return;
  }
  if (files.length > 0) {
    const result = await undoFiles(folder, runId, files);
    recordCounts("dz.undo_files", { restored: result.restored, failed: result.failed.length });
    console.log(`Moved back ${result.restored} of ${files.length} files from run ${runId}. The review gate will learn from this.`);
    for (const name of result.unmatched) console.log(`  not in this run: ${name}`);
    printFailures(result.failed);
    return;
  }
  if (!(await confirm(`Undo run ${runId}?`, yes))) {
    console.log("Nothing was changed.");
    return;
  }
  const result = await withSpan("dz.undo", () =>
    temporal
      ? runWorkflow<UndoResult>("undoRunWorkflow", `dz-undo-${runId}`, [folder, runId])
      : undoRun(folder, runId),
  );
  recordCounts("dz.undo", { restored: result.restored, failed: result.failed.length });
  console.log(`Undid run ${runId}: restored ${result.restored} files.`);
  printFailures(result.failed);
}

/** Finance/receipts-2026-10-20.csv, or -2, -3, ... so an export never overwrites an earlier one. */
function defaultCsvPath(folder: string): string {
  const base = join(folder, "Finance", `receipts-${new Date().toISOString().slice(0, 10)}`);
  let path = `${base}.csv`;
  for (let n = 2; existsSync(path); n++) path = `${base}-${n}.csv`;
  return path;
}

async function receipts(folder: string, out: string | undefined): Promise<void> {
  const found = await findReceiptFiles(folder);
  if (found.length === 0) {
    console.log("No receipts or invoices found. Run `dz preview` (and `dz run`) first.");
    return;
  }
  const client = new OllamaClient();
  await client.ensureReady();

  const rows: ReceiptRow[] = [];
  for (const [index, receipt] of found.entries()) {
    if (process.stderr.isTTY) process.stderr.write(`\rReading ${index + 1}/${found.length}...`);
    rows.push(await extractReceipt(client, folder, receipt, await extractContent(receipt.file)));
  }
  if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
  rows.sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.file.localeCompare(b.file));

  const path = out ? resolve(expandHome(out)) : defaultCsvPath(folder);
  if (out && existsSync(path)) throw new Error(`${path} already exists; choose another --out.`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, toCsv(rows));

  for (const row of rows) {
    const total = row.total === null ? "" : `${row.total.toFixed(2)} ${row.currency ?? ""}`.trim();
    console.log([(row.date ?? "?").padEnd(10), (row.vendor ?? "?").padEnd(24), total.padStart(14), `  ${row.status}`].join("  "));
  }
  const checks = rows.filter((row) => row.status !== "ok").length;
  recordCounts("dz.receipts", { rows: rows.length, checks });
  console.log(`\nWrote ${rows.length} rows to ${relative(process.cwd(), path) || path}${checks ? `; ${checks} need a look` : ""}.`);
}

async function scan(folder: string, json: boolean): Promise<void> {
  const files = await scanFolder(folder);

  if (json) {
    process.stdout.write(JSON.stringify(files, null, 2) + "\n");
    return;
  }

  console.log(`${files.length} files in ${folder}\n`);
  for (const file of files) {
    const flags = flagsOf(file);
    console.log(
      [
        file.name.padEnd(40),
        formatSize(file.size).padStart(9),
        `${file.ageDays}d`.padStart(5),
        file.sha256.slice(0, 8),
        flags ? `  ${flags}` : "",
      ].join("  "),
    );
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      summary: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      temporal: { type: "boolean" },
      out: { type: "string" },
      file: { type: "string", multiple: true },
      all: { type: "boolean" },
      auto: { type: "boolean" },
      "include-existing": { type: "boolean" },
    },
  });
  const [command, folderArg] = positionals;

  if (values.help || !command) {
    process.stdout.write(USAGE);
    return;
  }

  const folder = resolve(expandHome(folderArg ?? process.env.DZ_INBOX ?? "~/Downloads"));
  const json = values.json ?? false;

  if (command === "scan") return scan(folder, json);
  if (command === "run") return run(folder, values.yes ?? false, values.temporal ?? false);
  if (command === "undo") return undo(folder, values.yes ?? false, values.temporal ?? false, values.file ?? []);
  if (command === "worker") return startWorker();
  if (command === "status") return status(folder, json);
  if (command === "tidy") return tidy(folder, values.yes ?? false);
  if (command === "watch") return watchFolder(folder, values.auto ?? false, values["include-existing"] ?? false);
  if (command === "approve") return approve(folder, values.file ?? [], values.all ?? false);
  if (command === "receipts") return receipts(folder, values.out);
  if (command === "preview") return preview(folder, values.summary ? "summary" : json ? "json" : "table");

  process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
  process.exitCode = 1;
}

// Optional settings (SENTRY_DSN, DZ_MODEL, ...) from .env; silent when there is none.
try {
  process.loadEnvFile(".env");
} catch {
  // No .env: defaults apply.
}
await initTelemetry();
try {
  await main();
} catch (error: unknown) {
  // Setup problems (a server not running) are the user's to fix, not bugs to report.
  const setupProblem = error instanceof OllamaUnavailableError || (error as Error)?.name === "TemporalUnavailableError";
  if (!setupProblem) captureError(error);
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await flushTelemetry();
}
