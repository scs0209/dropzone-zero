#!/usr/bin/env node
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { scanFolder, type ScannedFile } from "./scan.js";

const USAGE = `Dropzone Zero - keeps your Downloads folder tidy, with every move reversible.

Usage:
  dz scan [folder] [--json]   List files with size, age, hash, and flags

Options:
  -h, --help                  Show this help
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

  if (command !== "scan") {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const folder = resolve(expandHome(folderArg ?? process.env.DZ_INBOX ?? "~/Downloads"));
  const files = await scanFolder(folder);

  if (values.json) {
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

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
