#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { listTarEntries } from "../../../scripts/tar-utils.mjs";

const PACK_DIR = path.join(process.cwd(), ".tmp", "pack-check");

async function main() {
  const files = await readdir(PACK_DIR);
  const tgzName = files.find((name) => name.endsWith(".tgz"));
  assert.ok(tgzName, "pack check failed: no .tgz generated");

  const tgzPath = path.join(PACK_DIR, tgzName);
  const entries = listTarEntries(tgzPath);
  const declarationEntries = entries.filter((entry) => entry.endsWith(".d.ts"));

  assert.ok(entries.includes("package/package.json"));
  assert.ok(entries.includes("package/README.md"));
  assert.ok(entries.includes("package/dist/cli.js"));
  assert.ok(!entries.includes("package/dist/index.js"));
  assert.ok(!entries.some((entry) => entry.endsWith(".map")));
  assert.equal(declarationEntries.length, 0, "pack check failed: tarball must not include declaration files");

  const importProbeRoot = await mkdtemp(path.join(tmpdir(), "skill-plugin-cli-pack-check-"));
  try {
    const nodeModulesDir = path.join(importProbeRoot, "node_modules");
    const packageDir = path.join(nodeModulesDir, "@wecode", "skill-plugin-cli");
    await mkdir(packageDir, { recursive: true });
    execFileSync("tar", ["-xzf", tgzPath, "-C", packageDir, "--strip-components=1"], { stdio: "pipe" });
    await writeFile(path.join(importProbeRoot, "package.json"), JSON.stringify({ type: "module" }), "utf8");

    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "try { await import('@wecode/skill-plugin-cli'); process.exitCode = 10; } catch (error) { process.stdout.write(error instanceof Error ? error.message : String(error)); }",
      ],
      {
        cwd: importProbeRoot,
        encoding: "utf8",
        stdio: "pipe",
      },
    );
    assert.notEqual(probe.status, 10, "pack check failed: package root import unexpectedly succeeded");
    assert.match(
      `${probe.stdout}${probe.stderr}`,
      /Cannot find package|No "exports" main defined|Cannot find module|ERR_MODULE_NOT_FOUND|Package subpath/u,
    );
  } finally {
    await rm(importProbeRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[check-pack] failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
