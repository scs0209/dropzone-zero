import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";

// Browsers write these while a download is still in progress.
const PARTIAL_EXTENSIONS = new Set([".crdownload", ".part", ".download", ".partial"]);

export interface ScannedFile {
  name: string;
  path: string;
  ext: string;
  size: number;
  modifiedAt: Date;
  ageDays: number;
  sha256: string;
  partial: boolean;
  duplicateOf?: string;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Lists the top-level files of a folder with the metadata the planner needs. */
export async function scanFolder(dir: string, now = new Date()): Promise<ScannedFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: ScannedFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    const info = await stat(path);
    const ext = extname(entry.name).toLowerCase();
    files.push({
      name: entry.name,
      path,
      ext,
      size: info.size,
      modifiedAt: info.mtime,
      ageDays: Math.floor((now.getTime() - info.mtime.getTime()) / 86_400_000),
      sha256: await hashFile(path),
      partial: PARTIAL_EXTENSIONS.has(ext),
    });
  }

  // The oldest copy of identical content is the original; later ones are duplicates.
  files.sort((a, b) => a.modifiedAt.getTime() - b.modifiedAt.getTime() || a.name.localeCompare(b.name));
  const firstByHash = new Map<string, string>();
  for (const file of files) {
    if (file.partial || file.size === 0) continue;
    const original = firstByHash.get(file.sha256);
    if (original) file.duplicateOf = original;
    else firstByHash.set(file.sha256, file.name);
  }

  return files.sort((a, b) => a.name.localeCompare(b.name));
}
