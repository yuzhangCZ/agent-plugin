#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: "pipe",
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function main() {
  const tracked = runGit(["ls-files", "--error-unmatch", "--", "dist"]);
  assert.notEqual(
    tracked.status,
    0,
    `dist tracking check failed: dist/ is tracked by git.\n${tracked.stdout || tracked.stderr || "git ls-files matched dist/"}`,
  );

  const status = runGit(["status", "--short", "--", "dist"]);
  assert.equal(status.status, 0, status.stderr || "git status failed");
  assert.equal(status.stdout, "", `dist tracking check failed: expected dist/ to stay clean and ignored, got:\n${status.stdout}`);

  console.log("Dist tracking check passed: dist/ is untracked and remains ignored by git.");
}

main();
