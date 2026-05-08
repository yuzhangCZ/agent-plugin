#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const probe = spawnSync(process.execPath, ["./dist/cli.js", "--help"], {
  cwd: process.cwd(),
  encoding: "utf8",
  stdio: "pipe",
});

assert.equal(probe.status, 0, probe.stderr || probe.stdout);
assert.match(`${probe.stdout}${probe.stderr}`, /skill-plugin-cli|\u7528\u6CD5/u);
