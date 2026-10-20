import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildPlist, buildZeePlist, LABEL, type AutostartPaths } from "../src/autostart.js";

const paths: AutostartPaths = {
  plist: "/Users/someone/Library/LaunchAgents/dev.dropzone-zero.watch.plist",
  zeePlist: "/Users/someone/Library/LaunchAgents/dev.dropzone-zero.zee.plist",
  zeeApp: "/Users/someone/Projects/dropzone-zero/app/src-tauri/target/release/bundle/macos/Zee.app",
  log: "/Users/someone/Library/Logs/dropzone-zero/watch.log",
  repo: "/Users/someone/Projects/dropzone-zero",
  node: "/opt/homebrew/bin/node",
};

describe("LaunchAgent plist", () => {
  const plist = buildPlist("/Users/someone/Down & Out <loads>", paths);

  it("starts dz daemon from the repo at login and keeps it alive", () => {
    assert.match(plist, new RegExp(`<string>${LABEL}</string>`));
    assert.match(plist, /<string>\/Users\/someone\/Projects\/dropzone-zero\/src\/cli\.ts<\/string>\s*<string>daemon<\/string>/);
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/someone\/Projects\/dropzone-zero<\/string>/);
  });

  it("escapes paths for XML", () => {
    assert.match(plist, /<string>\/Users\/someone\/Down &amp; Out &lt;loads&gt;<\/string>/);
  });

  it("is a valid property list", { skip: process.platform !== "darwin" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "dz-plist-"));
    for (const [name, content] of [["agent.plist", plist], ["zee.plist", buildZeePlist(paths)]] as const) {
      await writeFile(join(dir, name), content);
      assert.match(execFileSync("plutil", ["-lint", join(dir, name)], { encoding: "utf8" }), /OK/);
    }
  });

  it("opens Zee once at login without keeping it alive", () => {
    const zee = buildZeePlist(paths);
    assert.match(zee, /<string>\/usr\/bin\/open<\/string>\s*<string>-a<\/string>\s*<string>[^<]*Zee\.app<\/string>/);
    assert.doesNotMatch(zee, /KeepAlive/);
  });
});
