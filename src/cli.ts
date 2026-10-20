#!/usr/bin/env node
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { classifyFile } from "./classify.js";
import { extractContent } from "./extract.js";
import { OllamaClient, OllamaUnavailableError } from "./ollama.js";
import { buildPlan, summarize, type PlanItem } from "./plan.js";
import { scanFolder, type ScannedFile } from "./scan.js";
import { captureError, flushTelemetry, initTelemetry, recordCounts, recordDuration, withSpan } from "./telemetry.js";

const USAGE = `Dropzone Zero - keeps your Downloads folder tidy, with every move reversible.

Usage:
  dz scan [folder] [--json]      List files with size, age, hash, and flags
  dz preview [folder] [--json]   Plan new names and folders with a local model (read-only)

Options:
  -h, --help                     Show this help

Environment:
  DZ_INBOX      Folder to organize (default ~/Downloads)
  OLLAMA_HOST   Ollama server (default http://127.0.0.1:11434)
  DZ_MODEL      Ollama model (default gemma4:e4b)
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
  console.log(["ACTION".padEnd(10), "CONF", "CATEGORY".padEnd(10), "FILE".padEnd(38), "NEW PATH"].join("  "));
  const sorted = [...plan].sort((a, b) => ACTION_ORDER[a.action] - ACTION_ORDER[b.action] || a.name.localeCompare(b.name));
  for (const item of sorted) {
    const destination = item.target ? `-> ${item.target}` : "";
    const note = item.action === "move" ? "" : `  (${item.reason})`;
    console.log(
      [
        item.action.padEnd(10),
        item.confidence.toFixed(2),
        (item.category ?? "-").padEnd(10),
        item.name.padEnd(38),
        destination + note,
      ].join("  "),
    );
  }
  console.log(`\n${counts.move} to move, ${counts.quarantine} to quarantine, ${counts.skip} to skip.`);
}

async function preview(folder: string, json: boolean): Promise<void> {
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

  if (json) process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
  else printPlan(plan, folder);
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
  if (command === "preview") return preview(folder, json);

  process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
  process.exitCode = 1;
}

await initTelemetry();
try {
  await main();
} catch (error: unknown) {
  if (!(error instanceof OllamaUnavailableError)) captureError(error);
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await flushTelemetry();
}
