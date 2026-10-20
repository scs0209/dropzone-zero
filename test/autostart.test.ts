import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildPlist, LABEL, type AutostartPaths } from "../src/autostart.js";

const paths: AutostartPaths = {
  plist: "/Users/someone/Library/LaunchAgents/dev.dropzone-zero.watch.plist",
  log: "/Users/someone/Library/Logs/dropzone-zero/watch.log",
  repo: "/Users/someone/Projects/dropzone-zero",
  node: "/opt/homebrew/bin/node",
};

describe("LaunchAgent plist", () => {
  const plist = buildPlist("/Users/someone/Down & Out <loads>", paths);

  it("starts dz watch --auto from the repo at login and keeps it alive", () => {
    assert.match(plist, new RegExp(`<string>${LABEL}</string>`));
    assert.match(plist, /<string>\/Users\/someone\/Projects\/dropzone-zero\/src\/cli\.ts<\/string>\s*<string>watch<\/string>/);
    assert.match(plist, /<string>--auto<\/string>/);
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/someone\/Projects\/dropzone-zero<\/string>/);
  });

  it("escapes paths for XML", () => {
    assert.match(plist, /<string>\/Users\/someone\/Down &amp; Out &lt;loads&gt;<\/string>/);
  });

  it("is a valid property list", { skip: process.platform !== "darwin" }, async () => {
    const file = join(await mkdtemp(join(tmpdir(), "dz-plist-")), "agent.plist");
    await writeFile(file, plist);
    assert.match(execFileSync("plutil", ["-lint", file], { encoding: "utf8" }), /OK/);
  });
});
