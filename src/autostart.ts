import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// `dz autostart`: starts `dz watch --auto` at login through a macOS LaunchAgent,
// the standard per-user mechanism (a plist in ~/Library/LaunchAgents, loaded by
// launchctl). Disabling unloads it and deletes the plist; nothing else changes.

const run = promisify(execFile);

export const LABEL = "dev.dropzone-zero.watch";

export interface AutostartPaths {
  plist: string;
  log: string;
  repo: string;
  node: string;
}

export function autostartPaths(): AutostartPaths {
  // Homebrew's versioned Cellar path breaks on the next `brew upgrade node`; its stable link does not.
  const node =
    process.execPath.startsWith("/opt/homebrew/Cellar/node/") && existsSync("/opt/homebrew/bin/node")
      ? "/opt/homebrew/bin/node"
      : process.execPath;
  return {
    plist: join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`),
    log: join(homedir(), "Library", "Logs", "dropzone-zero", "watch.log"),
    repo: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    node,
  };
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The LaunchAgent definition. Pure, so it can be tested without touching the system. */
export function buildPlist(folder: string, paths: AutostartPaths): string {
  const args = [paths.node, "--import", "tsx", join(paths.repo, "src", "cli.ts"), "watch", folder, "--auto"];
  // launchd starts with a bare PATH; uv (review gate) and osascript (notifications) must be findable.
  const path = [dirname(paths.node), join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(paths.repo)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(paths.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(paths.log)}</string>
</dict>
</plist>
`;
}

function assertMac(): void {
  if (process.platform !== "darwin") throw new Error("dz autostart uses macOS LaunchAgents and works on macOS only.");
}

const domain = () => `gui/${process.getuid?.() ?? 0}`;

export async function enableAutostart(folder: string): Promise<AutostartPaths> {
  assertMac();
  const paths = autostartPaths();
  await mkdir(dirname(paths.plist), { recursive: true });
  await mkdir(dirname(paths.log), { recursive: true });
  await writeFile(paths.plist, buildPlist(folder, paths));
  // Replace a previous registration, if any, so the new settings take effect now.
  await run("launchctl", ["bootout", `${domain()}/${LABEL}`]).catch(() => {});
  await run("launchctl", ["bootstrap", domain(), paths.plist]);
  return paths;
}

export async function disableAutostart(): Promise<boolean> {
  assertMac();
  const paths = autostartPaths();
  const existed = existsSync(paths.plist);
  await run("launchctl", ["bootout", `${domain()}/${LABEL}`]).catch(() => {});
  await rm(paths.plist, { force: true });
  return existed;
}

export interface AutostartStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
  log: string;
}

export async function autostartStatus(): Promise<AutostartStatus> {
  assertMac();
  const paths = autostartPaths();
  const installed = existsSync(paths.plist);
  try {
    const { stdout } = await run("launchctl", ["print", `${domain()}/${LABEL}`]);
    const pid = /\bpid = (\d+)/.exec(stdout)?.[1];
    return { installed, running: /\bstate = running\b/.test(stdout), ...(pid ? { pid: Number(pid) } : {}), log: paths.log };
  } catch {
    return { installed, running: false, log: paths.log };
  }
}
