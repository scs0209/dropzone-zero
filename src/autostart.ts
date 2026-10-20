import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// `dz autostart`: starts Dropzone Zero at login through a macOS LaunchAgent, the
// standard per-user mechanism (a plist in ~/Library/LaunchAgents, loaded by
// launchctl). With Zee built, Zee is the only login item and starts Ollama and
// the daemon itself; without it, the daemon is started directly. Disabling
// unloads whatever is registered and deletes the plists; nothing else changes.

const run = promisify(execFile);

export const LABEL = "dev.dropzone-zero.watch";
export const ZEE_LABEL = "dev.dropzone-zero.zee";

export interface AutostartPaths {
  plist: string;
  zeePlist: string;
  log: string;
  repo: string;
  node: string;
  /** The built desktop app, if `pnpm app:build` has run. */
  zeeApp: string;
}

export function autostartPaths(): AutostartPaths {
  // Homebrew's versioned Cellar path breaks on the next `brew upgrade node`; its stable link does not.
  const node =
    process.execPath.startsWith("/opt/homebrew/Cellar/node/") && existsSync("/opt/homebrew/bin/node")
      ? "/opt/homebrew/bin/node"
      : process.execPath;
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return {
    plist: join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`),
    zeePlist: join(homedir(), "Library", "LaunchAgents", `${ZEE_LABEL}.plist`),
    log: join(homedir(), "Library", "Logs", "dropzone-zero", "watch.log"),
    repo,
    node,
    zeeApp: join(repo, "app", "src-tauri", "target", "release", "bundle", "macos", "Zee.app"),
  };
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The LaunchAgent definition. Pure, so it can be tested without touching the system. */
export function buildPlist(folder: string, paths: AutostartPaths): string {
  const args = [paths.node, "--import", "tsx", join(paths.repo, "src", "cli.ts"), "daemon", folder];
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

/** Opens Zee once at login. Not kept alive: closing Zee is the person's choice; the daemon keeps working. */
export function buildZeePlist(paths: AutostartPaths): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${ZEE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-a</string>
    <string>${xml(paths.zeeApp)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

function assertMac(): void {
  if (process.platform !== "darwin") throw new Error("dz autostart uses macOS LaunchAgents and works on macOS only.");
}

const domain = () => `gui/${process.getuid?.() ?? 0}`;

/**
 * Unloads a LaunchAgent and waits until launchd has let go of it; bootstrapping
 * again too early fails with "Bootstrap failed: 5: Input/output error".
 */
async function unload(label: string): Promise<void> {
  await run("launchctl", ["bootout", `${domain()}/${label}`]).catch(() => {});
  for (let i = 0; i < 50; i++) {
    const loaded = await run("launchctl", ["print", `${domain()}/${label}`]).then(() => true, () => false);
    if (!loaded) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

export interface EnableResult extends AutostartPaths {
  /** "zee": Zee.app is the login item and runs the rest. "daemon": the daemon is the login item. */
  mode: "zee" | "daemon";
}

export async function enableAutostart(folder: string): Promise<EnableResult> {
  assertMac();
  const paths = autostartPaths();
  await mkdir(dirname(paths.plist), { recursive: true });
  await mkdir(dirname(paths.log), { recursive: true });
  // Zee watches ~/Downloads; another folder keeps the daemon as the login item.
  const zee = existsSync(paths.zeeApp) && resolve(folder) === join(homedir(), "Downloads");
  if (zee) {
    // One login item: Zee. A separately registered daemon would only race it for the lock.
    await unload(LABEL);
    await rm(paths.plist, { force: true });
    await writeFile(paths.zeePlist, buildZeePlist(paths));
    await unload(ZEE_LABEL);
    await run("launchctl", ["bootstrap", domain(), paths.zeePlist]);
    return { ...paths, mode: "zee" };
  }
  await writeFile(paths.plist, buildPlist(folder, paths));
  // Replace a previous registration, if any, so the new settings take effect now.
  await unload(LABEL);
  await run("launchctl", ["bootstrap", domain(), paths.plist]);
  return { ...paths, mode: "daemon" };
}

export async function disableAutostart(): Promise<boolean> {
  assertMac();
  const paths = autostartPaths();
  const existed = existsSync(paths.plist);
  await unload(LABEL);
  await unload(ZEE_LABEL);
  await rm(paths.plist, { force: true });
  await rm(paths.zeePlist, { force: true });
  return existed;
}

export interface AutostartStatus {
  mode: "zee" | "daemon" | null;
  /** The daemon's process, wherever it was started from. */
  daemonPid?: number;
  log: string;
}

export async function autostartStatus(): Promise<AutostartStatus> {
  assertMac();
  const paths = autostartPaths();
  const mode = existsSync(paths.zeePlist) ? "zee" : existsSync(paths.plist) ? "daemon" : null;
  try {
    const info = JSON.parse(await readFile(join(homedir(), ".dropzone-zero", "daemon.json"), "utf8")) as { pid: number };
    process.kill(info.pid, 0);
    return { mode, daemonPid: info.pid, log: paths.log };
  } catch {
    return { mode, log: paths.log };
  }
}
