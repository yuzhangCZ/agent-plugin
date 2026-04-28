import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/install-openclaw-plugin.mjs");

test("install-openclaw-plugin wrapper rejects high-risk deprecated args", () => {
  const devResult = spawnSync(process.execPath, [scriptPath, "--dev"], { encoding: "utf8" });
  assert.equal(devResult.status, 1);
  assert.match(devResult.stderr, /--dev 已废弃/);

  const restartResult = spawnSync(process.execPath, [scriptPath, "--no-restart"], { encoding: "utf8" });
  assert.equal(restartResult.status, 1);
  assert.match(restartResult.stderr, /--no-restart 已废弃/);
});
