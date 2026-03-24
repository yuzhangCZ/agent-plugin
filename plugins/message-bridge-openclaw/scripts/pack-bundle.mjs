#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const rootDir = process.cwd();
const bundleDir = join(rootDir, "bundle");
const packDir = join(rootDir, ".tmp", "release-pack");

async function main() {
  await rm(packDir, { recursive: true, force: true });
  await mkdir(packDir, { recursive: true });

  execFileSync("npm", ["pack", "--pack-destination", packDir], {
    cwd: bundleDir,
    stdio: "inherit",
  });
}

main().catch((error) => {
  console.error("[pack-bundle] failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
