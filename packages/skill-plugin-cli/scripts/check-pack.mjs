#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { listTarEntries } from "../../../scripts/tar-utils.mjs";

const PACK_DIR = path.join(process.cwd(), ".tmp", "pack-check");

async function main() {
  const files = await readdir(PACK_DIR);
  const tgzName = files.find((name) => name.endsWith(".tgz"));
  assert.ok(tgzName, "pack check failed: no .tgz generated");

  const entries = listTarEntries(path.join(PACK_DIR, tgzName));
  const declarationEntries = entries.filter((entry) => entry.startsWith("package/dist/") && entry.endsWith(".d.ts"));

  assert.ok(entries.includes("package/package.json"));
  assert.ok(entries.includes("package/dist/index.js"));
  assert.ok(entries.includes("package/dist/cli.js"));
  assert.ok(entries.includes("package/dist/index.d.ts"));
  assert.ok(!entries.some((entry) => entry.endsWith(".map")));
  assert.ok(declarationEntries.length > 0);

  for (const entry of declarationEntries) {
    const declarationContent = execFileSync("tar", ["-xOzf", path.join(PACK_DIR, tgzName), entry], {
      encoding: "utf8",
    });
    assert.ok(!/["'][^"']+\.ts["']/u.test(declarationContent), `pack check failed: ${entry} must not reference .ts files`);
  }
}

main().catch((error) => {
  console.error("[check-pack] failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
