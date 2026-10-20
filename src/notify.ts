import { execFile } from "node:child_process";

// Desktop notifications for `dz watch`, so a decision does not sit unseen in a
// terminal. macOS only for now (osascript ships with the OS); elsewhere, and with
// DZ_NOTIFY=off, this does nothing. Notifications are shown locally; nothing is sent anywhere.

export function notificationsEnabled(): boolean {
  return process.platform === "darwin" && process.env.DZ_NOTIFY !== "off";
}

/** AppleScript string literal: quotes and backslashes escaped, line breaks flattened. */
export function appleScriptString(text: string): string {
  return `"${text.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\r\n]+/g, " ")}"`;
}

export function notify(title: string, message: string): void {
  if (!notificationsEnabled()) return;
  const script = `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`;
  // Fire and forget: a missing notification must never stop the watcher.
  execFile("osascript", ["-e", script], () => {});
}
