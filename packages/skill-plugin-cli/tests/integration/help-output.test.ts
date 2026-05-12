import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const mainEntry = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

test("cli --help does not append an extra trailing blank line", () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", mainEntry, "--help"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.endsWith("\n\n"), false);
});
