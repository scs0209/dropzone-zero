#!/usr/bin/env node
import { homedir } from "node:os";
import { extname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { classifyFile } from "./classify.js";
import {
  executePlan,
  lastUndoableRun,
  loadPlan,
  movableItems,
  savePlan,
  undoRun,
  type RunResult,
  type UndoResult,
} from "./execute.js";
import { contentKindOf, extractContent } from "./extract.js";
import { newRunId } from "./journal.js";
import { OllamaClient, OllamaUnavailableError } from "./ollama.js";
import { buildPlan, summarize, type PlanItem } from "./plan.js";
import { scanFolder, type ScannedFile } from "./scan.js";
import { captureError, flushTelemetry, initTelemetry, recordCounts, recordDuration, withSpan } from "./telemetry.js";

const USAGE = `Dropzone Zero - keeps your Downloads folder tidy, with every move reversible.

Usage:
  dz scan [folder] [--json]      List files with size, age, hash, and flags
  dz preview [folder] [--json | --summary]
                                 Plan new names and folders with a local model (moves nothing)
  dz run [folder] [--yes] [--temporal]
                                 Carry out the last preview, verifying every move
  dz undo [folder] [--yes] [--temporal]
                                 Put back everything the last run moved
  dz worker                      Run a Temporal worker that finishes interrupted runs

Options:
  --summary                      Print only counts and timings, no file names
  -y, --yes                      Do not ask for confirmation
  --temporal                     Run as a durable Temporal workflow (needs \`temporal server start-dev\`)
  -h, --help                     Show this help

Environment:
  DZ_INBOX      Folder to organize (default ~/Downloads)
  OLLAMA_HOST   Ollama server (default http://127.0.0.1:11434)
  DZ_MODEL      Ollama model (default gemma4:e4b)
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

const ACTION_ORDER = { move: 0, quarantine: 1, skip: 2 } as const;

function printPlan(plan: PlanItem[], folder: string): void {
  const counts = summarize(plan);
  console.log(`Plan for ${plan.length} files in ${folder} (preview only, nothing was moved)\n`);
  console.log(["ACTION".padEnd(10), "CONF", "CATEGORY".padEnd(12), "FILE".padEnd(38), "NEW PATH"].join("  "));
  const sorted = [...plan].sort((a, b) => ACTION_ORDER[a.action] - ACTION_ORDER[b.action] || a.name.localeCompare(b.name));
  for (const item of sorted) {
    const destination = item.target ? `-> ${item.target}` : "";
    const note = item.action === "move" ? "" : `  (${item.reason})`;
    console.log(
      [
        item.action.padEnd(10),
        item.confidence.toFixed(2),
        (item.category ?? "-").padEnd(12),
        item.name.padEnd(38),
        destination + note,
      ].join("  "),
    );
  }
  console.log(`\n${counts.move} to move, ${counts.quarantine} to quarantine, ${counts.skip} to skip.`);
  console.log("Run `dz run` to carry out this plan; `dz undo` reverses it.");
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
function printSummary(plan: PlanItem[], seconds: number): void {
  const counts = summarize(plan);
  const modelCalls = plan.filter((item) => item.source !== "rule").length;
  const band = (c: number) => (c < 0.5 ? "under 0.5" : c < 0.8 ? "0.5-0.8" : "0.8+");
  console.log(`Plan summary for ${plan.length} files (names hidden, nothing was moved)\n`);
  console.log(`Actions:     move ${counts.move}, quarantine ${counts.quarantine}, skip ${counts.skip}`);
  console.log(`Categories:  ${countBy(plan.filter((i) => i.category), (i) => i.category!)}`);
  console.log(`Decided by:  ${countBy(plan, (i) => i.source)}`);
  console.log(`File types:  ${countBy(plan, (i) => contentKindOf(extname(i.name).toLowerCase()))}`);
  console.log(`Confidence:  ${countBy(plan.filter((i) => i.source !== "rule"), (i) => band(i.confidence))}`);
  const skipped = plan.filter((i) => i.action === "skip");
  console.log(`Skipped:     ${skipped.length ? countBy(skipped, (i) => i.reason.split(":")[0]!.replace(/\.$/, "")) : "none"}`);
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

  await savePlan(folder, client.model, plan);

  if (format === "json") process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
  else if (format === "summary") printSummary(plan, (performance.now() - started) / 1000);
  else printPlan(plan, folder);
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
  const counts = summarize(plan.items);
  const work = counts.move + counts.quarantine;
  if (work === 0) {
    console.log("The plan has nothing to move.");
    return;
  }
  const question = `Move ${counts.move} and quarantine ${counts.quarantine} files, as planned at ${plan.createdAt}?`;
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

async function undo(folder: string, yes: boolean, temporal: boolean): Promise<void> {
  const runId = await lastUndoableRun(folder);
  if (!runId) {
    console.log("Nothing to undo.");
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
  if (command === "undo") return undo(folder, values.yes ?? false, values.temporal ?? false);
  if (command === "worker") return startWorker();
  if (command === "preview") return preview(folder, values.summary ? "summary" : json ? "json" : "table");

  process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
  process.exitCode = 1;
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
